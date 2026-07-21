import { chat } from "./openrouter.js";
import type { BankTopic, Config } from "./types.js";

const PROPOSE = (n: number) => `You are helping set up a formal debate tournament between AI models.
Propose ${n} debate motions. Requirements for each motion:
- A single declarative sentence that a debater can argue FOR or AGAINST.
- Genuinely contested: strong, substantive arguments must exist on BOTH sides. No factual yes/no questions, nothing with an obviously correct side.
- Concrete and interesting; span different domains (technology, society, economics, ethics, culture, science).
Respond with ONLY a JSON array of ${n} strings.`;

function normalize(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

export async function generateTopicBank(
  cfg: Config,
  log: (s: string) => void,
): Promise<{ bank: BankTopic[]; cost: number }> {
  let cost = 0;
  const perModel = cfg.topicsPerCompetitor;
  log(`Generating topic bank: ${cfg.competitors.length} models x ${perModel} motions`);

  const proposals = await Promise.all(
    cfg.competitors.map(async (model): Promise<BankTopic[]> => {
      try {
        const res = await chat(model, [{ role: "user", content: PROPOSE(perModel) }], 1200, { json: false });
        cost += res.costUsd;
        const m = res.text.match(/\[[\s\S]*\]/);
        if (!m) throw new Error("no JSON array");
        const arr: unknown = JSON.parse(m[0]);
        if (!Array.isArray(arr)) throw new Error("not an array");
        return arr
          .filter((t): t is string => typeof t === "string" && t.trim().length > 15)
          .slice(0, perModel)
          .map((topic) => ({ topic: topic.trim(), proposer: model }));
      } catch (err) {
        log(`  topic proposal failed for ${model}: ${(err as Error).message.slice(0, 120)}`);
        return [];
      }
    }),
  );

  // Dedupe near-identical motions (normalized exact match).
  const seen = new Set<string>();
  const pooled: BankTopic[] = [];
  for (const t of proposals.flat()) {
    const key = normalize(t.topic);
    if (seen.has(key)) continue;
    seen.add(key);
    pooled.push(t);
  }
  log(`  pooled ${pooled.length} unique motions`);

  // Neutral curation: a judge-pool model drops unbalanced or near-duplicate motions.
  try {
    // Rotate the curator with the season seed so no single model permanently
    // gatekeeps the motion pool.
    const curator = cfg.judgePool[cfg.seed % cfg.judgePool.length];
    const listing = pooled.map((t, i) => `${i}: ${t.topic}`).join("\n");
    const res = await chat(
      curator,
      [
        {
          role: "user",
          content: `You curate motions for a debate tournament. Below is a numbered list of proposed motions.
Remove any that are: not genuinely contested (one side is clearly correct), too vague to debate, or near-duplicates of an earlier motion in the list (keep the earlier one).
${listing}

Respond with ONLY a JSON object: {"keep": [<indices of motions to keep>]}`,
        },
      ],
      1000,
      { json: true },
    );
    cost += res.costUsd;
    const m = res.text.match(/\{[\s\S]*\}/);
    const keep: number[] = m ? JSON.parse(m[0]).keep : [];
    if (Array.isArray(keep) && keep.length >= Math.min(8, pooled.length)) {
      const kept = keep.filter((i) => i >= 0 && i < pooled.length).map((i) => pooled[i]);
      log(`  curator (${curator}) kept ${kept.length}/${pooled.length}`);
      return { bank: kept, cost };
    }
    log(`  curator response unusable, keeping all`);
  } catch (err) {
    log(`  curation failed (${(err as Error).message.slice(0, 120)}), keeping all`);
  }
  return { bank: pooled, cost };
}
