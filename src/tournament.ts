import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, DebateResult, Match, Season } from "./types.js";
import { mulberry32, shuffle } from "./rng.js";
import { drawGroups, roundRobinPairs, computeStandings, knockoutPairs } from "./fixtures.js";
import { runDebate } from "./debate.js";
import { generateTopicBank } from "./topics.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
import { resultsDir } from "./paths.js";

function loadTopics(): string[] {
  return JSON.parse(readFileSync(join(ROOT, "topics.json"), "utf8"));
}

function seasonPath(id: string): string {
  return join(resultsDir(), `${id}.json`);
}

const log = (s: string) => console.log(s);

// Atomic write: the viewer server polls these files, so never let it observe
// a partially written JSON document.
function writeJson(path: string, data: object): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

async function loadOrCreateSeason(
  cfg: Config,
  seasonId: string,
  mode: "cup" | "league",
): Promise<Season> {
  const path = seasonPath(seasonId);
  if (existsSync(path)) {
    const season: Season = JSON.parse(readFileSync(path, "utf8"));
    if (!season.done) log(`Resuming ${seasonId} (${season.matches.length} matches already played)`);
    return season;
  }
  const rnd = mulberry32(cfg.seed);
  let topicBank;
  let topicCost = 0;
  if (cfg.generateTopics) {
    const gen = await generateTopicBank(cfg, log);
    topicBank = gen.bank;
    topicCost = gen.cost;
  }
  const season: Season = {
    id: seasonId,
    mode,
    startedAt: new Date().toISOString(),
    config: cfg,
    groups: mode === "cup" ? drawGroups(cfg.competitors, rnd) : { League: [...cfg.competitors] },
    topicBank,
    matches: [],
    standings: {},
    placements: {},
    champion: null,
    totalCostUsd: topicCost,
    done: false,
  };
  writeJson(path, season);
  return season;
}

interface Helpers {
  rnd: () => number;
  nextTopic: (x: string, y: string) => { topic: string; proposer?: string };
  playDebate: (label: string, t: { topic: string; proposer?: string }, pro: string, con: string) => Promise<DebateResult>;
  save: () => void;
}

function makeHelpers(season: Season, cfg: Config): Helpers {
  const save = () => writeJson(seasonPath(season.id), season);
  const writeLive = (state: object) => {
    writeJson(join(resultsDir(), "live.json"), { seasonId: season.id, updatedAt: new Date().toISOString(), ...state });
  };
  const rnd = mulberry32(cfg.seed + 1); // separate stream for topics/sides so resume stays aligned
  const staticTopics = shuffle(loadTopics(), rnd);
  let staticIdx = 0;
  const bank = season.topicBank ?? [];
  const usedBank = new Set<number>();
  // Prefer model-proposed motions, but never give a debater a motion it proposed.
  // Selection is deterministic in match order, so resume replays the same picks.
  const nextTopic = (x: string, y: string): { topic: string; proposer?: string } => {
    const i = bank.findIndex((t, idx) => !usedBank.has(idx) && t.proposer !== x && t.proposer !== y);
    if (i >= 0) {
      usedBank.add(i);
      return bank[i];
    }
    return { topic: staticTopics[staticIdx++ % staticTopics.length] };
  };

  const playDebate = async (
    label: string,
    t: { topic: string; proposer?: string },
    pro: string,
    con: string,
  ): Promise<DebateResult> => {
    const { topic, proposer } = t;
    log(`  Debate: ${pro.split("/")[1]} (PRO) vs ${con.split("/")[1]} (CON)`);
    log(`  Motion: ${topic}`);
    writeLive({ status: "debating", label, topic, proposer, pro, con, turns: [] });
    const d = await runDebate(
      cfg, topic, pro, con, log,
      (turns, status) => writeLive({ status, label, topic, proposer, pro, con, turns }),
      proposer,
    );
    d.topicProposer = proposer;
    writeLive({ status: "done", label, topic, proposer, pro, con, turns: d.turns, verdicts: d.verdicts, winner: d.winner, votesPro: d.votesPro, votesCon: d.votesCon, scorePro: d.scorePro, scoreCon: d.scoreCon });
    season.totalCostUsd += d.costUsd;
    log(`  → winner: ${d.winner ? d.winner.split("/")[1] : "DRAW"} (votes ${d.votesPro}-${d.votesCon}, scores ${d.scorePro}-${d.scoreCon}) [$${d.costUsd.toFixed(3)}]`);
    return d;
  };

  return { rnd, nextTopic, playDebate, save };
}

function finishSeason(season: Season, h: Helpers, champion: string | null): void {
  season.champion = champion;
  season.done = true;
  h.save();
  writeJson(join(resultsDir(), "live.json"), { seasonId: season.id, updatedAt: new Date().toISOString(), status: "idle", champion });
  log(`\n🏆 ${season.id} CHAMPION: ${champion} (season cost $${season.totalCostUsd.toFixed(2)})`);
}

// ---------------------------------------------------------------------------
// LEAGUE (default benchmark mode): double round-robin — every pair debates
// twice with sides swapped, so every model gets identical exposure and side
// balance. Points 3/1/0; table order = placement.
// ---------------------------------------------------------------------------
export async function runLeague(cfg: Config, seasonId: string): Promise<Season> {
  const season = await loadOrCreateSeason(cfg, seasonId, "league");
  if (season.done) return season;
  cfg = season.config; // resume must replay under the season's original config
  const h = makeHelpers(season, cfg);

  const fixtures: [string, string][] = [];
  for (const [a, b] of roundRobinPairs(cfg.competitors)) fixtures.push([a, b], [b, a]);
  const schedule = shuffle(fixtures, h.rnd);
  const played = new Set(season.matches.map((m) => m.id));

  // Both legs of a pairing debate the SAME motion with sides swapped, so
  // motion-side difficulty cancels instead of adding noise.
  const pairTopics = new Map<string, { topic: string; proposer?: string }>();

  // A flaky provider must not stall the season: failed matches are deferred
  // and retried in later passes instead of crashing the run.
  interface Fixture { pro: string; con: string; id: string; t: { topic: string; proposer?: string }; round: number }
  let queue: Fixture[] = [];
  let round = 0;
  for (const [pro, con] of schedule) {
    round++;
    const id = `league:${pro}|${con}`;
    const pairKey = [pro, con].sort().join("|");
    let t = pairTopics.get(pairKey);
    if (!t) {
      t = h.nextTopic(pro, con); // consume even when resuming, keeps the stream deterministic
      pairTopics.set(pairKey, t);
    }
    if (played.has(id)) continue;
    queue.push({ pro, con, id, t, round });
  }

  // Matches between disjoint pairs are independent: bounded concurrent pool
  // (Node is single-threaded, so matches/standings/save never interleave
  // mid-write). live.json shows one of the in-flight matches at a time.
  const CONCURRENCY = Math.max(1, Number(process.env.MATCH_CONCURRENCY ?? 3));
  for (let pass = 0; pass < 3 && queue.length; pass++) {
    const deferred: Fixture[] = [];
    let next = 0;
    const snapshot = queue;
    const worker = async () => {
      while (next < snapshot.length) {
        const f = snapshot[next++];
        log(`\n[League ${f.round}/${schedule.length}] ${f.pro.split("/")[1]} (PRO) vs ${f.con.split("/")[1]} (CON)${pass ? ` (retry pass ${pass})` : ""}`);
        try {
          const leg = await h.playDebate(`League · match ${f.round} of ${schedule.length}`, f.t, f.pro, f.con);
          season.matches.push({ id: f.id, stage: "league", home: f.pro, away: f.con, legs: [leg], winner: leg.winner });
          season.standings.League = computeStandings(cfg.competitors, season.matches);
          h.save();
        } catch (err) {
          log(`  !! match deferred (${(err as Error).message.slice(0, 120)})`);
          deferred.push(f);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, snapshot.length) }, worker));
    queue = deferred;
  }
  if (queue.length) {
    log(`\nWARNING: ${queue.length} matches unplayable after 3 passes (provider outages):`);
    for (const f of queue) log(`  - ${f.id}`);
  }
  // Integrity guard: a season only seals when nearly complete. Mass provider
  // failure (rate limits, exhausted keys) must leave the season resumable,
  // never crown a champion from a fraction of the table.
  if (season.matches.length < Math.ceil(schedule.length * 0.9)) {
    log(`Season NOT sealed: ${season.matches.length}/${schedule.length} played (< 90%). Resume when providers recover.`);
    h.save();
    return season;
  }

  season.standings.League = computeStandings(cfg.competitors, season.matches);
  season.standings.League.forEach((s, i) => (season.placements[s.model] = i + 1));
  finishSeason(season, h, season.standings.League[0].model);
  return season;
}

// ---------------------------------------------------------------------------
// CUP (spectacle mode): groups + knockout, kept for entertainment. A knockout
// tie is two legs with sides swapped; decided by leg wins, then total judge
// votes, then total scores, then seeded coin flip.
// ---------------------------------------------------------------------------
// Deterministic per-match coin flip (independent of RNG stream position, so
// resume cannot change the outcome of a fully tied knockout).
function hashCoin(id: string, seed: number): boolean {
  let h = seed | 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 2654435761);
  return (h >>> 0) % 2 === 0;
}

function tieWinner(m: Match, a: string, b: string, seed: number): string {
  let legsA = 0, legsB = 0, votesA = 0, votesB = 0, scoreA = 0, scoreB = 0;
  for (const leg of m.legs) {
    if (leg.winner === a) legsA++;
    else if (leg.winner === b) legsB++;
    votesA += leg.pro === a ? leg.votesPro : leg.votesCon;
    votesB += leg.pro === b ? leg.votesPro : leg.votesCon;
    scoreA += leg.pro === a ? leg.scorePro : leg.scoreCon;
    scoreB += leg.pro === b ? leg.scorePro : leg.scoreCon;
  }
  if (legsA !== legsB) return legsA > legsB ? a : b;
  if (votesA !== votesB) return votesA > votesB ? a : b;
  if (scoreA !== scoreB) return scoreA > scoreB ? a : b;
  return hashCoin(m.id, seed) ? a : b;
}

export async function runSeason(cfg: Config, seasonId: string): Promise<Season> {
  const season = await loadOrCreateSeason(cfg, seasonId, "cup");
  if (season.done) return season;
  cfg = season.config; // resume must replay under the season's original config
  const h = makeHelpers(season, cfg);
  const played = new Set(season.matches.map((m) => m.id));

  // Group stage: single round-robin, random sides.
  for (const [gName, models] of Object.entries(season.groups)) {
    if (gName === "League") continue;
    for (const [home, away] of roundRobinPairs(models)) {
      const id = `group-${gName}:${home}|${away}`;
      const t = h.nextTopic(home, away);
      const homeIsPro = h.rnd() < 0.5;
      if (played.has(id)) continue;
      log(`\n[Group ${gName}] ${home.split("/")[1]} vs ${away.split("/")[1]}`);
      const leg = await h.playDebate(`Group ${gName}`, t, homeIsPro ? home : away, homeIsPro ? away : home);
      season.matches.push({ id, stage: `group-${gName}`, home, away, legs: [leg], winner: leg.winner });
      h.save();
    }
  }

  for (const [gName, models] of Object.entries(season.groups)) {
    season.standings[gName] = computeStandings(
      models,
      season.matches.filter((m) => m.stage === `group-${gName}`),
    );
  }
  h.save();

  const playTie = async (stage: string, a: string, b: string): Promise<Match> => {
    const id = `${stage}:${a}|${b}`;
    const existing = season.matches.find((m) => m.id === id);
    const t1 = h.nextTopic(a, b), t2 = h.nextTopic(a, b);
    if (existing?.winner) return existing;
    log(`\n[${stage.toUpperCase()}] ${a.split("/")[1]} vs ${b.split("/")[1]} (two legs, sides swapped)`);
    const leg1 = await h.playDebate(`${stage} · leg 1`, t1, a, b);
    const leg2 = await h.playDebate(`${stage} · leg 2`, t2, b, a);
    const match: Match = { id, stage, home: a, away: b, legs: [leg1, leg2], winner: null };
    match.winner = tieWinner(match, a, b, cfg.seed);
    log(`  ⇒ ${stage} winner: ${match.winner.split("/")[1]}`);
    season.matches.push(match);
    h.save();
    return match;
  };

  let round = knockoutPairs(season.standings);
  const roundNames = round.length === 4 ? ["quarter", "semi"] : ["semi"];
  const losersByRound: string[][] = [];

  for (const roundName of roundNames) {
    const winners: string[] = [];
    const losers: string[] = [];
    for (const [a, b] of round) {
      const m = await playTie(roundName, a, b);
      winners.push(m.winner!);
      losers.push(m.winner === a ? b : a);
    }
    losersByRound.push(losers);
    round = [];
    for (let i = 0; i < winners.length; i += 2) round.push([winners[i], winners[i + 1]]);
  }

  const semiLosers = losersByRound[losersByRound.length - 1];
  const third = await playTie("third", semiLosers[0], semiLosers[1]);
  const final = await playTie("final", round[0][0], round[0][1]);

  season.placements[final.winner!] = 1;
  season.placements[final.winner === final.home ? final.away : final.home] = 2;
  season.placements[third.winner!] = 3;
  season.placements[third.winner === third.home ? third.away : third.home] = 4;
  let place = 5;
  for (let r = losersByRound.length - 2; r >= 0; r--) {
    for (const loser of losersByRound[r]) season.placements[loser] = place;
    place += losersByRound[r].length;
  }
  for (const table of Object.values(season.standings)) {
    for (const s of table.slice(2)) {
      if (!(s.model in season.placements)) season.placements[s.model] = place;
    }
  }

  finishSeason(season, h, final.winner);
  return season;
}
