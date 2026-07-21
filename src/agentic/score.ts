// Track A — agentic scoring + the tool-uplift diagnostic.
//
// HEADLINE = agentic Brier, computed on the SAME proper-scoring machinery as the
// closed-book arm (src/forecast/score.ts scoreModels), so the two boards are on
// one scale. DIAGNOSTIC = uplift = Brier(closed) - Brier(agentic), paired per
// model over the questions that appear (and resolve) in BOTH arms. Uplift is a
// difference of noisy scores (design doc §"Secondary diagnostic"): reported as a
// diagnostic, never the ranking.
//
// Transcript paths are surfaced so the site can show a model's research trace.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resultsDir } from "../paths.js";
import { scoreModels, openPredictions, type ScoreRow, type OpenPrediction } from "../forecast/score.js";
import type { ForecastFile } from "../forecast/feeds.js";
import type { AgenticFile, AgenticQuestion } from "./run.js";

function loadJsonFiles<T>(prefix: string): T[] {
  const dir = resultsDir();
  if (!existsSync(dir)) return [];
  const out: T[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(prefix) || !f.endsWith(".json") || f.endsWith(".tmp")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as T);
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

export function loadAllAgenticFiles(): AgenticFile[] {
  return loadJsonFiles<AgenticFile>("agentic-");
}

export function loadAllClosedFiles(): ForecastFile[] {
  return loadJsonFiles<ForecastFile>("forecast-");
}

export interface UpliftRow {
  model: string;
  n: number; // paired resolved questions scored in both arms
  closedBrier: number; // mean Brier, closed arm, over the paired set
  agenticBrier: number; // mean Brier, agentic arm, over the paired set
  uplift: number; // closedBrier - agenticBrier (positive = tools helped)
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

// Pair agentic and closed files by id (agentic-<X> <-> forecast-<X>) and compute,
// per model, mean Brier in each arm over questions resolved in both, then uplift.
export function upliftRows(agentic: AgenticFile[], closed: ForecastFile[]): UpliftRow[] {
  const closedById = new Map(closed.map((f) => [f.id, f]));
  // per model -> paired {closed, agentic} Brier samples
  const acc = new Map<string, { closed: number[]; agentic: number[] }>();

  for (const af of agentic) {
    const cf = closedById.get(af.id);
    if (!cf) continue;
    const cQ = new Map(cf.questions.map((q) => [q.id, q]));
    for (const aq of af.questions) {
      const cq = cQ.get(aq.id);
      if (!aq.resolved || aq.outcome === undefined) continue;
      if (!cq || !cq.resolved || cq.outcome === undefined) continue;
      const o = aq.outcome;
      for (const model of Object.keys(aq.predictions)) {
        const ap = aq.predictions[model];
        const cp = cq.predictions[model];
        if (typeof ap !== "number" || typeof cp !== "number") continue;
        let e = acc.get(model);
        if (!e) acc.set(model, (e = { closed: [], agentic: [] }));
        e.agentic.push((ap - o) ** 2);
        e.closed.push((cp - o) ** 2);
      }
    }
  }

  const rows: UpliftRow[] = [];
  for (const [model, e] of acc) {
    const closedBrier = mean(e.closed);
    const agenticBrier = mean(e.agentic);
    rows.push({ model, n: e.agentic.length, closedBrier, agenticBrier, uplift: closedBrier - agenticBrier });
  }
  return rows.sort((a, b) => b.uplift - a.uplift);
}

export interface TranscriptRef {
  qid: string;
  model: string;
  path: string;
  underCovered?: boolean;
}

// Every stored research transcript, so the site can link a model's trace.
export function transcriptRefs(agentic: AgenticFile[]): TranscriptRef[] {
  const out: TranscriptRef[] = [];
  for (const af of agentic) {
    for (const q of af.questions) {
      if (!q.transcripts) continue;
      for (const [model, path] of Object.entries(q.transcripts)) {
        out.push({ qid: q.id, model, path, underCovered: q.underCovered });
      }
    }
  }
  return out;
}

export interface AgenticSummary {
  board: ScoreRow[]; // agentic Brier leaderboard (headline)
  uplift: UpliftRow[]; // diagnostic vs the closed arm
  open: OpenPrediction[]; // live disagreement view (unresolved agentic Qs)
  transcripts: TranscriptRef[];
  counts: {
    ratedQuestions: number;
    underCoveredQuestions: number;
    resolvedQuestions: number;
    models: number;
  };
}

// Full agentic summary read from disk. `board` is the headline; `uplift` is the
// paired diagnostic against any matching closed-book forecast-<id>.json.
export function agenticSummary(nowMs: number): AgenticSummary {
  const agentic = loadAllAgenticFiles();
  const closed = loadAllClosedFiles();
  return summarize(agentic, closed, nowMs);
}

// Pure core (testable without disk): summarize provided files.
export function summarize(agentic: AgenticFile[], closed: ForecastFile[], nowMs: number): AgenticSummary {
  const board = scoreModels(agentic as unknown as ForecastFile[]);
  const uplift = upliftRows(agentic, closed);
  const open = openPredictions(agentic as unknown as ForecastFile[], nowMs);
  const rated = countQuestions(agentic, (q) => !q.underCovered);
  const under = countQuestions(agentic, (q) => !!q.underCovered);
  const resolved = countQuestions(agentic, (q) => !!q.resolved);
  return {
    board,
    uplift,
    open,
    transcripts: transcriptRefs(agentic),
    counts: { ratedQuestions: rated, underCoveredQuestions: under, resolvedQuestions: resolved, models: fieldSize(agentic) },
  };
}

// Distinct models that have made any agentic forecast (the field size), so the
// header is honest even before any question resolves.
function fieldSize(files: AgenticFile[]): number {
  const s = new Set<string>();
  for (const f of files) for (const q of f.questions) for (const m of Object.keys(q.predictions)) s.add(m);
  return s.size;
}

function countQuestions(files: AgenticFile[], pred: (q: AgenticQuestion) => boolean): number {
  return files.reduce((s, f) => s + f.questions.filter(pred).length, 0);
}

// --- report formatting ---

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

export function formatAgenticReport(summary: AgenticSummary): string {
  const out: string[] = [];
  out.push("");
  out.push("Track A - Agentic Forecasting (full-capability harness over a frozen evidence pool)");
  out.push(
    `rated: ${summary.counts.ratedQuestions} | under-covered (dropped): ${summary.counts.underCoveredQuestions} | resolved: ${summary.counts.resolvedQuestions} | models: ${summary.counts.models}`,
  );

  out.push("");
  out.push("AGENTIC BRIER LEADERBOARD (headline; resolved questions, horizon signal-weighted)");
  out.push("--------------------------------------------------------------------------------");
  if (summary.board.every((r) => r.n === 0)) {
    out.push("  (board empty until questions mature)");
  } else {
    out.push(`  ${"rating".padStart(6)}  ${"wBrier".padStart(7)}  ${"brier".padStart(6)}  ${"n".padStart(3)}  model`);
    for (const r of summary.board) {
      if (r.n === 0) continue;
      out.push(
        `  ${String(r.rating).padStart(6)}  ${r.weightedBrier.toFixed(4).padStart(7)}  ${r.brier
          .toFixed(4)
          .padStart(6)}  ${String(r.n).padStart(3)}  ${r.model}`,
      );
    }
  }

  out.push("");
  out.push("TOOL UPLIFT (diagnostic only: closedBrier - agenticBrier, paired; + = tools helped)");
  out.push("--------------------------------------------------------------------------------");
  if (summary.uplift.length === 0) {
    out.push("  (no paired closed/agentic resolved questions yet)");
  } else {
    out.push(`  ${"uplift".padStart(7)}  ${"closed".padStart(6)}  ${"agentic".padStart(7)}  ${"n".padStart(3)}  model`);
    for (const r of summary.uplift) {
      out.push(
        `  ${(r.uplift >= 0 ? "+" : "") + r.uplift.toFixed(4)}  ${r.closedBrier.toFixed(4).padStart(6)}  ${r.agenticBrier
          .toFixed(4)
          .padStart(7)}  ${String(r.n).padStart(3)}  ${r.model}`,
      );
    }
  }

  if (summary.open.length > 0) {
    out.push("");
    out.push("OPEN AGENTIC QUESTIONS (soonest first)");
    out.push("--------------------------------------");
    for (const q of summary.open.slice(0, 8)) {
      out.push(`  ${q.asset} close_above ${q.threshold} [${q.horizon}]  consensus ${fmtPct(q.consensus)}  (n=${q.count})`);
    }
  }
  return out.join("\n");
}
