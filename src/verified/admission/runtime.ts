// Runtime adaptation: turn admitted, on-disk proposals into playable
// ArtifactClass objects so match.ts can run legs on them exactly like the
// built-in corpus.
//
// The adapted checker/validator EXECUTE the proposal's Python in the sandbox:
//   - checkOutput(input, output) runs the proposal's `check(input, output)`
//     synchronously (checkOutputSync). It is the only sync sandbox call in the
//     engine, forced by ArtifactClass.checkOutput's synchronous signature; a
//     crashing/timeouting checker grades as "not verified" (false).
//   - validateInput enforces the proposal's machine inputSchema (platform-owned
//     bounds), never model-authored validator code.
//   - generate(seed) substitutes {{seed}} into the statement template.
//
// Integration into the live run loop is intentionally NOT wired here (see
// README.md "Integration point"): allClasses() / eligibleClasses() / proposerOf()
// are exported for run.ts to adopt in a later, separately reviewed change.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { CORPUS } from "../corpus.js";
import type { ArtifactClass, ProblemInstance } from "../types.js";
import { resolveEnvelope, validateAgainstSchema, type ProposedClass } from "./proposal.js";
import { checkOutputSync } from "./exec.js";
import { proposedDir } from "./propose.js";
import type { AdmittedRecord } from "./propose.js";

function jsonBytes(x: unknown): number {
  return Buffer.byteLength(JSON.stringify(x), "utf8");
}

// A broken-on-purpose solve that fails smoke (drives the forfeit path). It
// returns a value the proposal's checker will reject on every input.
const FORFEIT_SRC = `def solve(inp):\n    raise ValueError("intentionally broken solution")\n`;

export interface AdmittedClass {
  cls: ArtifactClass;
  proposer: string;
}

// Adapt one admitted record into an ArtifactClass.
export function adaptProposed(rec: AdmittedRecord): ArtifactClass {
  const p: ProposedClass = rec.class;
  const env = resolveEnvelope(p);
  const witnesses = rec.admission.witnesses ?? [];
  const cls: ArtifactClass = {
    id: p.id,
    description: p.description,
    envelope: env,
    inputGrammar: p.validatorDescription,
    generate(seed): ProblemInstance {
      return {
        classId: p.id,
        seed,
        params: {},
        boundsDescription: p.validatorDescription,
        statementForProver: p.statementTemplate.replace(/\{\{seed\}\}/g, String(seed)),
      };
    },
    validateInput(input) {
      return validateAgainstSchema(input, p.inputSchema) && jsonBytes(input) <= env.maxInputBytes;
    },
    checkOutput(input, output) {
      // Precondition Q first: out-of-bounds inputs are never valid attacks.
      if (!validateAgainstSchema(input, p.inputSchema)) return false;
      return checkOutputSync(p.checkerSrc, input, output, env);
    },
    hiddenSmokeInputs() {
      // The examples the reference provably passes (validator round-trip gate).
      return p.exampleInputs;
    },
    edgeInputs() {
      // Examples + stored mutant witnesses: guarantees an in-envelope input that
      // refutes buggySolveSrc (mutant #0), satisfying the ArtifactClass contract.
      return [...p.exampleInputs, ...witnesses];
    },
    referenceSolveSrc() {
      return p.referenceSrc;
    },
    buggySolveSrc() {
      return p.mutantSrcs[0];
    },
    brokenSolveSrc() {
      return FORFEIT_SRC;
    },
  };
  return cls;
}

// Read every admitted proposal from corpus/proposed/*.json.
export function loadProposedClasses(): AdmittedClass[] {
  const dir = proposedDir();
  if (!existsSync(dir)) return [];
  const out: AdmittedClass[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const rec = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as AdmittedRecord;
    out.push({ cls: adaptProposed(rec), proposer: rec.admission.proposer });
  }
  return out;
}

// Merged corpus: built-in classes + admitted proposals.
export function allClasses(): ArtifactClass[] {
  return [...CORPUS, ...loadProposedClasses().map((a) => a.cls)];
}

// classId -> proposer, for admitted proposals only (built-ins are absent).
export function proposerOf(): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of loadProposedClasses()) m.set(a.cls.id, a.proposer);
  return m;
}

// Classes eligible for a leg among `models`: a proposer's OWN class is excluded
// from any leg where that model plays (as prover or refuter) -- no model is
// tested on the exam it wrote. Built-in classes are always eligible.
export function eligibleClasses(models: string[]): ArtifactClass[] {
  const owner = proposerOf();
  const playing = new Set(models);
  return allClasses().filter((c) => {
    const proposer = owner.get(c.id);
    return proposer === undefined || !playing.has(proposer);
  });
}
