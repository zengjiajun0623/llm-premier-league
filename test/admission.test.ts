// M7 admission-pipeline tests. Run under LLM_SIM=1 + SANDBOX=local so the whole
// gate/adapt pipeline executes offline: canned proposals + a bare python3 sandbox.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LLM_SIM = "1";
process.env.SANDBOX = "local";

const { runGates } = await import("../src/verified/admission/gates.ts");
const {
  admissibleProposal,
  vacuousProposal,
  simProposal,
  validateAgainstSchema,
} = await import("../src/verified/admission/proposal.ts");
const { proposeAndAdmit, proposedDir, rejectedDir } = await import("../src/verified/admission/propose.ts");
const { adaptProposed, loadProposedClasses, allClasses, proposerOf, eligibleClasses } = await import(
  "../src/verified/admission/runtime.ts"
);
const { runInSandbox } = await import("../src/verified/sandbox.ts");
const { CORPUS } = await import("../src/verified/corpus.ts");

function withTmpCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), "admission-"));
  process.env.CORPUS_DIR = dir;
  return dir;
}

// --- gate (a)+(b)+(c): admissible proposal passes all three ---
test("gates: admissible proposal passes all three gates", () => {
  const cls = admissibleProposal("lab/alpha");
  const report = runGates(cls);
  for (const g of report.gates) assert.ok(g.pass, `gate ${g.name} should pass: ${g.detail}`);
  assert.ok(report.pass);
  // one witness per mutant, and each witness is a valid input
  assert.equal(report.witnesses.length, cls.mutantSrcs.length);
  for (const w of report.witnesses) assert.ok(validateAgainstSchema(w, cls.inputSchema));
});

// --- gate (b): vacuous checker rejected by mutation gate ---
test("gates: vacuous-checker proposal is rejected by the mutation gate", () => {
  const cls = vacuousProposal("lab/beta");
  const report = runGates(cls);
  assert.ok(!report.pass, "vacuous proposal must be rejected overall");
  const mutation = report.gates.find((g) => g.name === "mutation");
  assert.ok(mutation && !mutation.pass, "mutation gate must fail");
  assert.match(mutation!.detail, /not caught|vacuous/i);
  // gate (a) still passes: the all-true checker "accepts" the reference.
  const rt = report.gates.find((g) => g.name === "validator-round-trip");
  assert.ok(rt && rt.pass, "validator round-trip should pass even for a vacuous checker");
});

// --- gate (c): trivially-unbreakable class rejected by the difficulty gate ---
test("gates: trivially-unbreakable class is rejected by the difficulty gate", () => {
  // A class whose only valid input is the constant 0 -> a constant baseline
  // beats it on every fuzzed input, so it is degenerate.
  const trivial = {
    id: "always-zero",
    description: "Return 0.",
    statementTemplate: "Implement solve(n): return 0. (instance {{seed}})",
    referenceSrc: `def solve(n):\n    return 0\n`,
    // Strict enough to catch mutants, but the answer never depends on the input.
    checkerSrc: `def check(n, out):\n    return out == 0\n`,
    validatorDescription: "The integer 0.",
    inputSchema: { type: "int", min: 0, max: 0 } as const,
    exampleInputs: [0, 0, 0],
    mutantSrcs: [`def solve(n):\n    return 1\n`, `def solve(n):\n    return -1\n`],
  };
  const report = runGates(trivial);
  const diff = report.gates.find((g) => g.name === "fuzz-difficulty");
  assert.ok(diff && !diff.pass, "difficulty gate must fail for a constant-output class");
  assert.ok(!report.pass);
});

// --- propose CLI: admissible proposal lands in corpus/proposed ---
test("propose: admissible proposal is admitted to CORPUS_DIR/proposed with metadata", async () => {
  const dir = withTmpCorpus();
  // pick a proposer whose hash bucket yields the admissible canned proposal
  const proposer = "lab/admit"; // (asserted admissible below)
  const out = await proposeAndAdmit(proposer);
  assert.ok(out.admitted, `expected admission (got ${JSON.stringify((out as any).parseErrors ?? (out as any).record?.rejection?.reasons)})`);
  assert.ok(out.path && out.path.startsWith(join(dir, "proposed")));
  assert.ok(existsSync(out.path!));
  const rec = JSON.parse(readFileSync(out.path!, "utf8"));
  assert.equal(rec.admission.proposer, proposer);
  assert.ok(Array.isArray(rec.admission.gateResults) && rec.admission.gateResults.every((g: any) => g.pass));
  assert.ok(typeof rec.admission.admittedAt === "string");
  assert.equal(proposedDir(), join(dir, "proposed"));
});

// --- propose CLI: vacuous proposal is filed under rejected with a reason ---
test("propose: vacuous proposal is filed under CORPUS_DIR/rejected with a mutation reason", async () => {
  const dir = withTmpCorpus();
  const proposer = "lab/vac"; // (asserted vacuous below)
  const out = await proposeAndAdmit(proposer);
  assert.ok(!out.admitted, "vacuous proposal must be rejected");
  assert.ok(out.path && out.path.startsWith(join(dir, "rejected")));
  const rec = JSON.parse(readFileSync(out.path!, "utf8"));
  assert.ok(rec.rejection.reasons.some((r: string) => /mutation/.test(r)), `reasons: ${JSON.stringify(rec.rejection.reasons)}`);
  assert.equal(rejectedDir(), join(dir, "rejected"));
});

// The two proposer names used above must actually hash to the intended buckets,
// and simProposal must route deterministically to admissible vs vacuous.
test("sim: canned proposals split admissible vs vacuous by proposer hash", () => {
  // "lab/admit" -> admissible (strict checker); "lab/vac" -> vacuous.
  assert.ok(runGates(simProposal("lab/admit")).pass, "lab/admit must route to an admissible class");
  assert.ok(!runGates(simProposal("lab/vac")).pass, "lab/vac must route to a rejected (vacuous) class");
  // routing is a pure function of the proposer name
  assert.equal(simProposal("lab/vac").checkerSrc, vacuousProposal("lab/vac").checkerSrc);
});

// --- runtime adapter: admitted proposal becomes a playable ArtifactClass ---
test("runtime: adapter yields a playable class whose reference passes and mutant is refutable", async () => {
  withTmpCorpus();
  const proposer = "lab/admit";
  const out = await proposeAndAdmit(proposer);
  assert.ok(out.admitted);

  const admitted = loadProposedClasses();
  assert.equal(admitted.length, 1);
  const cls = admitted[0].cls;
  const inst = cls.generate(4242);
  assert.match(inst.statementForProver, /4242/); // {{seed}} substituted

  // reference passes smoke + edges under the (sync-checker) adapter, executed
  // through the async engine sandbox exactly as match.ts would.
  const ref = cls.referenceSolveSrc(inst);
  for (const input of [...cls.hiddenSmokeInputs(inst), ...cls.edgeInputs(inst)]) {
    assert.ok(cls.validateInput(input, inst), `edge/smoke must be in-envelope: ${JSON.stringify(input)}`);
    const r = await runInSandbox(ref, input, cls.envelope);
    assert.equal(r.kind, "ok", `reference crashed on ${JSON.stringify(input)}`);
    assert.ok(cls.checkOutput(input, (r as any).output, inst), `reference failed checker on ${JSON.stringify(input)}`);
  }

  // the buggy variant (mutant #0) is refutable by at least one edge input
  const buggy = cls.buggySolveSrc(inst);
  let refuted = false;
  for (const input of cls.edgeInputs(inst)) {
    const r = await runInSandbox(buggy, input, cls.envelope);
    const fails = r.kind !== "ok" || !cls.checkOutput(input, (r as any).output, inst);
    if (fails) refuted = true;
  }
  assert.ok(refuted, "buggy solution must be refutable by an in-envelope edge input");

  // the broken variant fails smoke (forfeit trigger)
  const broken = cls.brokenSolveSrc(inst);
  let smokeFail = false;
  for (const input of cls.hiddenSmokeInputs(inst)) {
    const r = await runInSandbox(broken, input, cls.envelope);
    if (r.kind !== "ok" || !cls.checkOutput(input, (r as any).output, inst)) smokeFail = true;
  }
  assert.ok(smokeFail, "broken solution should fail smoke");
});

// --- merged corpus + proposer-exclusion map ---
test("runtime: allClasses merges corpus + proposals; proposerOf + exclusion correct", async () => {
  withTmpCorpus();
  await proposeAndAdmit("lab/admit");

  const all = allClasses();
  assert.equal(all.length, CORPUS.length + 1, "merged corpus = builtins + 1 admitted");

  const owner = proposerOf();
  const proposed = loadProposedClasses()[0];
  assert.equal(owner.get(proposed.cls.id), "lab/admit");
  // built-in classes are never in the proposer map
  for (const c of CORPUS) assert.equal(owner.has(c.id), false);

  // exclusion: the proposer's own class is dropped from a leg it plays in
  const excluded = eligibleClasses(["lab/admit", "lab/other"]);
  assert.ok(!excluded.some((c) => c.id === proposed.cls.id), "proposer's own class excluded when it plays");
  assert.equal(excluded.length, CORPUS.length);

  // a leg between other models keeps the proposed class eligible
  const included = eligibleClasses(["lab/x", "lab/y"]);
  assert.ok(included.some((c) => c.id === proposed.cls.id), "class eligible when its proposer is absent");
  assert.equal(included.length, CORPUS.length + 1);
});
