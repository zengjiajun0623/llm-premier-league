// End-to-end pipeline test: runs an entire simulated league season (LLM_SIM=1,
// no network, deterministic), then checks the benchmark's core invariants and
// the viewer server's API on top of the simulated results.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Config, Season } from "../src/types.js";

process.env.LLM_SIM = "1";
const DIR = mkdtempSync(join(tmpdir(), "lpl-test-"));
process.env.RESULTS_DIR = DIR;

const { runLeague } = await import("../src/tournament.js");

const CFG: Config = {
  division: "simtest",
  competitors: ["sim/alpha", "sim/beta", "sim/gamma", "sim/delta"],
  judging: "peers",
  judgePool: ["sim/alpha"],
  judgesPerMatch: 3,
  generateTopics: true,
  topicsPerCompetitor: 5,
  debaterMaxTokens: 300,
  judgeMaxTokens: 300,
  seed: 7,
};

let season: Season;

before(async () => {
  season = await runLeague(CFG, "season-simtest-001");
});

after(() => rmSync(DIR, { recursive: true, force: true }));

test("season completes: 12 matches, placements 1-4, champion = table top", () => {
  assert.equal(season.done, true);
  assert.equal(season.matches.length, 12);
  assert.deepEqual(Object.values(season.placements).sort(), [1, 2, 3, 4]);
  assert.equal(season.champion, season.standings.League[0].model);
});

test("both legs of a pairing share the motion with sides swapped", () => {
  const byPair = new Map<string, typeof season.matches>();
  for (const m of season.matches) {
    const key = [m.home, m.away].sort().join("|");
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key)!.push(m);
  }
  assert.equal(byPair.size, 6);
  for (const [key, ms] of byPair) {
    assert.equal(ms.length, 2, `pair ${key} should meet exactly twice`);
    assert.equal(ms[0].legs[0].topic, ms[1].legs[0].topic, `pair ${key} should reuse the motion`);
    assert.equal(ms[0].legs[0].pro, ms[1].legs[0].con, `pair ${key} should swap sides`);
  }
});

test("a model never debates nor judges its own motion; judges exclude debaters", () => {
  for (const m of season.matches) {
    for (const leg of m.legs) {
      if (leg.topicProposer) {
        assert.notEqual(leg.topicProposer, leg.pro);
        assert.notEqual(leg.topicProposer, leg.con);
      }
      for (const v of leg.verdicts) {
        assert.notEqual(v.judge, leg.pro);
        assert.notEqual(v.judge, leg.con);
        if (leg.topicProposer) assert.notEqual(v.judge, leg.topicProposer);
      }
      const expected = CFG.competitors.length - 2 - (leg.topicProposer ? 1 : 0);
      assert.equal(leg.verdicts.length, expected);
    }
  }
});

test("maxJury: seeded rotating jury respects cap, exclusions, and rotates", async () => {
  const capped = await runLeague({ ...CFG, maxJury: 1, seed: 11 }, "season-simtest-002");
  const seen = new Set<string>();
  for (const m of capped.matches) {
    for (const leg of m.legs) {
      assert.equal(leg.verdicts.length, 1);
      const v = leg.verdicts[0];
      assert.notEqual(v.judge, leg.pro);
      assert.notEqual(v.judge, leg.con);
      if (leg.topicProposer) assert.notEqual(v.judge, leg.topicProposer);
      seen.add(v.judge);
    }
  }
  assert.ok(seen.size >= 3, "jury rotation should use many different peers");
});

test("interrupted season resumes to an identical result", async () => {
  const path = join(DIR, "season-simtest-001.json");
  const full = readFileSync(path, "utf8");
  const truncated: Season = JSON.parse(full);
  truncated.matches = truncated.matches.slice(0, 4);
  truncated.standings = {};
  truncated.placements = {};
  truncated.champion = null;
  truncated.done = false;
  writeFileSync(path, JSON.stringify(truncated));
  const resumed = await runLeague(CFG, "season-simtest-001");
  const orig: Season = JSON.parse(full);
  assert.deepEqual(
    resumed.matches.map((m) => [m.id, m.legs[0].topic, m.winner]),
    orig.matches.map((m) => [m.id, m.legs[0].topic, m.winner]),
    "resume must replay the same schedule, motions, and outcomes",
  );
  assert.equal(resumed.champion, orig.champion);
  writeFileSync(path, full);
});

// ---- viewer server API on top of the simulated season ----
let server: ChildProcess;
const PORT = 5600 + (process.pid % 200);

async function api(path: string): Promise<any> {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}${path}`);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server not responding on ${path}`);
}

test("server API: divisions are ordered, disjoint, and never mix Elo pools", async () => {
  // Add a second season in a different division to prove separation.
  const other: Season = JSON.parse(readFileSync(join(DIR, "season-simtest-001.json"), "utf8"));
  other.id = "season-flagship-999";
  other.config = { ...other.config, division: "flagship" };
  other.matches = other.matches.slice(0, 4).map((m) => ({
    ...m,
    legs: m.legs.map((l) => ({ ...l, pro: l.pro.replace("sim/", "big/"), con: l.con.replace("sim/", "big/"), winner: l.winner ? l.winner.replace("sim/", "big/") : null })),
    home: m.home.replace("sim/", "big/"),
    away: m.away.replace("sim/", "big/"),
    winner: m.winner ? m.winner.replace("sim/", "big/") : null,
  }));
  other.placements = {};
  other.champion = null;
  other.standings = {};
  other.groups = { League: Object.keys(other.placements) };
  writeFileSync(join(DIR, "season-flagship-999.json"), JSON.stringify(other));

  server = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, PORT: String(PORT), RESULTS_DIR: DIR },
    stdio: "ignore",
  });

  const sum = await api("/api/summary.json");
  assert.equal(sum.divisions[0].name, "flagship", "flagship division must come first");
  const names = sum.divisions.map((d: any) => d.name);
  assert.deepEqual([...new Set(names)].length, names.length);
  const pools = sum.divisions.map((d: any) => new Set(d.rankings.map((r: any) => r.model)));
  for (let i = 0; i < pools.length; i++) {
    for (let j = i + 1; j < pools.length; j++) {
      for (const m of pools[i]) assert.ok(!pools[j].has(m), `model ${m} appears in two division rankings`);
    }
  }
  for (const s of sum.seasons) assert.ok(s.division, "every season summary carries its division");
});

test("server API: debates list and detail are consistent", async () => {
  const debates = await api("/api/debates.json");
  assert.ok(debates.length >= 12);
  const d = debates[0];
  const detail = await api(`/api/debate/${d.slug}.json`);
  assert.equal(detail.topic, d.topic);
  assert.ok(Array.isArray(detail.turns) && detail.turns.length === 6);
  assert.ok(Array.isArray(detail.verdicts) && detail.verdicts.length > 0);
});

test("API_DIVISION filter: public export sees only the chosen division", async () => {
  const { allSeasons } = await import("../src/api.js");
  process.env.API_DIVISION = "flagship";
  const pub = allSeasons();
  assert.ok(pub.length >= 1);
  for (const s of pub) assert.equal((s.config as any).division, "flagship");
  delete process.env.API_DIVISION;
  assert.ok(allSeasons().length > pub.length, "unfiltered view must include the other divisions");
});

test("server API: stats expose judge votes and side splits", async () => {
  const stats = await api("/api/stats.json");
  assert.ok(stats.judges.length > 0);
  for (const j of stats.judges) {
    assert.ok(j.votes >= j.proVotes);
    assert.ok(j.decided >= j.agreed);
  }
  server.kill();
});
