// League 2 — mechanical resolution.
//
// A question with resolveAt <= now and not yet resolved is settled by reading the
// current feed price for its asset and comparing to the frozen threshold:
// outcome = spotNow >= threshold ? 1 : 0. Reality resolves; no model, no judge.
// Pure and deterministic under FEED_SIM=1.

import { fetchPrices, type ForecastFile } from "./feeds.js";

// Settle every matured, unresolved question in `file`. Returns true if anything
// changed (so callers can persist only on change).
export async function resolveMatured(file: ForecastFile, nowMs: number): Promise<boolean> {
  const matured = file.questions.filter((q) => !q.resolved && q.resolveAt <= nowMs);
  if (matured.length === 0) return false;

  // One feed read covers all assets needed this pass.
  const assets = [...new Set(matured.map((q) => q.asset))];
  const prices = await fetchPrices(assets);

  let changed = false;
  for (const q of matured) {
    const spotNow = prices[q.asset];
    q.resolvedPrice = spotNow;
    q.outcome = spotNow >= q.threshold ? 1 : 0;
    q.resolved = true;
    q.resolvedAt = nowMs;
    changed = true;
  }
  return changed;
}
