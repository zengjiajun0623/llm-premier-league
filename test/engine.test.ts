import { test } from "node:test";
import assert from "node:assert/strict";
import { roundRobinPairs, computeStandings, knockoutPairs } from "../src/fixtures.js";
import { aggregate, divisionOf } from "../src/report.js";
import { rateBT, type BtLeg } from "../src/bt.js";
import { selectJury, familyOf } from "../src/judge.js";
import type { Config, Match, Season, Standing } from "../src/types.js";

const JCFG: Config = {
  division: "t", competitors: [
    "anthropic/fable", "anthropic/opus", "openai/gpt", "google/gemini",
    "x-ai/grok", "deepseek/v4", "qwen/max", "moonshot/kimi",
  ],
  judging: "peers", judgePool: [], judgesPerMatch: 3, maxJury: 5, minJury: 3,
  generateTopics: false, topicsPerCompetitor: 0, debaterMaxTokens: 0, judgeMaxTokens: 0, seed: 3,
};

function fakeLeg(pro: string, con: string, winner: string | null, scorePro = 100, scoreCon = 90) {
  return { topic: "t", pro, con, turns: [], verdicts: [], winner, votesPro: 2, votesCon: 1, scorePro, scoreCon, costUsd: 0 };
}

function fakeMatch(id: string, stage: string, home: string, away: string, winner: string | null, legs = [fakeLeg(home, away, winner)]): Match {
  return { id, stage, home, away, legs, winner };
}

test("roundRobinPairs: n models -> n*(n-1)/2 pairs", () => {
  assert.equal(roundRobinPairs(["a", "b", "c", "d"]).length, 6);
  assert.equal(roundRobinPairs(["a", "b", "c", "d", "e"]).length, 10);
});

test("computeStandings: points, draws, score diff", () => {
  const models = ["a", "b", "c", "d"];
  const matches = [
    fakeMatch("1", "league", "a", "b", "a"),
    fakeMatch("2", "league", "c", "d", null, [fakeLeg("c", "d", null, 95, 95)]),
  ];
  const table = computeStandings(models, matches);
  const get = (m: string): Standing => table.find((s) => s.model === m)!;
  assert.equal(get("a").points, 3);
  assert.equal(get("b").points, 0);
  assert.equal(get("c").points, 1);
  assert.equal(get("d").points, 1);
  assert.equal(get("a").scoreDiff, 10);
  assert.equal(get("c").draws, 1);
});

test("computeStandings: aggregate head-to-head breaks equal points and diff", () => {
  const models = ["a", "b"];
  // Two meetings: a beats b both times but with symmetric scores so diff is 0
  // and points differ... to force the h2h path, give each one win with equal
  // diff: a beat b (+10), b beat a (+10) -> equal points/diff, h2h 1-1 -> alphabetical.
  const even = computeStandings(models, [
    fakeMatch("1", "league", "a", "b", "a", [fakeLeg("a", "b", "a", 100, 90)]),
    fakeMatch("2", "league", "b", "a", "b", [fakeLeg("b", "a", "b", 100, 90)]),
  ]);
  assert.deepEqual(even.map((s) => s.model), ["a", "b"]); // alphabetical fallback
});

test("knockoutPairs: single group of 4 -> 1v4, 2v3", () => {
  const standings = {
    A: ["m1", "m2", "m3", "m4"].map((m) => ({ model: m, played: 3, wins: 0, draws: 0, losses: 0, points: 0, scoreDiff: 0 })),
  };
  assert.deepEqual(knockoutPairs(standings), [["m1", "m4"], ["m2", "m3"]]);
});

function fakeSeason(id: string, division: string, matches: Match[], placements: Record<string, number> = {}, done = true): Season {
  return {
    id,
    mode: "league",
    startedAt: "2026-01-01",
    config: { division, competitors: [], judging: "peers", judgePool: [], judgesPerMatch: 0, generateTopics: false, topicsPerCompetitor: 0, debaterMaxTokens: 0, judgeMaxTokens: 0, seed: 1 },
    groups: {},
    matches,
    standings: {},
    placements,
    champion: null,
    totalCostUsd: 0,
    done,
  };
}

test("aggregate: draws are counted as draws, not losses", () => {
  const season = fakeSeason("season-x-001", "test", [
    fakeMatch("1", "league", "a", "b", null, [fakeLeg("a", "b", null)]),
    fakeMatch("2", "league", "a", "b", "a", [fakeLeg("a", "b", "a")]),
  ]);
  const agg = aggregate([season]);
  const a = agg.find((x) => x.model === "a")!;
  assert.equal(a.debates, 2);
  assert.equal(a.debateWins, 1);
  assert.equal(a.debateDraws, 1);
});

test("aggregate: bootstrap CI is deterministic and brackets the point estimate", () => {
  const matches = Array.from({ length: 10 }, (_, i) =>
    fakeMatch(String(i), "league", "a", "b", i % 3 === 0 ? "b" : "a"),
  );
  const season = fakeSeason("season-x-001", "test", matches);
  const r1 = aggregate([season]);
  const r2 = aggregate([season]);
  assert.deepEqual(r1, r2);
  const a = r1.find((x) => x.model === "a")!;
  assert.ok(a.eloLo <= a.elo && a.elo <= a.eloHi, `CI ${a.eloLo}..${a.eloHi} should bracket ${a.elo}`);
});

test("rateBT: recovers strength order and PRO-side advantage", () => {
  const models = ["A", "B", "C"];
  const strength: Record<string, number> = { A: 1.2, B: 0, C: -1.2 };
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647), seed / 2147483647);
  const legs: BtLeg[] = [];
  for (let k = 0; k < 90; k++) {
    const pro = models[k % 3], con = models[(k + 1) % 3];
    const p = 1 / (1 + Math.exp(-((strength[pro] - strength[con]) + 0.4)));
    let v = 0; for (let j = 0; j < 5; j++) if (rnd() < p) v++;
    legs.push({ pro, con, y: v / 5, cluster: `${[pro, con].sort().join()}-${Math.floor(k / 2)}` });
  }
  const r = rateBT(legs, models, 60);
  assert.deepEqual(r.map((x) => x.model), ["A", "B", "C"], "BT must recover A>B>C");
  assert.ok(r[0].rating - r[2].rating > 150, "A should be well above C on the Elo scale");
});

test("rateBT: unplayed / disconnected models are flagged provisional", () => {
  const models = ["A", "B", "C", "Island"];
  const legs: BtLeg[] = [
    { pro: "A", con: "B", y: 0.8, cluster: "ab" },
    { pro: "B", con: "C", y: 0.6, cluster: "bc" },
    { pro: "C", con: "A", y: 0.4, cluster: "ca" },
  ];
  const r = rateBT(legs, models, 30);
  assert.equal(r.find((x) => x.model === "Island")!.provisional, true);
  assert.equal(r.find((x) => x.model === "A")!.provisional, false);
});

test("rateBT is deterministic (seeded bootstrap)", () => {
  const legs: BtLeg[] = [
    { pro: "A", con: "B", y: 0.8, cluster: "ab1" },
    { pro: "B", con: "A", y: 0.4, cluster: "ab1" },
    { pro: "B", con: "C", y: 0.6, cluster: "bc1" },
    { pro: "C", con: "B", y: 0.5, cluster: "bc1" },
  ];
  assert.deepEqual(rateBT(legs, ["A", "B", "C"], 40), rateBT(legs, ["A", "B", "C"], 40));
});

test("aggregate exposes a BT rating and provisional flag", () => {
  const matches = Array.from({ length: 8 }, (_, i) =>
    fakeMatch(String(i), "league", i % 2 ? "a" : "b", i % 2 ? "b" : "a", "a"),
  );
  const agg = aggregate([fakeSeason("season-x-001", "test", matches)]);
  assert.ok(typeof agg[0].rating === "number");
  assert.ok("provisional" in agg[0]);
});

test("selectJury: excludes debaters, proposer, and their lab families", () => {
  const jury = selectJury(JCFG, "motion text", "anthropic/fable", "openai/gpt", "google/gemini");
  assert.ok(!jury.includes("anthropic/fable") && !jury.includes("openai/gpt"));
  assert.ok(!jury.includes("google/gemini"), "proposer excluded");
  // No Anthropic or OpenAI kin on the jury (fable's and gpt's families banned).
  assert.ok(!jury.some((j) => familyOf(j, JCFG) === "anthropic"), "no anthropic kin (opus) judges an anthropic debate");
  assert.ok(!jury.some((j) => familyOf(j, JCFG) === "openai"));
  assert.ok(jury.length <= JCFG.maxJury!);
});

test("selectJury: deterministic and resume-stable", () => {
  const a = selectJury(JCFG, "m", "x-ai/grok", "deepseek/v4");
  const b = selectJury(JCFG, "m", "x-ai/grok", "deepseek/v4");
  assert.deepEqual(a, b);
});

test("selectJury: family exclusion relaxes if it would starve the jury", () => {
  const small: Config = { ...JCFG, competitors: ["anthropic/a", "anthropic/b", "anthropic/c", "openai/x"], minJury: 3 };
  // Debate a vs x: banning anthropic+openai leaves 0 eligible -> relax to keep b,c.
  const jury = selectJury(small, "m", "anthropic/a", "openai/x");
  assert.ok(jury.length >= 1, "must still field a jury on a tiny roster");
});

test("divisionOf: config wins, cheap ids fall back to dev, else flagship", () => {
  assert.equal(divisionOf(fakeSeason("season-league-001", "flagship", [])), "flagship");
  const legacy = fakeSeason("season-cheap-001", "x", []);
  delete (legacy.config as { division?: string }).division;
  assert.equal(divisionOf(legacy), "dev");
  const legacy2 = fakeSeason("season-league-002", "x", []);
  delete (legacy2.config as { division?: string }).division;
  assert.equal(divisionOf(legacy2), "flagship");
});
