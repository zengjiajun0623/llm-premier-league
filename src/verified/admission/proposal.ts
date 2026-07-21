// The ProposedClass format: what a MODEL emits (as strict JSON) when it proposes
// a new artifact class for the corpus.
//
// KEY DIFFERENCE FROM corpus.ts. The built-in corpus classes carry TypeScript
// checkers (checkOutput) that WE hand-wrote and trust. A proposed class arrives
// as DATA from an untrusted model, so its spec S cannot be TypeScript we execute
// in-process -- that would let a proposer run arbitrary code inside the platform.
// Instead the proposal ships its checker as a Python `check(input, output)`
// SOURCE STRING that the platform runs in the same hermetic sandbox as prover
// code. The checker is therefore data-under-test, admitted only after the three
// mechanical gates (gates.ts) prove it is non-vacuous, self-consistent, and
// non-degenerate. No human ever reads or curates it (LOCKED SPEC: "Corpus growth
// stays autonomous ... admitted solely by mechanical gates").

import { mulberry32 } from "../../rng.js";
import type { ResourceEnvelope } from "../types.js";

// A tiny machine-checkable input grammar. This -- not the model's Python -- is the
// authoritative validator/precondition Q: the platform enforces bounds itself so
// it never has to trust or execute a model-authored validator. The model also
// supplies a human-readable `validatorDescription` for the statement text.
export type InputSchema =
  | { type: "int"; min: number; max: number }
  | { type: "intArray"; minLen: number; maxLen: number; min: number; max: number }
  | { type: "string"; minLen: number; maxLen: number; alphabet?: string }
  | { type: "object"; fields: Record<string, InputSchema> };

export interface ProposedClass {
  id: string;
  description: string;
  // Prover-facing task statement. MUST contain the literal token `{{seed}}` so
  // every leg renders a fresh, instance-tagged statement (freshness / anti-memo).
  statementTemplate: string;
  // Python `def solve(input): ...` returning a JSON-serializable answer.
  referenceSrc: string;
  // Python `def check(input, output) -> bool`. The executable spec S, run
  // sandboxed. Differs from corpus.ts TS checkers: proposals are data, not code.
  checkerSrc: string;
  // Human-readable precondition text (echoed into the statement).
  validatorDescription: string;
  // The authoritative, machine-enforced bounds (precondition Q).
  inputSchema: InputSchema;
  // k >= 3 concrete example inputs the reference must solve (validator round-trip).
  exampleInputs: unknown[];
  // >= 2 buggy variants of the reference. Every one MUST be caught by the checker
  // (mutation gate) -- a spec that cannot distinguish its own mutants is vacuous.
  mutantSrcs: string[];
  // Optional resource envelope; defaults applied by resolveEnvelope().
  envelope?: ResourceEnvelope;
}

export const DEFAULT_ENVELOPE: ResourceEnvelope = { timeoutMs: 8000, maxInputBytes: 8192 };

export function resolveEnvelope(cls: ProposedClass): ResourceEnvelope {
  return cls.envelope ?? DEFAULT_ENVELOPE;
}

// Human-readable schema doc shown to a proposing model (real, non-sim mode).
export const PROPOSAL_SCHEMA_DOC = `Emit ONE JSON object, no prose, with these fields:
  id: short kebab-case identifier (e.g. "gcd-pair")
  description: one sentence describing the task
  statementTemplate: prover-facing instructions; MUST contain the token {{seed}};
    must specify the exact solve() signature and the answer format
  referenceSrc: Python source defining def solve(input): -> a correct answer
  checkerSrc: Python source defining def check(input, output): -> True iff output
    is a correct answer for input. It is the SPEC. Make it strict on edge cases.
  validatorDescription: human text of the input precondition/bounds
  inputSchema: one of
    {"type":"int","min":..,"max":..}
    {"type":"intArray","minLen":..,"maxLen":..,"min":..,"max":..}
    {"type":"string","minLen":..,"maxLen":..,"alphabet":"..."}
    {"type":"object","fields":{"name":<schema>,...}}
  exampleInputs: >= 3 concrete inputs the reference solves and that satisfy inputSchema
  mutantSrcs: >= 2 Python solve() variants that are SUBTLY WRONG; your checker
    must catch every one of them on some input (or the class is rejected)`;

// -------------------------------------------------------------------------
// Shape validation (used when parsing a real model's JSON before gating).
// -------------------------------------------------------------------------
export function validateProposedShape(x: unknown): { ok: true; value: ProposedClass } | { ok: false; errors: string[] } {
  const e: string[] = [];
  const o = x as Record<string, unknown>;
  if (typeof x !== "object" || x === null) return { ok: false, errors: ["proposal is not an object"] };
  const str = (k: string) => {
    if (typeof o[k] !== "string" || (o[k] as string).length === 0) e.push(`${k} must be a non-empty string`);
  };
  str("id");
  str("description");
  str("statementTemplate");
  str("referenceSrc");
  str("checkerSrc");
  str("validatorDescription");
  if (typeof o.statementTemplate === "string" && !o.statementTemplate.includes("{{seed}}"))
    e.push("statementTemplate must contain the {{seed}} token");
  if (!isValidSchema(o.inputSchema)) e.push("inputSchema is missing or malformed");
  if (!Array.isArray(o.exampleInputs) || o.exampleInputs.length < 3) e.push("exampleInputs must have >= 3 entries");
  if (!Array.isArray(o.mutantSrcs) || o.mutantSrcs.length < 2 || !o.mutantSrcs.every((m) => typeof m === "string"))
    e.push("mutantSrcs must have >= 2 Python source strings");
  if (o.id && !/^[a-z0-9][a-z0-9-]*$/.test(o.id as string)) e.push("id must be kebab-case");
  if (e.length) return { ok: false, errors: e };
  return { ok: true, value: x as ProposedClass };
}

export function isValidSchema(s: unknown): s is InputSchema {
  if (typeof s !== "object" || s === null) return false;
  const o = s as Record<string, unknown>;
  switch (o.type) {
    case "int":
      return typeof o.min === "number" && typeof o.max === "number" && o.min <= o.max;
    case "intArray":
      return (
        typeof o.minLen === "number" && typeof o.maxLen === "number" && o.minLen >= 0 && o.minLen <= o.maxLen &&
        typeof o.min === "number" && typeof o.max === "number" && o.min <= o.max
      );
    case "string":
      return typeof o.minLen === "number" && typeof o.maxLen === "number" && o.minLen >= 0 && o.minLen <= o.maxLen;
    case "object":
      return (
        typeof o.fields === "object" && o.fields !== null &&
        Object.values(o.fields as Record<string, unknown>).every(isValidSchema)
      );
    default:
      return false;
  }
}

// -------------------------------------------------------------------------
// Mechanical validator (precondition Q enforcement) + seeded fuzzer.
// -------------------------------------------------------------------------
export function validateAgainstSchema(input: unknown, schema: InputSchema): boolean {
  switch (schema.type) {
    case "int":
      return typeof input === "number" && Number.isInteger(input) && input >= schema.min && input <= schema.max;
    case "intArray":
      return (
        Array.isArray(input) &&
        input.length >= schema.minLen &&
        input.length <= schema.maxLen &&
        input.every((v) => typeof v === "number" && Number.isInteger(v) && v >= schema.min && v <= schema.max)
      );
    case "string": {
      if (typeof input !== "string") return false;
      const cps = [...input];
      if (cps.length < schema.minLen || cps.length > schema.maxLen) return false;
      if (schema.alphabet) return cps.every((c) => schema.alphabet!.includes(c));
      return true;
    }
    case "object": {
      if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
      const o = input as Record<string, unknown>;
      const keys = Object.keys(schema.fields);
      if (Object.keys(o).length !== keys.length) return false;
      return keys.every((k) => k in o && validateAgainstSchema(o[k], schema.fields[k]));
    }
  }
}

const DEFAULT_ALPHABET = "abcABC0123 .,!";

export function fuzzInput(schema: InputSchema, rnd: () => number): unknown {
  switch (schema.type) {
    case "int":
      return schema.min + Math.floor(rnd() * (schema.max - schema.min + 1));
    case "intArray": {
      const len = schema.minLen + Math.floor(rnd() * (schema.maxLen - schema.minLen + 1));
      return Array.from({ length: len }, () => schema.min + Math.floor(rnd() * (schema.max - schema.min + 1)));
    }
    case "string": {
      const alpha = schema.alphabet ?? DEFAULT_ALPHABET;
      const len = schema.minLen + Math.floor(rnd() * (schema.maxLen - schema.minLen + 1));
      let s = "";
      const chars = [...alpha];
      for (let i = 0; i < len; i++) s += chars[Math.floor(rnd() * chars.length)];
      return s;
    }
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(schema.fields)) out[k] = fuzzInput(sub, rnd);
      return out;
    }
  }
}

// N seeded fuzz inputs from a schema. Same seed -> identical batch (reproducible).
export function fuzzBatch(schema: InputSchema, n: number, seed: number): unknown[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, () => fuzzInput(schema, rnd));
}

// Build a Python solve() that ignores its input and always returns `constant`.
// This is the platform-generated trivial baseline the difficulty gate pits
// against the checker (a class a constant program can beat is degenerate).
export function constantSolutionSrc(constant: unknown): string {
  return `import json\n_C = ${JSON.stringify(JSON.stringify(constant))}\ndef solve(inp):\n    return json.loads(_C)\n`;
}

// -------------------------------------------------------------------------
// Deterministic sim proposals (LLM_SIM=1): no model call.
//   hash(proposer) even -> an ADMISSIBLE class (passes all three gates)
//   hash(proposer) odd  -> a VACUOUS-checker class (mutation gate rejects it)
// -------------------------------------------------------------------------
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function sanitize(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "");
}

// An admissible class: sum of an integer list. Strict checker, catchable mutants,
// input-dependent output (so a constant baseline fails the difficulty gate).
export function admissibleProposal(proposer: string): ProposedClass {
  return {
    id: `listsum-${sanitize(proposer)}`,
    description: "Return the sum of a list of integers.",
    statementTemplate:
      "Implement `solve(nums)` where nums is a list of integers. Return their integer sum. " +
      "Bounds: 0..16 integers, each in [-1000, 1000]. (instance {{seed}})",
    referenceSrc: `def solve(nums):\n    return sum(nums)\n`,
    checkerSrc: `def check(nums, out):\n    return isinstance(out, int) and not isinstance(out, bool) and out == sum(nums)\n`,
    validatorDescription: "A JSON array of 0..16 integers, each in [-1000, 1000].",
    inputSchema: { type: "intArray", minLen: 0, maxLen: 16, min: -1000, max: 1000 },
    exampleInputs: [[], [1, 2, 3], [-5, 5], [10], [7, -7, 7]],
    mutantSrcs: [
      `def solve(nums):\n    return sum(nums) + 1\n`, // off-by-one (caught on [])
      `def solve(nums):\n    return sum(nums[1:])\n`, // drops first (caught on [1,2,3])
    ],
    envelope: DEFAULT_ENVELOPE,
  };
}

// A vacuous class: the checker accepts EVERY output. Gate (a) passes (reference
// "verified"), but no mutant is ever caught -> mutation gate rejects it. Also
// degenerate under the difficulty gate. Demonstrates the gates doing real work.
export function vacuousProposal(proposer: string): ProposedClass {
  return {
    id: `vac-echo-${sanitize(proposer)}`,
    description: "Return the sum of a list of integers (with a vacuous checker).",
    statementTemplate:
      "Implement `solve(nums)` returning the sum of the integer list nums. (instance {{seed}})",
    referenceSrc: `def solve(nums):\n    return sum(nums)\n`,
    // Always True: cannot distinguish correct from wrong -> vacuous spec.
    checkerSrc: `def check(nums, out):\n    return True\n`,
    validatorDescription: "A JSON array of 0..16 integers, each in [-1000, 1000].",
    inputSchema: { type: "intArray", minLen: 0, maxLen: 16, min: -1000, max: 1000 },
    exampleInputs: [[], [1, 2, 3], [-5, 5], [10]],
    mutantSrcs: [
      `def solve(nums):\n    return sum(nums) + 1\n`,
      `def solve(nums):\n    return 0\n`,
    ],
    envelope: DEFAULT_ENVELOPE,
  };
}

export function simProposal(proposer: string): ProposedClass {
  return hashStr(proposer) % 2 === 0 ? admissibleProposal(proposer) : vacuousProposal(proposer);
}
