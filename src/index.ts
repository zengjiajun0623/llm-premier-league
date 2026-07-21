import { FLAGSHIP, CHEAP } from "./config.js";
import { runSeason, runLeague } from "./tournament.js";
import { printSeason, printRankings } from "./report.js";
import { runDebate } from "./debate.js";

const [cmd = "help", ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

async function main() {
  if (cmd === "run") {
    const cheap = rest.includes("--cheap");
    const seasons = Number(flag("seasons") ?? 1);
    const mode = (flag("mode") ?? "league") as "league" | "cup";
    const base = cheap ? CHEAP : FLAGSHIP;
    for (let i = 0; i < seasons; i++) {
      const seed = Number(flag("seed") ?? base.seed) + i;
      const id = `season-${cheap ? "cheap-" : ""}${mode}-${String(seed).padStart(3, "0")}`;
      const season = mode === "cup" ? await runSeason({ ...base, seed }, id) : await runLeague({ ...base, seed }, id);
      printSeason(season);
    }
    printRankings();
  } else if (cmd === "rankings") {
    printRankings();
  } else if (cmd === "smoke") {
    // One cheap debate end-to-end to validate the pipeline.
    const d = await runDebate(
      CHEAP,
      "Remote work should become the default for knowledge workers.",
      CHEAP.competitors[0],
      CHEAP.competitors[1],
      console.log,
    );
    console.log(JSON.stringify({ winner: d.winner, votes: [d.votesPro, d.votesCon], scores: [d.scorePro, d.scoreCon], cost: d.costUsd }, null, 2));
    console.log(d.verdicts.map((v) => `${v.judge}: ${v.winner} (${v.scoreA}-${v.scoreB}) ${v.reasoning}`).join("\n"));
  } else {
    console.log(`LLM World Cup — debate benchmark

Usage:
  npm start -- run [--mode league|cup] [--seasons N] [--seed S] [--cheap]
                                                        run season(s); league = double round-robin (default)
  npm start -- rankings                                 all-time rankings across results/
  npm start -- smoke                                    single cheap debate to test pipeline`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
