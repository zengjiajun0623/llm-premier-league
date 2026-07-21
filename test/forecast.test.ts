// League 2 (Forecasting) tests. Fully offline + deterministic:
//   FORECAST_SIM=1  -> canned roster + hashed fake probabilities (no LLM calls)
//   FEED_SIM=1      -> canned prices (no network), via FEED_SIM_PRICES
//   RESULTS_DIR     -> temp dir, so sim sets never touch real results.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FORECAST_SIM = "1";
process.env.FEED_SIM = "1";

import type { ForecastFile, Question } from "../src/forecast/feeds.ts";

const { generateQuestions, signalWeightFor, HORIZONS } = await import("../src/forecast/feeds.ts");
const { pose, resolveAll, forecastRoster } = await import("../src/forecast/run.ts");
const { resolveMatured } = await import("../src/forecast/resolve.ts");
const { scoreModels, forecastSummary, openPredictions } = await import("../src/forecast/score.ts");

const HOUR = 3_600e3;
const DAY = 86_400e3;
const NOW = 1_800_000_000_000; // fixed sim clock

function withTmpResults(): string {
  const dir = mkdtempSync(join(tmpdir(), "forecast-"));
  process.env.RESULTS_DIR = dir;
  return dir;
}

function setPrices(p: Record<string, number>) {
  process.env.FEED_SIM_PRICES = JSON.stringify(p);
}

// --- generation ---
test("generateQuestions: deterministic, future resolveAt, tagged horizons", async () => {
  setPrices({ bitcoin: 60000, ethereum: 3000, solana: 150 });
  const a = await generateQuestions(42, NOW);
  const b = await generateQuestions(42, NOW);
  assert.deepEqual(a, b, "same (seed, feed snapshot) => identical questions");
  assert.equal(a.length, 3 * HORIZONS.length, "one question per asset x horizon");
  const horizonsSeen = new Set(a.map((q) => q.horizon));
  assert.equal(horizonsSeen.size, HORIZONS.length, "every pose spans all horizons");
  for (const q of a) {
    assert.ok(q.resolveAt > NOW, "resolveAt must be in the future");
    assert.equal(q.resolveAt, NOW + q.horizonMs);
    assert.ok(HORIZONS.some((h) => h.label === q.horizon), "horizon must be a known label");
    assert.equal(q.kind, "close_above");
  }
});

// --- pose: predictions + disagreement fields ---
test("pose: one prediction per model, open-prediction disagreement present pre-resolution", async () => {
  withTmpResults();
  setPrices({ bitcoin: 60000, ethereum: 3000, solana: 150 });
  const file = await pose({ id: "t1", nowMs: NOW });
  const roster = forecastRoster();
  assert.ok(roster.length >= 2);

  for (const q of file.questions) {
    assert.equal(Object.keys(q.predictions).length, roster.length, "one prediction per model");
    for (const m of roster) {
      const p = q.predictions[m];
      assert.ok(p >= 0.01 && p <= 0.99, "clamped to [0.01,0.99]");
    }
  }

  // open view: consensus + disagreement first-class, sorted soonest-first
  const open = openPredictions([file], NOW);
  assert.equal(open.length, file.questions.length, "all open before resolution");
  for (const o of open) {
    assert.equal(o.count, roster.length);
    assert.ok(o.disagreement >= 0, "disagreement (stdev) present");
    assert.ok(o.consensus > 0 && o.consensus < 1, "consensus present");
    assert.ok(o.msToResolve > 0);
  }
  for (let i = 1; i < open.length; i++) assert.ok(open[i].resolveAt >= open[i - 1].resolveAt, "sorted soonest-first");
  // with 3 distinct sim models, at least one question shows real disagreement
  assert.ok(open.some((o) => o.disagreement > 0), "models disagree on open questions");
});

// --- not resolvable before resolveAt ---
test("resolve: matured only; nothing settles before resolveAt", async () => {
  withTmpResults();
  setPrices({ bitcoin: 60000, ethereum: 3000, solana: 150 });
  await pose({ id: "t2", nowMs: NOW });

  const before = await resolveAll(NOW); // now == createdAt, all in future
  assert.equal(before.changed, 0, "no file changes before any resolveAt");
  const summ0 = forecastSummary([JSON.parse(readFileSync(join(process.env.RESULTS_DIR!, "forecast-t2.json"), "utf8"))], NOW);
  assert.equal(summ0.counts.resolvedQuestions, 0);

  const after = await resolveAll(NOW + 40 * DAY); // past every horizon
  assert.equal(after.changed, 1);
  const file = JSON.parse(readFileSync(join(process.env.RESULTS_DIR!, "forecast-t2.json"), "utf8")) as ForecastFile;
  for (const q of file.questions) {
    assert.equal(q.resolved, true);
    assert.ok(q.outcome === 0 || q.outcome === 1, "binary outcome");
    assert.equal(q.outcome, (q.resolvedPrice ?? 0) >= q.threshold ? 1 : 0, "outcome = price>=threshold");
  }
});

// --- short-horizon resolves same-"day"; long one waits ---
test("resolve: short-horizon question settles same-day, long horizon waits", async () => {
  setPrices({ bitcoin: 60000 });
  const shortQ: Question = {
    id: "bitcoin-6h-x",
    asset: "bitcoin",
    kind: "close_above",
    threshold: 59000, // will resolve YES at 60000
    horizon: "6h",
    horizonMs: 6 * HOUR,
    resolveAt: NOW + 6 * HOUR,
    createdAt: NOW,
    spotAtCreate: 60000,
    predictions: { "sim/a": 0.8 },
  };
  const longQ: Question = {
    ...shortQ,
    id: "bitcoin-30d-x",
    threshold: 61000, // NO at 60000
    horizon: "30d",
    horizonMs: 30 * DAY,
    resolveAt: NOW + 30 * DAY,
  };
  const file: ForecastFile = { id: "sh", createdAt: "", updatedAt: "", roster: ["sim/a"], questions: [shortQ, longQ] };

  const changed = await resolveMatured(file, NOW + 7 * HOUR); // same-day
  assert.equal(changed, true);
  assert.equal(shortQ.resolved, true);
  assert.equal(shortQ.outcome, 1, "60000 >= 59000 -> YES");
  assert.equal(longQ.resolved, undefined, "30d horizon not yet matured");

  await resolveMatured(file, NOW + 31 * DAY);
  assert.equal(longQ.resolved, true);
  assert.equal(longQ.outcome, 0, "60000 < 61000 -> NO");
});

// --- scoring: correct side beats 0.5 ---
test("score: a model predicting the correct side beats one always predicting 0.5", () => {
  const mkQ = (id: string, outcome: 0 | 1): Question => ({
    id,
    asset: "bitcoin",
    kind: "close_above",
    threshold: 1,
    horizon: "7d",
    horizonMs: 7 * DAY,
    resolveAt: NOW,
    createdAt: NOW,
    spotAtCreate: 1,
    resolved: true,
    outcome,
    resolvedPrice: 1,
    resolvedAt: NOW,
    predictions: { correct: outcome ? 0.99 : 0.01, half: 0.5 },
  });
  const file: ForecastFile = {
    id: "s",
    createdAt: "",
    updatedAt: "",
    roster: ["correct", "half"],
    questions: [mkQ("q1", 1), mkQ("q2", 0), mkQ("q3", 1)],
  };
  const rows = scoreModels([file]);
  const correct = rows.find((r) => r.model === "correct")!;
  const half = rows.find((r) => r.model === "half")!;
  assert.ok(correct.brier < half.brier, "correct side has lower Brier");
  assert.ok(correct.rating > half.rating, "correct side rated higher");
  assert.equal(rows[0].model, "correct", "leaderboard ranks correct first");
});

// --- signal weighting applied ---
test("score: horizon signal-weighting changes the aggregate Brier", () => {
  assert.equal(signalWeightFor("6h"), 0.25);
  assert.equal(signalWeightFor("30d"), 1.5);
  const q6: Question = {
    id: "q6",
    asset: "bitcoin",
    kind: "close_above",
    threshold: 1,
    horizon: "6h",
    horizonMs: 6 * HOUR,
    resolveAt: NOW,
    createdAt: NOW,
    spotAtCreate: 1,
    resolved: true,
    outcome: 1,
    resolvedPrice: 1,
    resolvedAt: NOW,
    predictions: { m: 1.0 }, // perfect -> Brier 0
  };
  const q30: Question = { ...q6, id: "q30", horizon: "30d", horizonMs: 30 * DAY, predictions: { m: 0.5 } }; // Brier 0.25
  const file: ForecastFile = { id: "w", createdAt: "", updatedAt: "", roster: ["m"], questions: [q6, q30] };
  const row = scoreModels([file])[0];
  // unweighted = (0 + 0.25)/2 = 0.125
  assert.ok(Math.abs(row.brier - 0.125) < 1e-9);
  // weighted = (0.25*0 + 1.5*0.25)/(0.25+1.5) = 0.375/1.75 = 0.214285...
  assert.ok(Math.abs(row.weightedBrier - 0.375 / 1.75) < 1e-9, "weighted Brier reflects horizon weights");
  assert.notEqual(row.weightedBrier, row.brier);
});

// --- resume determinism + atomic write ---
test("pose: resume after truncation reproduces identical predictions; no .tmp left", async () => {
  const dir = withTmpResults();
  setPrices({ bitcoin: 60000, ethereum: 3000, solana: 150 });
  const full = await pose({ id: "t3", nowMs: NOW });

  // truncate: drop predictions from the first question, then rerun
  const path = join(dir, "forecast-t3.json");
  const partial = JSON.parse(readFileSync(path, "utf8")) as ForecastFile;
  partial.questions[0].predictions = {};
  const tmp = `${path}.tmp`;
  const { writeFileSync, renameSync } = await import("node:fs");
  writeFileSync(tmp, JSON.stringify(partial, null, 2));
  renameSync(tmp, path);

  const resumed = await pose({ id: "t3", nowMs: NOW });
  assert.deepEqual(
    resumed.questions.map((q) => [q.id, q.predictions]),
    full.questions.map((q) => [q.id, q.predictions]),
    "resume reproduces identical predictions",
  );

  // atomic write leaves no .tmp artifacts
  assert.ok(!readdirSync(dir).some((f) => f.endsWith(".tmp")), "no .tmp files left behind");
});
