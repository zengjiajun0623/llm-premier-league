// The auditor must catch, mechanically, both real incident classes from
// 2026-07-21: bad field domains / misread-prone records, and refutations via
// inputs the class validator does not admit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "lpl-audit-"));
const OLD = process.env.RESULTS_DIR;
process.env.RESULTS_DIR = DIR;
const { auditAll } = await import("../src/verified/audit.js");

function writeVerified(name: string, legs: object[]) {
  writeFileSync(join(DIR, name), JSON.stringify({ id: name, legs }));
}

test("clean verified legs audit green and produce canonical role records", () => {
  writeVerified("verified-clean.json", [
    { legId: "a", classId: "sortlist", instanceSeed: 1, prover: "x/p", refuter: "y/r", winner: "prover" },
    { legId: "b", classId: "sortlist", instanceSeed: 2, prover: "y/r", refuter: "x/p", winner: "refuter", refutingInput: [1, 2, 2] },
  ]);
  const r = auditAll();
  assert.equal(r.violations.length, 0);
  assert.deepEqual(r.roleRecords.get("x/p"), { pw: 1, pl: 0, rw: 1, rl: 0 });
  rmSync(join(DIR, "verified-clean.json"));
});

test("winner outside the role domain is a violation (the misread-report incident)", () => {
  writeVerified("verified-bad.json", [
    { legId: "c", classId: "sortlist", instanceSeed: 1, prover: "x/p", refuter: "y/r", winner: "x/p" },
  ]);
  const r = auditAll();
  assert.ok(r.violations.some((v) => v.detail.includes("winner must be a role string")));
  rmSync(join(DIR, "verified-bad.json"));
});

test("refutation via an input the validator rejects is flagged TAINTED (the lone-surrogate incident)", () => {
  writeVerified("verified-taint.json", [
    { legId: "d", classId: "textmetrics", instanceSeed: 7, prover: "x/p", refuter: "y/r", winner: "refuter", refutingInput: "\ud800" },
  ]);
  const r = auditAll();
  assert.ok(r.violations.some((v) => v.detail.includes("TAINTED")));
  rmSync(join(DIR, "verified-taint.json"));
});

test("a season sealed far below full schedule is a violation (the false-champion incident)", () => {
  const season = {
    id: "season-x", mode: "league", done: true, champion: "a/a",
    config: { competitors: ["a/a", "b/b", "c/c", "d/d"] },
    matches: [{ id: "m1", legs: [{ pro: "a/a", con: "b/b", winner: "a/a", votesPro: 3, votesCon: 1 }] }],
    standings: {}, placements: {},
  };
  writeFileSync(join(DIR, "season-x.json"), JSON.stringify(season));
  const r = auditAll();
  assert.ok(r.violations.some((v) => v.detail.includes("<90%")));
  rmSync(join(DIR, "season-x.json"));
});

test("a debate winner with fewer jury votes is a violation", () => {
  const season = {
    id: "season-y", mode: "league", done: false, champion: null,
    config: { competitors: ["a/a", "b/b", "c/c", "d/d"] },
    matches: [{ id: "m2", legs: [{ pro: "a/a", con: "b/b", winner: "a/a", votesPro: 1, votesCon: 4 }] }],
    standings: {}, placements: {},
  };
  writeFileSync(join(DIR, "season-y.json"), JSON.stringify(season));
  const r = auditAll();
  assert.ok(r.violations.some((v) => v.detail.includes("fewer votes")));
  rmSync(join(DIR, "season-y.json"));
  if (OLD) process.env.RESULTS_DIR = OLD; else delete process.env.RESULTS_DIR;
});
