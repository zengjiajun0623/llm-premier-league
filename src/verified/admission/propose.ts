// Admission CLI: prompt a model to propose a new artifact class, gate it
// mechanically, and file the verdict on disk.
//
//   npx tsx src/verified/admission/propose.ts --proposer <model> [--sim]
//
// On PASS -> corpus/proposed/<id>.json with admission metadata.
// On FAIL -> corpus/rejected/<id>.json with the failing-gate reasons.
//
// Corpus root is CORPUS_DIR (default <root>/corpus). LLM_SIM=1 (or --sim) skips
// the model call and uses a deterministic canned proposal keyed by proposer name
// (one admissible, one whose vacuous checker the mutation gate rejects).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../paths.js";
import { chat } from "../../openrouter.js";
import { runGates, type GateResult } from "./gates.js";
import {
  PROPOSAL_SCHEMA_DOC,
  simProposal,
  validateProposedShape,
  type ProposedClass,
} from "./proposal.js";

export function corpusDir(): string {
  return process.env.CORPUS_DIR ?? join(ROOT, "corpus");
}
export function proposedDir(): string {
  return join(corpusDir(), "proposed");
}
export function rejectedDir(): string {
  return join(corpusDir(), "rejected");
}

export interface AdmissionMeta {
  proposer: string;
  gateResults: GateResult[];
  admittedAt: string;
  // One catching input per mutant, so the runtime adapter can hand the sim
  // refuter a guaranteed refutation of the class's first mutant.
  witnesses: unknown[];
}

export interface AdmittedRecord {
  class: ProposedClass;
  admission: AdmissionMeta;
}

export interface RejectedRecord {
  class: ProposedClass;
  rejection: {
    proposer: string;
    rejectedAt: string;
    reasons: string[];
    gateResults: GateResult[];
  };
}

export type ProposeOutcome =
  | { admitted: true; path: string; record: AdmittedRecord }
  | { admitted: false; path: string; record: RejectedRecord }
  | { admitted: false; path: null; parseErrors: string[] };

// Ask the proposer model for a class (real mode) or use the canned sim proposal.
async function getProposal(proposer: string): Promise<{ ok: true; cls: ProposedClass } | { ok: false; errors: string[] }> {
  if (process.env.LLM_SIM === "1") return { ok: true, cls: simProposal(proposer) };
  const prompt =
    `You are proposing a new artifact class for an autonomous adversarial code-refutation ` +
    `benchmark. The class defines a self-contained task plus an executable checker that ` +
    `grades any answer. It must survive three mechanical gates: your checker must accept ` +
    `your reference on your examples, catch every mutant you provide, and reject a trivial ` +
    `constant-output program on most inputs.\n\n${PROPOSAL_SCHEMA_DOC}`;
  const r = await chat(proposer, [{ role: "user", content: prompt }], 3000, { json: true });
  let parsed: unknown;
  try {
    const t = r.text.replace(/```(?:json)?\s*\n?([\s\S]*?)```/i, "$1").trim();
    parsed = JSON.parse(t);
  } catch (err) {
    return { ok: false, errors: [`proposal was not valid JSON: ${(err as Error).message.slice(0, 120)}`] };
  }
  const shape = validateProposedShape(parsed);
  return shape.ok ? { ok: true, cls: shape.value } : { ok: false, errors: shape.errors };
}

// Propose a class and file the verdict. Returns the outcome (for tests / callers).
export async function proposeAndAdmit(proposer: string): Promise<ProposeOutcome> {
  const got = await getProposal(proposer);
  if (!got.ok) return { admitted: false, path: null, parseErrors: got.errors };
  const cls = got.cls;

  const report = runGates(cls);

  if (report.pass) {
    mkdirSync(proposedDir(), { recursive: true });
    const record: AdmittedRecord = {
      class: cls,
      admission: {
        proposer,
        gateResults: report.gates,
        admittedAt: new Date().toISOString(),
        witnesses: report.witnesses,
      },
    };
    const path = join(proposedDir(), `${cls.id}.json`);
    writeFileSync(path, JSON.stringify(record, null, 2));
    return { admitted: true, path, record };
  }

  mkdirSync(rejectedDir(), { recursive: true });
  const reasons = report.gates.filter((g) => !g.pass).map((g) => `${g.name}: ${g.detail}`);
  const record: RejectedRecord = {
    class: cls,
    rejection: { proposer, rejectedAt: new Date().toISOString(), reasons, gateResults: report.gates },
  };
  const path = join(rejectedDir(), `${cls.id}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2));
  return { admitted: false, path, record };
}

function parseArgs(argv: string[]): { proposer: string; sim: boolean } {
  let proposer = "";
  let sim = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--proposer") proposer = argv[++i];
    else if (argv[i] === "--sim") sim = true;
  }
  return { proposer, sim };
}

async function main() {
  const { proposer, sim } = parseArgs(process.argv.slice(2));
  if (!proposer) {
    console.error("usage: propose.ts --proposer <model> [--sim]");
    process.exit(2);
  }
  if (sim) process.env.LLM_SIM = "1";
  console.log(`Proposing a class from ${proposer} (${process.env.LLM_SIM === "1" ? "SIM" : "live"}) ...`);
  const out = await proposeAndAdmit(proposer);
  if (out.path === null) {
    console.error(`REJECTED (malformed proposal):\n  ${out.parseErrors.join("\n  ")}`);
    process.exit(1);
  }
  if (out.admitted) {
    console.log(`ADMITTED -> ${out.path}`);
    for (const g of out.record.admission.gateResults) console.log(`  [pass] ${g.name}: ${g.detail}`);
  } else {
    console.log(`REJECTED -> ${out.path}`);
    for (const g of out.record.rejection.gateResults) console.log(`  [${g.pass ? "pass" : "FAIL"}] ${g.name}: ${g.detail}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
