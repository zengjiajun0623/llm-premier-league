// League-1 (verified) tests. Run with LLM_SIM=1 and SANDBOX=local so the whole
// pipeline executes offline: fake models + a bare python3 subprocess sandbox.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LLM_SIM = "1";
process.env.SANDBOX = "local";

const { CORPUS } = await import("../src/verified/corpus.ts");
const { runLeg, simProverKind } = await import("../src/verified/match.ts");
const { runInSandbox } = await import("../src/verified/sandbox.ts");
const { executeRun } = await import("../src/verified/run.ts");
const { computeLadders, planRun } = await import("../src/verified/ladder.ts");

const SMALL_ROSTER = ["lab/alpha", "lab/beta", "lab/gamma", "lab/delta"];

function withTmpResults(): string {
  const dir = mkdtempSync(join(tmpdir(), "verified-"));
  process.env.RESULTS_DIR = dir;
  return dir;
}

// --- per-class checker discrimination (reference passes, buggy is refutable) ---
for (const cls of CORPUS) {
  test(`corpus/${cls.id}: reference solution passes smoke + edges`, async () => {
    const inst = cls.generate(12345);
    const ref = cls.referenceSolveSrc(inst);
    for (const input of [...cls.hiddenSmokeInputs(inst), ...cls.edgeInputs(inst)]) {
      const out = await runInSandbox(ref, input, cls.envelope);
      assert.equal(out.kind, "ok", `reference crashed on ${JSON.stringify(input)}: ${JSON.stringify(out)}`);
      assert.ok(
        cls.checkOutput(input, (out as any).output, inst),
        `reference FAILED checker on ${JSON.stringify(input)} -> ${JSON.stringify((out as any).output)}`,
      );
    }
  });

  test(`corpus/${cls.id}: buggy solution passes smoke but is refutable by an in-envelope input`, async () => {
    const inst = cls.generate(9876);
    const buggy = cls.buggySolveSrc(inst);
    // passes smoke
    for (const input of cls.hiddenSmokeInputs(inst)) {
      const out = await runInSandbox(buggy, input, cls.envelope);
      assert.equal(out.kind, "ok", `buggy crashed on smoke ${JSON.stringify(input)}`);
      assert.ok(cls.checkOutput(input, (out as any).output, inst), `buggy should pass smoke ${JSON.stringify(input)}`);
    }
    // at least one edge input refutes it
    let refuted = false;
    for (const input of cls.edgeInputs(inst)) {
      assert.ok(cls.validateInput(input, inst), `edge input must be in-envelope: ${JSON.stringify(input)}`);
      const out = await runInSandbox(buggy, input, cls.envelope);
      const fails = out.kind !== "ok" || !cls.checkOutput(input, (out as any).output, inst);
      if (fails) refuted = true;
    }
    assert.ok(refuted, `no in-envelope edge input refuted the buggy ${cls.id} solution`);
  });

  test(`corpus/${cls.id}: broken solution fails smoke (forfeit trigger)`, async () => {
    const inst = cls.generate(555);
    const broken = cls.brokenSolveSrc(inst);
    let smokeFail = false;
    for (const input of cls.hiddenSmokeInputs(inst)) {
      const out = await runInSandbox(broken, input, cls.envelope);
      if (out.kind !== "ok" || !cls.checkOutput(input, (out as any).output, inst)) smokeFail = true;
    }
    assert.ok(smokeFail, `broken ${cls.id} solution should fail at least one smoke input`);
  });
}

// --- single-leg paths: forfeit + refutation reproducibility ---
test("leg: broken prover forfeits (smoke gate), leg goes to refuter", async () => {
  const cls = CORPUS[0]; // sortlist
  // find a (model, seed) whose sim prover is broken
  let found: { model: string; seed: number } | null = null;
  outer: for (const model of SMALL_ROSTER) {
    for (let seed = 1; seed < 200; seed++) {
      const inst = cls.generate(seed);
      if (simProverKind(model, cls, inst) === "broken") {
        found = { model, seed };
        break outer;
      }
    }
  }
  assert.ok(found, "expected some (model,seed) to yield a broken sim prover");
  const inst = cls.generate(found!.seed);
  const res = await runLeg({ legId: "t-forfeit", cls, instance: inst, prover: found!.model, refuter: "lab/ref" });
  assert.equal(res.proverForfeit, true);
  assert.equal(res.winner, "refuter");
  assert.ok(res.forfeitReason, "forfeit should carry a reason");
});

test("leg: buggy prover is refuted with a reproducible input (winner refuter)", async () => {
  const cls = CORPUS[0]; // sortlist
  let found: { model: string; seed: number } | null = null;
  outer: for (const model of SMALL_ROSTER) {
    for (let seed = 1; seed < 200; seed++) {
      const inst = cls.generate(seed);
      if (simProverKind(model, cls, inst) === "buggy") {
        found = { model, seed };
        break outer;
      }
    }
  }
  assert.ok(found, "expected some (model,seed) to yield a buggy sim prover");
  const inst = cls.generate(found!.seed);
  const res = await runLeg({ legId: "t-refute", cls, instance: inst, prover: found!.model, refuter: "lab/ref" });
  assert.equal(res.winner, "refuter");
  assert.notEqual(res.refutingInput, undefined);
  // the recorded refuting input genuinely breaks P (independent re-run)
  const out = await runInSandbox(res.transcript.proverSrc, res.refutingInput, cls.envelope);
  const broke = out.kind !== "ok" || !cls.checkOutput(res.refutingInput, (out as any).output, inst);
  assert.ok(broke, "recorded refutingInput must actually break the prover");
});

test("leg: correct prover survives (winner prover, no refutingInput)", async () => {
  const cls = CORPUS[0];
  let found: { model: string; seed: number } | null = null;
  outer: for (const model of SMALL_ROSTER) {
    for (let seed = 1; seed < 200; seed++) {
      const inst = cls.generate(seed);
      if (simProverKind(model, cls, inst) === "correct") {
        found = { model, seed };
        break outer;
      }
    }
  }
  assert.ok(found);
  const inst = cls.generate(found!.seed);
  const res = await runLeg({ legId: "t-correct", cls, instance: inst, prover: found!.model, refuter: "lab/ref" });
  assert.equal(res.winner, "prover");
  assert.equal(res.refutingInput, undefined);
  assert.ok(!res.proverForfeit);
});

// --- full sim ladder end-to-end ---
test("e2e: full sim ladder (small roster, 1 round) with two BT ladders", async () => {
  withTmpResults();
  const t0 = Date.now();
  const file = await executeRun({ id: "e2e", rounds: 1, roster: SMALL_ROSTER });
  const elapsedMs = Date.now() - t0;

  // legs produced: C(4,2) = 6 for 1 round
  const plan = planRun("e2e", SMALL_ROSTER, 1);
  assert.equal(plan.length, 6);
  assert.equal(file.legs.length, 6);

  // no ties: every rated leg has a definite winner
  for (const leg of file.legs) {
    assert.ok(leg.winner === "prover" || leg.winner === "refuter", "no ties allowed");
    // winner consistency vs sandbox evidence
    if (leg.void) continue;
    if (leg.winner === "refuter") {
      assert.ok(leg.proverForfeit || leg.refutingInput !== undefined, "refuter win needs forfeit or refutingInput");
    } else {
      assert.equal(leg.refutingInput, undefined, "prover win must not carry a refutingInput");
    }
  }

  // two-ladder BT output shape
  const table = computeLadders(file.legs, SMALL_ROSTER);
  assert.equal(table.prover.length, SMALL_ROSTER.length);
  assert.equal(table.refuter.length, SMALL_ROSTER.length);
  assert.equal(table.composite.length, SMALL_ROSTER.length);
  for (const row of table.composite) {
    assert.ok(typeof row.composite === "number" && Number.isFinite(row.composite));
    assert.ok(typeof row.prover === "number" && typeof row.refuter === "number");
  }

  console.log(`  [e2e wall-clock] ${elapsedMs} ms for ${file.legs.length} legs`);
});

// --- resume determinism ---
test("e2e: resume after truncation reproduces identical legs", async () => {
  const dir = withTmpResults();
  const full = await executeRun({ id: "resume", rounds: 1, roster: SMALL_ROSTER });
  const path = join(dir, "verified-resume.json");
  const snapshot = JSON.parse(readFileSync(path, "utf8"));

  // truncate: drop the last 3 legs, rewrite, then resume
  const truncated = { ...snapshot, legs: snapshot.legs.slice(0, snapshot.legs.length - 3) };
  writeFileSync(path, JSON.stringify(truncated, null, 2));

  const resumed = await executeRun({ id: "resume", rounds: 1, roster: SMALL_ROSTER });
  assert.equal(resumed.legs.length, full.legs.length);
  for (let i = 0; i < full.legs.length; i++) {
    assert.equal(resumed.legs[i].legId, full.legs[i].legId);
    assert.equal(resumed.legs[i].winner, full.legs[i].winner);
    assert.deepEqual(resumed.legs[i].refutingInput, full.legs[i].refutingInput);
    assert.equal(resumed.legs[i].proverForfeit, full.legs[i].proverForfeit);
  }
});
