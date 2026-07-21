// Frontend consistency checks: the inline script must parse, and must not
// reference API fields the server no longer serves (the class of bug where the
// leaderboard silently mixed divisions came from exactly such a drift).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const html = readFileSync(join(ROOT, "public", "index.html"), "utf8");
const script = html.match(/<script>([\s\S]*)<\/script>/)![1];

test("inline script parses", () => {
  new Function(script); // throws on syntax error
});

test("frontend does not use retired top-level API fields", () => {
  assert.ok(!script.includes("summaryCache.rankings"), "use summaryCache.divisions, not the retired flat rankings field");
  assert.ok(!script.includes("sum.rankings"), "use sum.divisions, not the retired flat rankings field");
});

test("every fetch() path the frontend uses exists in the server routes", () => {
  const serverSrc = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
  const paths = [...script.matchAll(/fetch\("(\/api\/[a-z./]+)/g)].map((m) => m[1].replace(/\/$/, ""));
  assert.ok(paths.length >= 4);
  for (const p of new Set(paths)) {
    assert.ok(serverSrc.includes(p), `server must route ${p}`);
  }
});

test("new verified + gap endpoints are fetched, routed, and exported", () => {
  const serverSrc = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
  const exportSrc = readFileSync(join(ROOT, "src", "export.ts"), "utf8");
  for (const p of ["/api/verified.json", "/api/gap.json"]) {
    assert.ok(script.includes('fetch("' + p), `frontend must fetch ${p}`);
    assert.ok(serverSrc.includes(p), `server must route ${p}`);
    assert.ok(exportSrc.includes(p.slice("/api/".length)), `export must emit ${p}`);
  }
});

// ---- api.verifiedSummary() / api.gapTable() shape checks against real data ----

const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);

test("verifiedSummary() on the pilot file yields two ladders + finite composite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fe-verified-"));
  process.env.RESULTS_DIR = dir;
  copyFileSync(join(ROOT, "results", "verified-verified-pilot-001.json"), join(dir, "verified-verified-pilot-001.json"));
  const { verifiedSummary } = await import("../src/api.ts");
  const v = verifiedSummary();

  assert.ok(Array.isArray(v.prover) && Array.isArray(v.refuter), "two ladders present");
  assert.equal(v.prover.length, v.roster.length);
  assert.equal(v.refuter.length, v.roster.length);
  // Same models in both ladders (different orderings are permitted, not required).
  const pm = new Set(v.prover.map((x) => x.model));
  const rm = new Set(v.refuter.map((x) => x.model));
  assert.equal(pm.size, rm.size);
  for (const m of pm) assert.ok(rm.has(m), "refuter ladder covers same models");

  assert.ok(v.composite.length > 0, "composite present");
  for (const c of v.composite) {
    assert.ok(finite(c.composite) && finite(c.prover) && finite(c.refuter), "composite ratings finite");
    assert.ok(finite(c.lo) && finite(c.hi), "composite range finite");
  }
  for (const r of [...v.prover, ...v.refuter]) assert.ok(finite(r.rating), "every ladder rating finite");
  assert.ok(finite(v.ratedLegs) && v.ratedLegs > 0, "some legs rated");
});

test("gapTable() returns well-formed overlap rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fe-gap-"));
  process.env.RESULTS_DIR = dir;
  // Flagship persuasion board from a real season file.
  copyFileSync(join(ROOT, "results", "season-league-001.json"), join(dir, "season-league-001.json"));
  const season = JSON.parse(readFileSync(join(dir, "season-league-001.json"), "utf8")) as {
    matches: { home: string; away: string }[];
  };
  const models = [...new Set(season.matches.flatMap((m) => [m.home, m.away]))].slice(0, 3);
  assert.ok(models.length >= 2, "season has models to overlap on");
  // Synthetic verified run over the same models so both boards share a roster.
  const legs: unknown[] = [];
  let k = 0;
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < models.length; i++) {
      for (let j = i + 1; j < models.length; j++) {
        const prover = round % 2 ? models[i] : models[j];
        const refuter = round % 2 ? models[j] : models[i];
        legs.push({ legId: "syn-" + k, classId: "sortlist", instanceSeed: 1, prover, refuter, winner: k % 2 ? "prover" : "refuter", costUsd: 0, transcript: { proverSrc: "", candidates: [] } });
        k++;
      }
    }
  }
  writeFileSync(join(dir, "verified-syn-001.json"), JSON.stringify({ id: "syn-001", createdAt: "", updatedAt: "", rounds: 3, roster: models, sandbox: "local", refuterBudgetK: 10, legs }));

  const { gapTable } = await import("../src/api.ts");
  const rows = gapTable();
  assert.ok(Array.isArray(rows) && rows.length >= 1, "at least one overlapping model");
  for (const r of rows) {
    assert.equal(typeof r.model, "string");
    assert.ok(finite(r.verifiedRank) && r.verifiedRank >= 1);
    assert.ok(finite(r.persuasionRank) && r.persuasionRank >= 1);
    assert.equal(r.delta, r.verifiedRank - r.persuasionRank);
    assert.equal(typeof r.notable, "boolean");
    assert.equal(r.notable, Math.abs(r.delta) >= 3);
  }
});
