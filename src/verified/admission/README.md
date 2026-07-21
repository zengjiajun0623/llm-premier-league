# M7 — Self-authored corpus (mechanical admission pipeline)

Autonomous admission of **model-proposed artifact classes** into League 1. No
human authors, curates, or approves a class: a proposal is admitted iff it
passes three mechanical gates, each proven by execution in the sandbox.

Implements LOCKED SPEC (`docs/DESIGN_V3_VERIFIED.md`): *"Corpus growth stays
autonomous — models may propose new classes, admitted solely by mechanical gates
— mutation testing (spec catches k≥2 mutants of a reference solution), platform
fuzz calibration into a target difficulty band, validator round-trip. No human
curation."*

## Files

- `proposal.ts` — the `ProposedClass` JSON format a model emits: id, description,
  `statementTemplate` (with `{{seed}}`), Python `referenceSrc` (`solve`), Python
  `checkerSrc` (`check(input, output) -> bool`), a machine `inputSchema` +
  human `validatorDescription`, ≥3 `exampleInputs`, ≥2 `mutantSrcs`. Also the
  seeded fuzzer, the schema validator, and the deterministic sim proposals.
- `gates.ts` — the three gates: `validator-round-trip`, `mutation`,
  `fuzz-difficulty`. `runGates()` returns `{pass, gates[], witnesses[]}`.
- `exec.ts` — a **synchronous** sandbox (spawnSync) honoring `SANDBOX=local` /
  podman, plus combinators that run a candidate `solve` and grade it with the
  proposal's `check` in one hermetic process.
- `propose.ts` — the CLI + `proposeAndAdmit()`; files admitted classes to
  `corpus/proposed/<id>.json` and rejected ones to `corpus/rejected/<id>.json`.
- `runtime.ts` — `loadProposedClasses()` / `adaptProposed()` / `allClasses()` /
  `eligibleClasses()` / `proposerOf()`: adapt admitted proposals into playable
  `ArtifactClass` objects.

## Why Python checkers (not TS like `corpus.ts`)

The built-in corpus ships **TypeScript** checkers we hand-wrote and trust. A
proposed class arrives as **data from an untrusted model**, so its spec cannot be
TypeScript we execute in-process. It ships its checker as a Python
`check(input, output)` source run in the **same hermetic sandbox** as prover
code, and is trusted only after the gates prove it non-vacuous, self-consistent,
and non-degenerate.

## The three gates

1. **validator round-trip** — every example satisfies `inputSchema`, and the
   reference passes the proposal's own checker on all examples.
2. **mutation** — EVERY supplied mutant is caught (checker rejects it, or it
   crashes) on some example or fuzzed input. Catches vacuous specs.
3. **fuzz-difficulty** — over N=30 seeded fuzz inputs the reference passes all,
   and a platform-generated constant-output baseline (one valid reference output,
   echoed for every input) FAILS ≥30%. Catches trivially-unbreakable/degenerate
   classes.

## CLI

```
npx tsx src/verified/admission/propose.ts --proposer <model> [--sim]
```

`--sim` (or `LLM_SIM=1`) uses a deterministic canned proposal keyed by proposer
name: `hash(name)` even → an admissible class, odd → a vacuous-checker class the
mutation gate rejects. Corpus root is `CORPUS_DIR` (default `<root>/corpus`).

## Integration point (NOT wired here — do this in a separate, reviewed change)

`run.ts` / `ladder.ts` still use the built-in `CORPUS` (`classForLeg`). To let
admitted proposals be scheduled and rated, a follow-up change to `ladder.ts`
should:

1. In `planRun`, replace `classForLeg(legCounter)` with a pick over
   `eligibleClasses([prover, refuter])` (from `runtime.ts`) so a proposer's own
   class is never assigned to a leg it plays in — index it with the same
   `legCounter % pool.length` rotation for determinism.
2. Everything downstream (`match.ts`, `run.ts`, BT rating) is class-agnostic and
   needs no change: adapted classes satisfy the full `ArtifactClass` interface.

This is deliberately left as a one-step wiring change so the admission machinery
can land and be verified in isolation without touching the live real-money run
loop. `allClasses()` and `proposerOf()` are exported ready for that step.

## Exclusion rule

`eligibleClasses(models)` drops any class whose `proposer` is in `models` — no
model is examined on the class it authored (self-dealing / difficulty-setting
symmetry exploit). Built-in classes have no proposer and are always eligible.
