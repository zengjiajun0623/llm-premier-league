// League-1 (adversarial refutation) core types.
//
// Per LOCKED SPEC v3: artifact classes are PLATFORM-OWNED. Models author only
// solutions (prover: a Python `solve`) and attacks (refuter: concrete inputs).
// The spec S (checkOutput), precondition Q + bounds (validateInput), hidden
// smoke cases, input grammar, and resource envelope all live here in TypeScript
// and are NEVER shown to a model or shipped into the sandbox with P.

export interface ResourceEnvelope {
  timeoutMs: number; // wall-clock cap per single sandbox execution of P
  maxInputBytes: number; // cap on the JSON-serialized size of one input
}

// A concrete, seeded problem handed to a prover for one leg. Fresh per leg so a
// class cannot be memorized. `params` carries class-specific instance data used
// by the platform-owned checker (never serialized into the sandbox).
export interface ProblemInstance {
  classId: string;
  seed: number;
  statementForProver: string; // natural language + exact `solve` signature
  boundsDescription: string; // human-readable size/precondition bounds
  validatorSrc?: string; // optional: precondition description echoed to models
  params: Record<string, unknown>;
}

export interface ArtifactClass {
  id: string;
  description: string;
  envelope: ResourceEnvelope;
  // Grammar + serialization the refuter must produce candidate inputs under.
  inputGrammar: string;

  // Seeded instance factory: same seed -> identical instance.
  generate(seed: number): ProblemInstance;

  // Precondition Q + size bounds. Refuter inputs failing this are DISCARDED,
  // never counted as refutations (attacking out-of-spec inputs is not allowed).
  validateInput(input: unknown, instance: ProblemInstance): boolean;

  // The executable spec S. Platform-owned, invisible to models. Returns true iff
  // `output` is a correct answer for `input` under this instance. Must be
  // genuinely discriminative: correct solutions pass, sloppy ones fail on edges.
  checkOutput(input: unknown, output: unknown, instance: ProblemInstance): boolean;

  // Hidden smoke inputs. Prover P is validated against these before the refuter
  // is even called; any smoke failure = prover forfeit.
  hiddenSmokeInputs(instance: ProblemInstance): unknown[];

  // --- platform-owned reference material (tests + LLM_SIM only) ---
  // A known-correct Python `solve` body (passes smoke + every edge input).
  referenceSolveSrc(instance: ProblemInstance): string;
  // A known-buggy Python `solve` body (passes smoke, refutable by an edge input).
  buggySolveSrc(instance: ProblemInstance): string;
  // A Python `solve` that fails smoke outright (forfeit path).
  brokenSolveSrc(instance: ProblemInstance): string;
  // In-envelope adversarial candidate inputs the sim refuter draws from. MUST
  // include at least one input that refutes buggySolveSrc.
  edgeInputs(instance: ProblemInstance): unknown[];
}

// One executed candidate against P.
export type ExecOutcome =
  | { kind: "ok"; output: unknown }
  | { kind: "crash"; detail: string } // nonzero exit / bad protocol output
  | { kind: "timeout" }
  | { kind: "infra"; detail: string }; // container-engine defect -> replay/void

export interface LegResult {
  legId: string;
  classId: string;
  instanceSeed: number;
  prover: string;
  refuter: string;
  winner: "prover" | "refuter";
  refutingInput?: unknown;
  proverForfeit?: boolean;
  forfeitReason?: string;
  void?: boolean; // reproducible harness defect -> excluded from ratings
  voidReason?: string;
  costUsd: number;
  transcript: {
    proverSrc: string;
    candidates: unknown[];
  };
}
