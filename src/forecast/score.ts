// League 2 — scoring.
//
// Proper scoring rule: Brier = (p - outcome)^2 per resolved prediction. Per model
// we report mean Brier (lower is better), a Brier skill score vs the field's
// per-question consensus (mean prediction), and a 1500-centered rating so the
// board reads on the same scale as the BT ladders (higher = better).
//
// Horizon signal-weighting: short-horizon questions on a liquid price feed are
// near-random (efficient market ~ random walk over hours), so they barely
// discriminate models. The ranking weights each resolved question by its
// horizon `signalWeight` (6h=0.25 ... 30d=1.5) in the mean-Brier aggregation.
// Both weighted and unweighted numbers are exposed so the down-weighting is
// auditable rather than hidden.

import { signalWeightFor, type ForecastFile, type Question } from "./feeds.js";

const RATING_SCALE = 400; // Elo-ish spread around 1500 for board consistency

export interface ScoreRow {
  model: string;
  n: number; // resolved questions answered
  brier: number; // unweighted mean Brier
  weightedBrier: number; // signal-weighted mean Brier
  bss: number; // Brier skill score vs field consensus (weighted)
  rating: number; // 1500-centered, higher = better
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function consensus(q: Question): number {
  const ps = Object.values(q.predictions);
  return mean(ps);
}

// All resolved questions across the provided files.
function resolvedQuestions(files: ForecastFile[]): Question[] {
  return files.flatMap((f) => f.questions.filter((q) => q.resolved && q.outcome !== undefined));
}

export function scoreModels(files: ForecastFile[]): ScoreRow[] {
  const resolved = resolvedQuestions(files);
  const models = new Set<string>();
  for (const f of files) for (const m of f.roster) models.add(m);
  for (const q of resolved) for (const m of Object.keys(q.predictions)) models.add(m);

  const rows: ScoreRow[] = [];
  for (const model of models) {
    let n = 0;
    const briers: number[] = [];
    let wSum = 0;
    let wBrierSum = 0;
    let wFieldSum = 0; // field-consensus Brier under the same weights
    for (const q of resolved) {
      const p = q.predictions[model];
      if (typeof p !== "number") continue;
      const o = q.outcome!;
      const b = (p - o) ** 2;
      const w = signalWeightFor(q.horizon);
      const fieldB = (consensus(q) - o) ** 2;
      n++;
      briers.push(b);
      wSum += w;
      wBrierSum += w * b;
      wFieldSum += w * fieldB;
    }
    const brier = mean(briers);
    const weightedBrier = wSum > 0 ? wBrierSum / wSum : 0;
    const fieldBrier = wSum > 0 ? wFieldSum / wSum : 0;
    // Skill vs field consensus: 1 - model/field. Positive = beats the crowd.
    const bss = fieldBrier > 0 ? 1 - weightedBrier / fieldBrier : 0;
    const rating = Math.round(1500 + RATING_SCALE * bss);
    rows.push({ model, n, brier, weightedBrier, bss, rating });
  }
  // Rank by rating (equivalently, lowest weighted Brier). Unrated (n=0) sink.
  return rows.sort((a, b) => (b.n === 0 ? -1 : a.n === 0 ? 1 : 0) || b.rating - a.rating);
}

// --- Open-prediction view (pre-resolution disagreement is first-class data) ---

export interface OpenPrediction {
  id: string;
  asset: string;
  kind: string;
  threshold: number;
  horizon: string;
  resolveAt: number;
  msToResolve: number; // relative to the `nowMs` passed in
  spotAtCreate: number;
  predictions: Record<string, number>;
  consensus: number; // mean P(yes) across the field
  disagreement: number; // population stdev of predictions (the "spread")
  count: number; // how many models have answered
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

// Every open (unresolved) question with the field's probabilities, consensus,
// and disagreement, sorted soonest-resolving first.
export function openPredictions(files: ForecastFile[], nowMs: number): OpenPrediction[] {
  const out: OpenPrediction[] = [];
  for (const f of files) {
    for (const q of f.questions) {
      if (q.resolved) continue;
      const ps = Object.values(q.predictions);
      out.push({
        id: q.id,
        asset: q.asset,
        kind: q.kind,
        threshold: q.threshold,
        horizon: q.horizon,
        resolveAt: q.resolveAt,
        msToResolve: q.resolveAt - nowMs,
        spotAtCreate: q.spotAtCreate,
        predictions: { ...q.predictions },
        consensus: mean(ps),
        disagreement: stdev(ps),
        count: ps.length,
      });
    }
  }
  return out.sort((a, b) => a.resolveAt - b.resolveAt);
}

export interface ForecastSummary {
  open: OpenPrediction[];
  leaderboard: ScoreRow[];
  counts: { openQuestions: number; resolvedQuestions: number; models: number };
}

// Both halves of the league in one object: the live disagreement view and the
// settled Brier leaderboard.
export function forecastSummary(files: ForecastFile[], nowMs: number): ForecastSummary {
  const open = openPredictions(files, nowMs);
  const leaderboard = scoreModels(files);
  const resolvedQuestions = files.reduce((s, f) => s + f.questions.filter((q) => q.resolved).length, 0);
  const openQuestions = files.reduce((s, f) => s + f.questions.filter((q) => !q.resolved).length, 0);
  return {
    open,
    leaderboard,
    counts: { openQuestions, resolvedQuestions, models: leaderboard.length },
  };
}
