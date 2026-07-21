// League 2 (Forecasting) run driver + CLI.
//
//   npx tsx src/forecast/run.ts pose --id forecast-20260721   # generate + predict
//   npx tsx src/forecast/run.ts resolve                       # settle matured Qs
//   npx tsx src/forecast/run.ts report                        # open view + board
//
// Persists to results/forecast-<id>.json atomically (tmp+rename, mirroring
// verified/run.ts). `pose` is resumable by (question id, model): finished
// predictions are skipped on rerun. Roster = FLAGSHIP.competitors (import only);
// under FORECAST_SIM=1 a small canned roster keeps sim runs fast and offline.

import { writeFileSync, readFileSync, readdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { FLAGSHIP } from "../config.js";
import { resultsDir } from "../paths.js";
import { generateQuestions, type ForecastFile, type Question } from "./feeds.js";
import { collectPredictions } from "./predict.js";
import { resolveMatured } from "./resolve.js";
import { forecastSummary, type ForecastSummary } from "./score.js";

// Canned roster for FORECAST_SIM so offline runs stay tiny + deterministic.
const SIM_ROSTER = ["sim/alpha", "sim/beta", "sim/gamma"];

export function forecastRoster(): string[] {
  return process.env.FORECAST_SIM === "1" ? SIM_ROSTER : FLAGSHIP.competitors;
}

function filePath(id: string): string {
  return join(resultsDir(), `forecast-${id}.json`);
}

function writeJson(path: string, data: object): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

function loadFile(id: string): ForecastFile | null {
  const p = filePath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as ForecastFile;
}

// Every forecast-*.json in the results dir (for resolve/report across sets).
export function loadAllForecasts(): ForecastFile[] {
  const dir = resultsDir();
  if (!existsSync(dir)) return [];
  const files: ForecastFile[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.startsWith("forecast-") || !f.endsWith(".json") || f.endsWith(".tmp")) continue;
    try {
      files.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as ForecastFile);
    } catch {
      /* skip unreadable */
    }
  }
  return files;
}

export interface PoseOptions {
  id: string;
  seed?: number;
  nowMs?: number;
  roster?: string[];
  onOne?: (q: Question, model: string, p: number) => void;
}

// Generate the question set (deterministic given seed + feed snapshot) and
// collect predictions. Existing questions are preserved by id so a real-feed
// resume never rewrites a question after the spot has drifted.
export async function pose(opts: PoseOptions): Promise<ForecastFile> {
  const id = opts.id;
  const seed = opts.seed ?? hashId(id);
  const nowMs = opts.nowMs ?? Date.now();
  const roster = opts.roster ?? forecastRoster();

  const candidates = await generateQuestions(seed, nowMs);
  const existing = loadFile(id);
  const byId = new Map<string, Question>();
  if (existing) for (const q of existing.questions) byId.set(q.id, q);
  // Merge: keep stored questions (+ their predictions/resolution); add new ones.
  for (const c of candidates) if (!byId.has(c.id)) byId.set(c.id, c);

  const file: ForecastFile = {
    id,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    roster,
    questions: candidates.map((c) => byId.get(c.id)!),
  };
  const save = () => {
    file.updatedAt = new Date().toISOString();
    writeJson(filePath(id), file);
  };
  save(); // persist the questions before any (possibly slow) prediction call
  await collectPredictions(file, roster, save, opts.onOne);
  save();
  return file;
}

// Settle matured questions across ALL forecast-*.json files; persist only changed.
export async function resolveAll(nowMs = Date.now()): Promise<{ changed: number }> {
  const dir = resultsDir();
  let changed = 0;
  if (!existsSync(dir)) return { changed };
  for (const f of readdirSync(dir)) {
    if (!f.startsWith("forecast-") || !f.endsWith(".json") || f.endsWith(".tmp")) continue;
    let file: ForecastFile;
    try {
      file = JSON.parse(readFileSync(join(dir, f), "utf8")) as ForecastFile;
    } catch {
      continue;
    }
    const didChange = await resolveMatured(file, nowMs);
    if (didChange) {
      file.updatedAt = new Date().toISOString();
      writeJson(join(dir, f), file);
      changed++;
    }
  }
  return { changed };
}

function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// --- report formatting ---

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return "due";
  const h = ms / 3_600e3;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export function formatReport(summary: ForecastSummary): string {
  const out: string[] = [];
  out.push("");
  out.push("League 2 - Forecasting");
  out.push(
    `open: ${summary.counts.openQuestions} questions | resolved: ${summary.counts.resolvedQuestions} | models: ${summary.counts.models}`,
  );

  out.push("");
  out.push("OPEN QUESTIONS (soonest first) - watch models disagree before reality resolves");
  out.push("--------------------------------------------------------------------------------");
  if (summary.open.length === 0) {
    out.push("  (none open)");
  }
  for (const q of summary.open.slice(0, 12)) {
    out.push(
      `  [${q.horizon.padEnd(3)} ${fmtDuration(q.msToResolve).padStart(6)}] ${q.asset} close_above ${q.threshold}` +
        `  consensus ${fmtPct(q.consensus)}  spread ${(q.disagreement * 100).toFixed(0)}pp  (n=${q.count})`,
    );
  }

  out.push("");
  out.push("BRIER LEADERBOARD (resolved questions; horizon signal-weighted)");
  out.push("---------------------------------------------------------------");
  out.push("  note: short-horizon liquid-price Qs ~ random walk -> down-weighted (6h=0.25 .. 30d=1.5)");
  if (summary.leaderboard.every((r) => r.n === 0)) {
    out.push("  (board empty until questions mature)");
  } else {
    out.push(`  ${"rating".padStart(6)}  ${"wBrier".padStart(7)}  ${"brier".padStart(6)}  ${"n".padStart(3)}  model`);
    for (const r of summary.leaderboard) {
      if (r.n === 0) continue;
      out.push(
        `  ${String(r.rating).padStart(6)}  ${r.weightedBrier.toFixed(4).padStart(7)}  ${r.brier
          .toFixed(4)
          .padStart(6)}  ${String(r.n).padStart(3)}  ${r.model}`,
      );
    }
  }
  return out.join("\n");
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const getFlag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  if (cmd === "pose") {
    const id = (getFlag("--id") ?? `forecast-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`).replace(
      /^forecast-/,
      "",
    );
    console.log(`Posing forecast set ${id} (roster=${forecastRoster().length} models)`);
    const file = await pose({
      id,
      onOne: (q, model, p) => console.log(`  ${q.id}  ${model} -> P(yes)=${p.toFixed(3)}`),
    });
    console.log(`Posed ${file.questions.length} questions, ${Object.keys(file.questions[0]?.predictions ?? {}).length} predictions each.`);
  } else if (cmd === "resolve") {
    const { changed } = await resolveAll();
    console.log(`resolve: ${changed} file(s) updated`);
    console.log(formatReport(forecastSummary(loadAllForecasts(), Date.now())));
  } else if (cmd === "report") {
    console.log(formatReport(forecastSummary(loadAllForecasts(), Date.now())));
  } else {
    console.error("usage: run.ts <pose --id forecast-<date> | resolve | report>");
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
