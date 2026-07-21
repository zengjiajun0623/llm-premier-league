// Track A — Agentic Forecasting run driver + CLI.
//
//   npx tsx src/agentic/run.ts pose --id agentic-20260721   # crawl + agentic predict
//   npx tsx src/agentic/run.ts resolve                       # settle matured Qs
//   npx tsx src/agentic/run.ts report                        # agentic board + uplift
//
// Mirrors src/forecast/run.ts (the CLOSED-BOOK arm) so the two are directly
// comparable: SAME templated questions (same seed derived from the bare id), so
// question ids line up and uplift = closedBrier - agenticBrier is well defined.
//
// Per question we build ONE frozen evidence pool (identical for every model),
// drop it if under-covered, then run each model inside the pi agent harness
// (pi-ext/agentic-tools.ts) over that frozen pool. The model's trailing
// probability is parsed, clamped, and stored in the ForecastFile shape so
// src/forecast/score.ts scores it unchanged. Full per-(question,model) tool
// transcripts are written to results/transcripts/ and referenced from the file.
//
// Resumable by (question, model). SIM (AGENTIC_SIM=1): skip pi entirely — a
// deterministic fake probability + a canned 2-step transcript, fully offline.

import { writeFileSync, readFileSync, readdirSync, existsSync, renameSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { FLAGSHIP } from "../config.js";
import { resultsDir, ROOT } from "../paths.js";
import { generateQuestions, type Question } from "../forecast/feeds.js";
import { resolveMatured } from "../forecast/resolve.js";
import { buildEvidencePool, type EvidencePool } from "./crawl.js";
import { agenticSummary, formatAgenticReport } from "./score.js";

const SIM_ROSTER = ["sim/alpha", "sim/beta", "sim/gamma"];
const CLAMP_LO = 0.01;
const CLAMP_HI = 0.99;
const PI_TIMEOUT_MS = 240_000;

export interface AgenticQuestion extends Question {
  underCovered?: boolean;
  evidenceFile?: string;
  evidenceBuiltAt?: string;
  docCount?: number;
  transcripts?: Record<string, string>; // model -> transcript path
}

export interface AgenticFile {
  id: string;
  createdAt: string;
  updatedAt: string;
  arm: "agentic";
  roster: string[];
  questions: AgenticQuestion[];
}

export function agenticRoster(): string[] {
  return isSim() ? SIM_ROSTER : FLAGSHIP.competitors;
}

function isSim(): boolean {
  return process.env.AGENTIC_SIM === "1";
}

function bareId(id: string): string {
  return id.replace(/^agentic-/, "");
}

function filePath(id: string): string {
  return join(resultsDir(), `agentic-${bareId(id)}.json`);
}

function transcriptDir(id: string): string {
  return join(resultsDir(), "transcripts", `agentic-${bareId(id)}`);
}

function transcriptPath(id: string, qid: string, model: string): string {
  return join(transcriptDir(id), `${qid}__${model.replace(/[^a-zA-Z0-9._-]/g, "_")}.jsonl`);
}

function writeJson(path: string, data: object): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export function loadAgenticFile(id: string): AgenticFile | null {
  const p = filePath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as AgenticFile;
  } catch {
    return null;
  }
}

export function loadAllAgentic(): AgenticFile[] {
  const dir = resultsDir();
  if (!existsSync(dir)) return [];
  const out: AgenticFile[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.startsWith("agentic-") || !f.endsWith(".json") || f.endsWith(".tmp")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as AgenticFile);
    } catch {
      /* skip */
    }
  }
  return out;
}

function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function clampP(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.max(CLAMP_LO, Math.min(CLAMP_HI, p));
}

// Parse the model's final probability: prefer a [0,1] number on the last
// non-empty line, else the last number anywhere. Defaults to 0.5.
export function parseProbability(output: string): number {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const nums = lines[i].match(/-?\d*\.?\d+/g);
    if (!nums) continue;
    // last number on this line
    const v = Number(nums[nums.length - 1]);
    if (Number.isFinite(v) && v >= 0 && v <= 1) return clampP(v);
  }
  const all = output.match(/-?\d*\.?\d+/g);
  if (all) {
    const v = Number(all[all.length - 1]);
    if (Number.isFinite(v)) return clampP(v);
  }
  return 0.5;
}

function piBinary(): string {
  const sibling = join(dirname(process.execPath), "pi");
  return existsSync(sibling) ? sibling : "pi";
}

function forecastingPrompt(q: AgenticQuestion, pool: EvidencePool): string {
  const when = new Date(q.resolveAt).toISOString();
  return [
    `You are a calibrated probabilistic forecaster with research tools.`,
    ``,
    `QUESTION: Will the market price of ${q.asset} (USD) be at or ABOVE ${q.threshold} at ${when} (the deadline)?`,
    `Context: at question-creation time the price was ${q.spotAtCreate}.`,
    ``,
    `You have a FROZEN evidence pool of ${pool.docs.length} documents. Use the tools to research it:`,
    `- web_search(query): keyword-search the pool; returns matching document ids + snippets.`,
    `- web_fetch(id): read a pooled document's full text.`,
    `- run_python(src): scratch calculation.`,
    `Do several searches, read the most relevant documents, reason, then decide.`,
    ``,
    `When done, output ONLY your probability that the answer is YES as a single decimal`,
    `number between 0 and 1 on the FINAL line. Nothing after it.`,
  ].join("\n");
}

// Deterministic offline stand-in for a pi run. Writes a canned 2-step transcript
// (web_search then web_fetch over the real pool) and returns a hashed probability.
function simRun(q: AgenticQuestion, model: string, pool: EvidencePool, tPath: string): number {
  mkdirSync(dirname(tPath), { recursive: true });
  const firstDoc = pool.docs[0];
  const entries = [
    {
      ts: new Date(0).toISOString(),
      call: 1,
      tool: "web_search",
      args: { query: `${q.asset} price forecast` },
      ok: true,
      result: `Top match: id=${firstDoc?.id ?? "d1"} (sim)`,
    },
    {
      ts: new Date(0).toISOString(),
      call: 2,
      tool: "web_fetch",
      args: { id: firstDoc?.id ?? "d1" },
      ok: true,
      result: (firstDoc?.text ?? "sim evidence").slice(0, 120),
    },
  ];
  // overwrite (resumable-identical): truncate then write both lines
  writeFileSync(tPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const h = hashId(`${model}||${q.id}||${q.threshold}`);
  return clampP((h % 9801) / 9800);
}

// Run one (model, question) inside the pi harness over its frozen pool. Returns
// the parsed probability, or null on hard failure (caller skips, resumes later).
function piRun(q: AgenticQuestion, model: string, pool: EvidencePool, evidenceFile: string, tPath: string): number | null {
  mkdirSync(dirname(tPath), { recursive: true });
  // Fresh transcript for this attempt.
  writeFileSync(tPath, "");
  const budget = process.env.AGENTIC_BUDGET ?? "12";
  const extPath = join(ROOT, "pi-ext", "agentic-tools.ts");
  const args = [
    "-p",
    "-ne",
    "--no-session",
    "--no-builtin-tools",
    "--provider",
    "openrouter",
    "--model",
    model,
    "-e",
    extPath,
    forecastingPrompt(q, pool),
  ];
  const res = spawnSync(piBinary(), args, {
    encoding: "utf8",
    timeout: PI_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      EVIDENCE_FILE: evidenceFile,
      TRANSCRIPT_FILE: tPath,
      AGENTIC_BUDGET: budget,
    },
  });
  if (res.error) {
    console.error(`  !! ${q.id} ${model} pi error: ${res.error.message.slice(0, 160)}`);
    return null;
  }
  const out = (res.stdout ?? "").trim();
  if (!out) {
    console.error(`  !! ${q.id} ${model} empty pi output (stderr: ${(res.stderr ?? "").slice(0, 160)})`);
    return null;
  }
  // Record the final answer line into the transcript too.
  const p = parseProbability(out);
  try {
    appendFileSync(tPath, JSON.stringify({ ts: new Date().toISOString(), call: -1, tool: "final_answer", args: {}, ok: true, result: String(p) }) + "\n");
  } catch {
    /* best-effort */
  }
  return p;
}

export interface PoseOptions {
  id: string;
  seed?: number;
  nowMs?: number;
  roster?: string[];
  onOne?: (q: AgenticQuestion, model: string, p: number) => void;
}

// Generate the SAME templated questions as the closed arm, crawl a frozen pool
// per question (dropping under-covered ones from the rated set), then run each
// model in the harness. Resumable by (question, model).
export async function pose(opts: PoseOptions): Promise<AgenticFile> {
  const id = bareId(opts.id);
  const seed = opts.seed ?? hashId(id);
  const nowMs = opts.nowMs ?? Date.now();
  const roster = opts.roster ?? agenticRoster();

  const candidates = (await generateQuestions(seed, nowMs)) as AgenticQuestion[];
  const existing = loadAgenticFile(id);
  const byId = new Map<string, AgenticQuestion>();
  if (existing) for (const q of existing.questions) byId.set(q.id, q);
  for (const c of candidates) if (!byId.has(c.id)) byId.set(c.id, c);

  const file: AgenticFile = {
    id,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    arm: "agentic",
    roster,
    questions: candidates.map((c) => byId.get(c.id)!),
  };

  const save = () => {
    file.updatedAt = new Date().toISOString();
    writeJson(filePath(id), file);
  };
  save();

  for (const q of file.questions) {
    if (q.resolved) continue;

    // Build (or load) the frozen evidence pool ONCE for this question.
    const pool = await buildEvidencePool(q);
    q.evidenceFile = join(resultsDir(), `evidence-${q.id}.json`);
    q.evidenceBuiltAt = pool.builtAt;
    q.docCount = pool.docs.length;
    q.underCovered = pool.underCovered;
    if (pool.underCovered) {
      // Coverage gate: drop from the rated set (leave no predictions).
      console.error(`  ~~ ${q.id} under-covered (${pool.docs.length}/${pool.minDocs} docs) -> dropped from rated set`);
      save();
      continue;
    }
    save();

    q.transcripts ??= {};
    for (const model of roster) {
      if (typeof q.predictions[model] === "number") continue; // resume
      const tPath = transcriptPath(id, q.id, model);
      let p: number | null;
      if (isSim()) {
        p = simRun(q, model, pool, tPath);
      } else {
        p = piRun(q, model, pool, q.evidenceFile, tPath);
      }
      if (p === null) continue; // hard failure: skip, resume later
      q.predictions[model] = p;
      q.transcripts[model] = tPath;
      opts.onOne?.(q, model, p);
      save();
    }
  }
  save();
  return file;
}

// Settle matured questions across ALL agentic-*.json files (reality resolves,
// same feed comparison as the closed arm). Returns count of files changed.
export async function resolveAll(nowMs = Date.now()): Promise<{ changed: number }> {
  const dir = resultsDir();
  let changed = 0;
  if (!existsSync(dir)) return { changed };
  for (const f of readdirSync(dir)) {
    if (!f.startsWith("agentic-") || !f.endsWith(".json") || f.endsWith(".tmp")) continue;
    let file: AgenticFile;
    try {
      file = JSON.parse(readFileSync(join(dir, f), "utf8")) as AgenticFile;
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

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const getFlag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  if (cmd === "pose") {
    const id = getFlag("--id") ?? `agentic-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
    console.log(`Posing agentic set ${bareId(id)} (roster=${agenticRoster().length} models, sim=${isSim()})`);
    const file = await pose({
      id,
      onOne: (q, model, p) => console.log(`  ${q.id}  ${model} -> P(yes)=${p.toFixed(3)}`),
    });
    const rated = file.questions.filter((q) => !q.underCovered).length;
    console.log(`Posed ${file.questions.length} questions (${rated} rated, ${file.questions.length - rated} under-covered).`);
  } else if (cmd === "resolve") {
    const { changed } = await resolveAll();
    console.log(`resolve: ${changed} agentic file(s) updated`);
    console.log(formatAgenticReport(agenticSummary(Date.now())));
  } else if (cmd === "report") {
    console.log(formatAgenticReport(agenticSummary(Date.now())));
  } else {
    console.error("usage: run.ts <pose --id agentic-<date> | resolve | report>");
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
