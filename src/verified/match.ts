// One leg of a League-1 adversarial refutation game.
//
// Flow (LOCKED SPEC v3):
//   (a) scheduler assigns class + instance (seeded; never prover choice)
//   (b) PROVER is prompted with the statement + input grammar and returns ONLY
//       Python `solve` code. Platform validates P against hidden smoke inputs;
//       any smoke failure = prover FORFEIT (leg to refuter).
//   (c) REFUTER is prompted with statement + P's source + grammar and returns a
//       JSON array of up to K=10 candidate inputs. Out-of-envelope / invalid
//       inputs are discarded (validateInput).
//   (d) Each valid candidate runs in the sandbox. The first input where P
//       violates the checker or crashes = refutation, and it must reproduce
//       3/3 in fresh runs to count.
//   (e) Result recorded with transcript + cost.
//
// Infra (podman engine) failures on a candidate -> capped replays, then the leg
// is VOID (deferred), excluded from ratings.
//
// LLM_SIM=1: deterministic fake prover + refuter implemented directly here (no
// edits to openrouter.ts) so a full ladder runs offline and reproducibly.

import { chat } from "../openrouter.js";
import type { ArtifactClass, ExecOutcome, LegResult, ProblemInstance } from "./types.js";
import { runInSandbox } from "./sandbox.js";

const K = 10; // max candidate inputs per refuter
const MAX_INFRA_REPLAYS = 2;

// ---------------------------------------------------------------------------
// deterministic sim (mirrors the style of simChat in openrouter.ts)
// ---------------------------------------------------------------------------
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export type SimProverKind = "correct" | "buggy" | "broken";

// Which canned P the fake prover ships for (model, instance): hash-bucketed so a
// full sim ladder exercises correct/buggy/broken provers deterministically.
export function simProverKind(model: string, cls: ArtifactClass, inst: ProblemInstance): SimProverKind {
  const h = hashStr(`${model}|${cls.id}|${inst.seed}`);
  const b = h % 10;
  if (b < 6) return "correct"; // 60% correct
  if (b < 9) return "buggy"; // 30% subtly buggy
  return "broken"; // 10% fails smoke -> forfeit
}

function simProverSrc(model: string, cls: ArtifactClass, inst: ProblemInstance): string {
  switch (simProverKind(model, cls, inst)) {
    case "correct":
      return cls.referenceSolveSrc(inst);
    case "buggy":
      return cls.buggySolveSrc(inst);
    case "broken":
      return cls.brokenSolveSrc(inst);
  }
}

// Fake refuter: draws candidate inputs from the class edge set (which always
// contains a killer for the buggy variant) plus a couple of smoke inputs, in a
// hash-shuffled order, capped at K.
function simRefuterInputs(model: string, cls: ArtifactClass, inst: ProblemInstance): unknown[] {
  const pool = [...cls.edgeInputs(inst), ...cls.hiddenSmokeInputs(inst).slice(0, 2)];
  const h = hashStr(`${model}|refuter|${cls.id}|${inst.seed}`);
  // deterministic rotation so different refuters try different orders
  const rot = h % pool.length;
  const ordered = [...pool.slice(rot), ...pool.slice(0, rot)];
  return ordered.slice(0, K);
}

// ---------------------------------------------------------------------------
// LLM prompt/parse helpers (real mode)
// ---------------------------------------------------------------------------
function stripFences(text: string): string {
  const fence = text.match(/```(?:python|json)?\s*\n([\s\S]*?)```/i);
  return (fence ? fence[1] : text).trim();
}

function proverPrompt(cls: ArtifactClass, inst: ProblemInstance): string {
  return (
    `You are the PROVER in an adversarial code-refutation game.\n\n` +
    `TASK:\n${inst.statementForProver}\n\n` +
    `INPUT GRAMMAR (how your solve() will be called): ${cls.inputGrammar}\n` +
    `Your solve(input) receives the parsed JSON value and must return a JSON-serializable result.\n\n` +
    `Return ONLY a single Python function named solve. No prose, no examples, no test calls. ` +
    `Standard library only; no network, no file I/O.`
  );
}

function refuterPrompt(cls: ArtifactClass, inst: ProblemInstance, proverSrc: string): string {
  return (
    `You are the REFUTER in an adversarial code-refutation game.\n\n` +
    `TASK THE PROVER SOLVED:\n${inst.statementForProver}\n\n` +
    `INPUT GRAMMAR: ${cls.inputGrammar}\n\n` +
    `THE PROVER'S SUBMITTED CODE:\n\`\`\`python\n${proverSrc}\n\`\`\`\n\n` +
    `Find inputs that make this code produce a WRONG answer or crash. Every input must ` +
    `satisfy the grammar and bounds above (out-of-bounds inputs are discarded). ` +
    `Return ONLY a JSON array of up to ${K} candidate inputs, each a valid JSON value ` +
    `for solve(). No prose.`
  );
}

async function askProver(model: string, cls: ArtifactClass, inst: ProblemInstance): Promise<{ src: string; cost: number }> {
  const r = await chat(model, [{ role: "user", content: proverPrompt(cls, inst) }], 2500, {});
  return { src: stripFences(r.text), cost: r.costUsd };
}

async function askRefuter(
  model: string,
  cls: ArtifactClass,
  inst: ProblemInstance,
  proverSrc: string,
): Promise<{ candidates: unknown[]; cost: number }> {
  const r = await chat(model, [{ role: "user", content: refuterPrompt(cls, inst, proverSrc) }], 2500, { json: true });
  let parsed: unknown = [];
  try {
    const t = stripFences(r.text);
    const j = JSON.parse(t);
    parsed = Array.isArray(j) ? j : Array.isArray((j as any)?.inputs) ? (j as any).inputs : [];
  } catch {
    parsed = [];
  }
  return { candidates: (parsed as unknown[]).slice(0, K), cost: r.costUsd };
}

// ---------------------------------------------------------------------------
// execution helpers
// ---------------------------------------------------------------------------

// Run one input up to (1 + MAX_INFRA_REPLAYS) times, absorbing infra hiccups.
// Returns a non-infra outcome, or an infra outcome if every attempt was infra.
async function execWithReplay(src: string, input: unknown, cls: ArtifactClass): Promise<ExecOutcome> {
  let last: ExecOutcome = { kind: "infra", detail: "no attempt" };
  for (let attempt = 0; attempt <= MAX_INFRA_REPLAYS; attempt++) {
    last = await runInSandbox(src, input, cls.envelope);
    if (last.kind !== "infra") return last;
  }
  return last; // still infra after replays
}

// A candidate is a confirmed refutation iff P fails (crash/timeout/violates the
// checker) on 3/3 fresh runs.
async function confirmRefutation(
  src: string,
  input: unknown,
  cls: ArtifactClass,
  inst: ProblemInstance,
): Promise<{ refuted: boolean; infra: boolean }> {
  for (let i = 0; i < 3; i++) {
    const out = await execWithReplay(src, input, cls);
    if (out.kind === "infra") return { refuted: false, infra: true };
    const failed = out.kind === "crash" || out.kind === "timeout" || !cls.checkOutput(input, out.output, inst);
    if (!failed) return { refuted: false, infra: false }; // not reproducible -> not a refutation
  }
  return { refuted: true, infra: false };
}

// Validate P against the hidden smoke inputs. Any failure => forfeit.
async function passesSmoke(
  src: string,
  cls: ArtifactClass,
  inst: ProblemInstance,
): Promise<{ ok: boolean; reason?: string; infra: boolean }> {
  for (const input of cls.hiddenSmokeInputs(inst)) {
    const out = await execWithReplay(src, input, cls);
    if (out.kind === "infra") return { ok: false, infra: true };
    if (out.kind === "crash") return { ok: false, reason: `smoke crash: ${out.detail}`, infra: false };
    if (out.kind === "timeout") return { ok: false, reason: "smoke timeout", infra: false };
    if (!cls.checkOutput(input, out.output, inst))
      return { ok: false, reason: `smoke wrong output on ${JSON.stringify(input).slice(0, 60)}`, infra: false };
  }
  return { ok: true, infra: false };
}

export interface LegSpec {
  legId: string;
  cls: ArtifactClass;
  instance: ProblemInstance;
  prover: string;
  refuter: string;
}

// Run one full leg end-to-end.
export async function runLeg(spec: LegSpec): Promise<LegResult> {
  const { legId, cls, instance, prover, refuter } = spec;
  const sim = process.env.LLM_SIM === "1";
  let costUsd = 0;

  // (b) prover authors P
  let proverSrc: string;
  if (sim) {
    proverSrc = simProverSrc(prover, cls, instance);
  } else {
    const p = await askProver(prover, cls, instance);
    proverSrc = p.src;
    costUsd += p.cost;
  }

  const base: LegResult = {
    legId,
    classId: cls.id,
    instanceSeed: instance.seed,
    prover,
    refuter,
    winner: "prover",
    costUsd,
    transcript: { proverSrc, candidates: [] },
  };

  // (b cont.) smoke gate
  const smoke = await passesSmoke(proverSrc, cls, instance);
  if (smoke.infra) {
    return { ...base, void: true, voidReason: "sandbox infra failure during smoke (replays exhausted)" };
  }
  if (!smoke.ok) {
    return { ...base, winner: "refuter", proverForfeit: true, forfeitReason: smoke.reason };
  }

  // (c) refuter proposes candidates
  let rawCandidates: unknown[];
  if (sim) {
    rawCandidates = simRefuterInputs(refuter, cls, instance);
  } else {
    const r = await askRefuter(refuter, cls, instance, proverSrc);
    rawCandidates = r.candidates;
    costUsd += r.cost;
  }
  const candidates = rawCandidates.filter((c) => cls.validateInput(c, instance)); // discard out-of-envelope

  const result: LegResult = { ...base, costUsd, transcript: { proverSrc, candidates } };

  // (d) execute candidates; first confirmed refutation wins for the refuter
  for (const input of candidates) {
    const out = await execWithReplay(proverSrc, input, cls);
    if (out.kind === "infra") {
      return { ...result, void: true, voidReason: "sandbox infra failure on candidate (replays exhausted)" };
    }
    const failedOnce = out.kind === "crash" || out.kind === "timeout" || !cls.checkOutput(input, out.output, instance);
    if (!failedOnce) continue;
    const conf = await confirmRefutation(proverSrc, input, cls, instance);
    if (conf.infra) {
      return { ...result, void: true, voidReason: "sandbox infra failure during refutation confirmation" };
    }
    if (conf.refuted) {
      return { ...result, winner: "refuter", refutingInput: input };
    }
    // not reproducible 3/3 -> not a refutation; keep scanning
  }

  // (e) no refutation survived -> prover wins
  return result;
}
