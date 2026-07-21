// Static export for public hosting: bakes the current results into a
// self-contained directory (same UI, same data shapes as the live server).
// Usage: npx tsx src/export.ts [outDir]
process.env.API_DIVISION ??= "flagship"; // public site = one league, no dev division
import { mkdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { summary, debateList, stats, debateDetail, verifiedSummary, gapTable, forecastView, agenticView } from "./api.js";
import { ROOT } from "./paths.js";

const out = process.argv[2] ?? join(ROOT, "dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "api", "debate"), { recursive: true });

copyFileSync(join(ROOT, "public", "index.html"), join(out, "index.html"));

const list = debateList() as { slug: string }[];
writeFileSync(join(out, "api", "summary.json"), JSON.stringify(summary()));
writeFileSync(join(out, "api", "debates.json"), JSON.stringify(list));
writeFileSync(join(out, "api", "stats.json"), JSON.stringify(stats()));
// Verified board is division-independent: always included regardless of API_DIVISION.
writeFileSync(join(out, "api", "verified.json"), JSON.stringify(verifiedSummary()));
writeFileSync(join(out, "api", "gap.json"), JSON.stringify(gapTable()));
writeFileSync(join(out, "api", "forecast.json"), JSON.stringify(forecastView(Date.now())));
writeFileSync(join(out, "api", "agentic.json"), JSON.stringify(agenticView(Date.now())));
// A static snapshot has no live match; the leaderboard and archive carry the site.
writeFileSync(join(out, "api", "live.json"), JSON.stringify({ status: "idle" }));
for (const d of list) {
  writeFileSync(join(out, "api", "debate", `${d.slug}.json`), JSON.stringify(debateDetail(d.slug)));
}

writeFileSync(
  join(out, "vercel.json"),
  JSON.stringify({ framework: null, buildCommand: "", installCommand: "", outputDirectory: "." }, null, 2),
);

console.log(`exported ${list.length} debates to ${out}`);
