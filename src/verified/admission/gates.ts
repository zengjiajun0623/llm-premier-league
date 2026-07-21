// The three mechanical admission gates. No human curation: a proposed class is
// admitted iff it passes ALL THREE, each proven by execution in the sandbox.
//
//   (a) validator round-trip -- every example input satisfies the declared
//       bounds, and the reference solution passes the proposal's own checker on
//       all of them. (Self-consistency: the spec accepts its own reference.)
//   (b) mutation gate -- EVERY supplied mutant of the reference is caught (the
//       checker rejects it, or it crashes) on at least one example or fuzzed
//       input. A spec that cannot catch its own mutants is vacuous. (Kimi rule.)
//   (c) fuzz difficulty band -- over N=30 seeded fuzz inputs the reference passes
//       all, and a platform-generated constant-output baseline FAILS >= 30%. A
//       class a constant program can beat is trivially unbreakable / degenerate.

import {
  fuzzBatch,
  resolveEnvelope,
  validateAgainstSchema,
  constantSolutionSrc,
  type ProposedClass,
} from "./proposal.js";
import { evalSolutionChecked, runSolutionRaw } from "./exec.js";

export interface GateResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface GateReport {
  pass: boolean;
  gates: GateResult[];
  // One catching input per mutant (index-aligned to mutantSrcs). Stored on
  // admission so the runtime adapter can hand the sim refuter a guaranteed kill.
  witnesses: unknown[];
}

const FUZZ_N = 30;
const FUZZ_SEED = 0xf0021;
const MUTATION_FUZZ_SEED = 0xb0b;
const MIN_BASELINE_FAIL_RATE = 0.3;

// (a) validator round-trip
function validatorRoundTrip(cls: ProposedClass): GateResult {
  const env = resolveEnvelope(cls);
  for (const [i, ex] of cls.exampleInputs.entries()) {
    if (!validateAgainstSchema(ex, cls.inputSchema)) {
      return { name: "validator-round-trip", pass: false, detail: `example #${i} violates inputSchema: ${JSON.stringify(ex).slice(0, 80)}` };
    }
    const r = evalSolutionChecked(cls.checkerSrc, cls.referenceSrc, ex, env);
    if (r.kind !== "ok") {
      return { name: "validator-round-trip", pass: false, detail: `reference errored on example #${i} (${r.outcome.kind})` };
    }
    if (!r.pass) {
      return { name: "validator-round-trip", pass: false, detail: `checker REJECTS the reference on example #${i}: ${JSON.stringify(ex).slice(0, 80)}` };
    }
  }
  return { name: "validator-round-trip", pass: true, detail: `reference passes checker on all ${cls.exampleInputs.length} examples` };
}

// (b) mutation gate. Returns per-mutant witnesses when it passes.
function mutationGate(cls: ProposedClass): { result: GateResult; witnesses: unknown[] } {
  const env = resolveEnvelope(cls);
  const fuzzed = fuzzBatch(cls.inputSchema, FUZZ_N, MUTATION_FUZZ_SEED);
  const pool = [...cls.exampleInputs, ...fuzzed];
  const witnesses: unknown[] = [];
  for (const [mi, mutantSrc] of cls.mutantSrcs.entries()) {
    let caughtOn: unknown = undefined;
    for (const input of pool) {
      const r = evalSolutionChecked(cls.checkerSrc, mutantSrc, input, env);
      // Caught iff the checker rejects it OR the mutant crashed/timed out.
      const caught = r.kind !== "ok" || r.pass === false;
      if (caught) {
        caughtOn = input;
        break;
      }
    }
    if (caughtOn === undefined) {
      return {
        result: { name: "mutation", pass: false, detail: `mutant #${mi} is NOT caught by the checker on any example or fuzzed input (vacuous spec)` },
        witnesses: [],
      };
    }
    witnesses.push(caughtOn);
  }
  return {
    result: { name: "mutation", pass: true, detail: `all ${cls.mutantSrcs.length} mutants caught` },
    witnesses,
  };
}

// (c) fuzz difficulty band
function fuzzDifficulty(cls: ProposedClass): GateResult {
  const env = resolveEnvelope(cls);
  const fuzzed = fuzzBatch(cls.inputSchema, FUZZ_N, FUZZ_SEED);

  // Reference must pass every fuzzed input (spec/reference self-consistency).
  for (const [i, x] of fuzzed.entries()) {
    const r = evalSolutionChecked(cls.checkerSrc, cls.referenceSrc, x, env);
    if (r.kind !== "ok" || !r.pass) {
      return { name: "fuzz-difficulty", pass: false, detail: `reference failed checker on fuzzed input #${i} (${r.kind === "ok" ? "rejected" : r.outcome.kind})` };
    }
  }

  // Platform-generated trivial baseline: always emit one valid reference output.
  const base = runSolutionRaw(cls.referenceSrc, fuzzed[0], env);
  if (!base.ok) return { name: "fuzz-difficulty", pass: false, detail: "could not compute a constant baseline (reference errored)" };
  const constSrc = constantSolutionSrc(base.output);

  let fails = 0;
  for (const x of fuzzed) {
    const r = evalSolutionChecked(cls.checkerSrc, constSrc, x, env);
    const failed = r.kind !== "ok" || r.pass === false;
    if (failed) fails++;
  }
  const rate = fails / fuzzed.length;
  const pass = rate >= MIN_BASELINE_FAIL_RATE;
  return {
    name: "fuzz-difficulty",
    pass,
    detail: `constant baseline fails ${fails}/${fuzzed.length} (${(rate * 100).toFixed(0)}%); need >= ${(MIN_BASELINE_FAIL_RATE * 100).toFixed(0)}%`,
  };
}

// Run all three gates. Every gate runs (so the report is complete for auditing),
// even after an earlier failure.
export function runGates(cls: ProposedClass): GateReport {
  const a = validatorRoundTrip(cls);
  const b = mutationGate(cls);
  const c = fuzzDifficulty(cls);
  const gates = [a, b.result, c];
  return { pass: gates.every((g) => g.pass), gates, witnesses: b.result.pass ? b.witnesses : [] };
}
