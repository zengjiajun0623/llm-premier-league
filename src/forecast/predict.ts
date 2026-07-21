// League 2 — prediction collection.
//
// For each open (unresolved) question, ask each roster model for P(yes) as a
// single number, clamp to [0.01, 0.99], and store it on the question. Predictions
// are resumable by (question id, model): a model already carrying a prediction is
// skipped. Under FORECAST_SIM=1 (or LLM_SIM=1) probabilities are deterministic
// fake values hashed from (model, question) so tests run offline and reproducible.

import { chat } from "../openrouter.js";
import type { ForecastFile, Question } from "./feeds.js";

const CLAMP_LO = 0.01;
const CLAMP_HI = 0.99;

function clampP(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.max(CLAMP_LO, Math.min(CLAMP_HI, p));
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function simPredict(model: string, q: Question): number {
  // Deterministic fake probability in (0,1) from (model, question).
  const h = hashStr(`${model}||${q.id}||${q.threshold}`);
  return clampP((h % 9801) / 9800); // spread across the clamp range
}

function questionPrompt(q: Question): string {
  const when = new Date(q.resolveAt).toISOString();
  return (
    `Question: will the market price of ${q.asset} (USD) be at or above ${q.threshold} ` +
    `at ${when}? The current price is ${q.spotAtCreate}. ` +
    `Respond with your probability that the answer is YES, as a single decimal number ` +
    `between 0 and 1. Output ONLY the number, nothing else.`
  );
}

// One model's probability for one question.
export async function predict(model: string, q: Question): Promise<number> {
  if (process.env.FORECAST_SIM === "1" || process.env.LLM_SIM === "1") {
    return simPredict(model, q);
  }
  const res = await chat(
    model,
    [
      { role: "system", content: "You are a calibrated probabilistic forecaster. Answer with a single number in [0,1] only." },
      { role: "user", content: questionPrompt(q) },
    ],
    2000,
    { temperature: 0 },
  );
  const m = res.text.match(/-?\d*\.?\d+/);
  return clampP(m ? Number(m[0]) : 0.5);
}

// Fill predictions for every open question × roster model, resumably. `save` is
// invoked after each new prediction so a killed run resumes with no lost work.
export async function collectPredictions(
  file: ForecastFile,
  roster: string[],
  save: () => void,
  onOne?: (q: Question, model: string, p: number) => void,
): Promise<void> {
  for (const q of file.questions) {
    if (q.resolved) continue; // never (re)predict a settled question
    for (const model of roster) {
      if (typeof q.predictions[model] === "number") continue; // resume: already done
      let p: number;
      try {
        p = await predict(model, q);
      } catch (err) {
        // A flaky provider must not kill the pose; skip this (question, model)
        // and let a later pose/resume fill it in.
        console.error(`  !! ${q.id} ${model} skipped: ${(err as Error).message.slice(0, 100)}`);
        continue;
      }
      q.predictions[model] = p;
      onOne?.(q, model, p);
      save();
    }
  }
}
