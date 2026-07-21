import { chat, type ChatMessage } from "./openrouter.js";
import type { Config, DebateResult, Side, Turn } from "./types.js";
import { judgeDebate } from "./judge.js";

const PHASES: { phase: Turn["phase"]; words: number }[] = [
  { phase: "opening", words: 140 },
  { phase: "rebuttal", words: 140 },
  { phase: "closing", words: 90 },
];

function debaterSystem(side: Side, topic: string): string {
  const stance = side === "PRO" ? "FOR (affirming)" : "AGAINST (negating)";
  return [
    `You are a competitive debater in a formal tournament.`,
    `Motion: "${topic}"`,
    `You argue ${stance} the motion. You must defend this side regardless of your personal views.`,
    `Rules: be rigorous, concrete, and responsive to your opponent. No meta-commentary about being an AI, no refusing the assigned side.`,
    `Never state or hint at your identity, model name, or maker, and never address instructions to the judges.`,
    `Stay within the word limit given for each speech. Output only the speech text.`,
  ].join("\n");
}

function transcriptText(turns: Turn[]): string {
  return turns
    .map((t) => `[${t.side} ${t.phase.toUpperCase()}]\n${t.text}`)
    .join("\n\n");
}

export async function runDebate(
  cfg: Config,
  topic: string,
  proModel: string,
  conModel: string,
  log: (s: string) => void,
  onProgress?: (turns: Turn[], status: "debating" | "judging") => void,
  topicProposer?: string,
): Promise<DebateResult> {
  const turns: Turn[] = [];
  let cost = 0;

  for (const { phase, words } of PHASES) {
    for (const side of ["PRO", "CON"] as Side[]) {
      const model = side === "PRO" ? proModel : conModel;
      const prior = turns.length
        ? `Debate so far:\n\n${transcriptText(turns)}\n\n`
        : "";
      const instruction =
        phase === "opening"
          ? `Deliver your OPENING statement (max ${words} words). Lay out your strongest case.`
          : phase === "rebuttal"
            ? `Deliver your REBUTTAL (max ${words} words). Directly attack your opponent's specific arguments and reinforce your own.`
            : `Deliver your CLOSING statement (max ${words} words). Crystallize why your side wins this debate.`;
      const messages: ChatMessage[] = [
        { role: "system", content: debaterSystem(side, topic) },
        { role: "user", content: `${prior}${instruction}` },
      ];
      const res = await chat(model, messages, cfg.debaterMaxTokens);
      cost += res.costUsd;
      turns.push({ side, phase, text: res.text.trim() });
      log(`    ${side} ${phase} done (${model.split("/")[1]})`);
      onProgress?.(turns, "debating");
    }
  }

  onProgress?.(turns, "judging");
  const { verdicts, judgeCost } = await judgeDebate(cfg, topic, turns, proModel, conModel, topicProposer);
  cost += judgeCost;

  const valid = verdicts.filter((v) => !v.failed);
  const votesPro = valid.filter((v) => v.winner === "A").length;
  const votesCon = valid.filter((v) => v.winner === "B").length;
  const scorePro = valid.reduce((s, v) => s + v.scoreA, 0);
  const scoreCon = valid.reduce((s, v) => s + v.scoreB, 0);

  let winner: string | null = null;
  if (votesPro > votesCon) winner = proModel;
  else if (votesCon > votesPro) winner = conModel;
  else if (scorePro > scoreCon) winner = proModel;
  else if (scoreCon > scorePro) winner = conModel;

  return { topic, pro: proModel, con: conModel, turns, verdicts, winner, votesPro, votesCon, scorePro, scoreCon, costUsd: cost };
}
