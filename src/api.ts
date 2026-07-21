// Shared read-side API: used by the live viewer server (src/server.ts) and the
// static exporter (src/export.ts), so localhost and the public site are
// guaranteed to serve identical data shapes.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Season } from "./types.js";
import { aggregate, divisionOf } from "./report.js";
import { resultsDir } from "./paths.js";
import { computeStandings } from "./fixtures.js";
import { computeLadders } from "./verified/ladder.js";
import type { LegResult } from "./verified/types.js";
import type { RunFile } from "./verified/run.js";

export function allSeasons(): Season[] {
  const out: Season[] = [];
  for (const f of readdirSync(resultsDir())) {
    if (!f.startsWith("season-") || !f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(resultsDir(), f), "utf8")) as Season);
    } catch (err) {
      console.error(`skipping unreadable ${f}: ${(err as Error).message}`);
    }
  }
  // API_DIVISION=flagship makes the public export a single league: internal
  // dev/test seasons never reach the published site.
  const only = process.env.API_DIVISION;
  const filtered = only ? out.filter((s) => divisionOf(s) === only) : out;
  return filtered.sort((a, b) => a.id.localeCompare(b.id));
}

// Stable short id for one debate, usable as a static filename.
export function slugOf(seasonId: string, matchId: string, leg: number): string {
  const s = `${seasonId}|${matchId}|${leg}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// Season summaries without full transcripts (keeps polling payload small).
export function summary() {
  const seasons = allSeasons();
  const byDiv = new Map<string, Season[]>();
  for (const s of seasons) {
    const d = divisionOf(s);
    if (!byDiv.has(d)) byDiv.set(d, []);
    byDiv.get(d)!.push(s);
  }
  return {
    // Elo updates live, debate by debate; titles/podiums/placements only count
    // once a season is done. Divisions never mix: their Elo pools are incomparable.
    divisions: [...byDiv.entries()]
      .sort(([a], [b]) => (a === "flagship" ? -1 : b === "flagship" ? 1 : a.localeCompare(b)))
      .map(([name, ss]) => ({ name, rankings: aggregate(ss) })),
    seasons: seasons.map((s) => ({
      id: s.id,
      division: divisionOf(s),
      done: s.done,
      groups: s.groups,
      // Live standings: compute from matches played so far if the season hasn't sealed them yet.
      standings: Object.keys(s.standings).length
        ? s.standings
        : Object.fromEntries(
            Object.entries(s.groups).map(([g, models]) => [
              g,
              computeStandings(models, s.matches.filter((m) => m.stage === `group-${g}`)),
            ]),
          ),
      champion: s.champion,
      placements: s.placements,
      totalCostUsd: s.totalCostUsd,
      matches: s.matches.map((m) => ({
        id: m.id,
        stage: m.stage,
        home: m.home,
        away: m.away,
        winner: m.winner,
        legs: m.legs.map((l) => ({
          topic: l.topic,
          pro: l.pro,
          con: l.con,
          winner: l.winner,
          votesPro: l.votesPro,
          votesCon: l.votesCon,
          scorePro: l.scorePro,
          scoreCon: l.scoreCon,
        })),
      })),
    })),
  };
}

// Chronological list of every debate across all seasons (no transcripts).
export function debateList() {
  const out: object[] = [];
  for (const s of allSeasons()) {
    for (const m of s.matches) {
      m.legs.forEach((l, leg) => {
        out.push({
          slug: slugOf(s.id, m.id, leg),
          season: s.id,
          stage: m.stage,
          matchId: m.id,
          leg,
          topic: l.topic,
          proposer: l.topicProposer,
          pro: l.pro,
          con: l.con,
          winner: l.winner,
          votesPro: l.votesPro,
          votesCon: l.votesCon,
          scorePro: l.scorePro,
          scoreCon: l.scoreCon,
        });
      });
    }
  }
  return out;
}

export function debateDetail(slug: string) {
  for (const s of allSeasons()) {
    for (const m of s.matches) {
      for (let leg = 0; leg < m.legs.length; leg++) {
        if (slugOf(s.id, m.id, leg) === slug) {
          return { season: s.id, stage: m.stage, matchWinner: m.winner, ...m.legs[leg] };
        }
      }
    }
  }
  return null;
}

// ---------- League-1 (verified / adversarial refutation) ----------
//
// Division-independent: reads every results/verified-*.json directly (not
// through allSeasons()), so the public export includes it regardless of
// API_DIVISION. Merges all legs, then reuses the exact two-ladder Bradley-Terry
// fit from src/verified/ladder.ts (computeLadders) — no duplicated BT logic.

export interface VerifiedModelRow {
  model: string;
  proverLegs: number;
  proverWins: number;
  refuterLegs: number;
  refuterWins: number;
  forfeits: number;
}
export interface VerifiedClassRate {
  classId: string;
  legs: number;
  proverWins: number;
  refuterWins: number;
  proverWinRate: number; // proverWins / legs
}
export interface VerifiedComposite {
  model: string;
  composite: number;
  prover: number;
  refuter: number;
  lo: number; // CI-style range: mean of the two ladders' bootstrap bounds
  hi: number;
  provisional: boolean;
}

function allVerifiedRuns(): RunFile[] {
  const out: RunFile[] = [];
  const only = process.env.API_DIVISION;
  for (const f of readdirSync(resultsDir())) {
    if (!f.startsWith("verified-") || !f.endsWith(".json")) continue;
    // Pilot runs use the dev roster; keep them off the public (flagship) board
    // so the two incomparable pools never share a ladder.
    if (only && f.includes("pilot")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(resultsDir(), f), "utf8")) as RunFile);
    } catch (err) {
      console.error(`skipping unreadable ${f}: ${(err as Error).message}`);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function verifiedSummary() {
  const runs = allVerifiedRuns();
  const legs: LegResult[] = [];
  const rosterSet = new Set<string>();
  let refuterBudgetK = 10;
  for (const r of runs) {
    for (const m of r.roster ?? []) rosterSet.add(m);
    if (typeof r.refuterBudgetK === "number") refuterBudgetK = r.refuterBudgetK;
    for (const l of r.legs ?? []) {
      legs.push(l);
      rosterSet.add(l.prover);
      rosterSet.add(l.refuter);
    }
  }
  const roster = [...rosterSet];
  const ladders = computeLadders(legs, roster);

  const pMap = new Map(ladders.prover.map((x) => [x.model, x]));
  const rMap = new Map(ladders.refuter.map((x) => [x.model, x]));
  const composite: VerifiedComposite[] = ladders.composite.map((c) => {
    const p = pMap.get(c.model);
    const r = rMap.get(c.model);
    return {
      model: c.model,
      composite: c.composite,
      prover: c.prover,
      refuter: c.refuter,
      lo: p && r ? Math.round((p.lo + r.lo) / 2) : c.composite,
      hi: p && r ? Math.round((p.hi + r.hi) / 2) : c.composite,
      provisional: (p?.provisional ?? true) || (r?.provisional ?? true),
    };
  });

  const rows = new Map<string, VerifiedModelRow>();
  const getRow = (m: string) => {
    if (!rows.has(m)) rows.set(m, { model: m, proverLegs: 0, proverWins: 0, refuterLegs: 0, refuterWins: 0, forfeits: 0 });
    return rows.get(m)!;
  };
  for (const m of roster) getRow(m);

  const classes = new Map<string, VerifiedClassRate>();
  const getCls = (id: string) => {
    if (!classes.has(id)) classes.set(id, { classId: id, legs: 0, proverWins: 0, refuterWins: 0, proverWinRate: 0 });
    return classes.get(id)!;
  };

  let ratedLegs = 0;
  let voids = 0;
  let forfeits = 0;
  for (const l of legs) {
    if (l.void) {
      voids++;
      continue;
    }
    ratedLegs++;
    const p = getRow(l.prover);
    const r = getRow(l.refuter);
    p.proverLegs++;
    r.refuterLegs++;
    if (l.winner === "prover") p.proverWins++;
    if (l.winner === "refuter") r.refuterWins++;
    if (l.proverForfeit) {
      p.forfeits++;
      forfeits++;
    }
    const c = getCls(l.classId);
    c.legs++;
    if (l.winner === "prover") c.proverWins++;
    if (l.winner === "refuter") c.refuterWins++;
  }

  const classList = [...classes.values()]
    .map((c) => ({ ...c, proverWinRate: c.legs ? +(c.proverWins / c.legs).toFixed(3) : 0 }))
    .sort((a, b) => a.classId.localeCompare(b.classId));

  // Order the per-model rows to match the composite ladder ranking.
  const order = new Map(composite.map((c, i) => [c.model, i]));
  const models = [...rows.values()].sort((a, b) => (order.get(a.model) ?? 1e9) - (order.get(b.model) ?? 1e9));

  return {
    runIds: runs.map((r) => r.id),
    roster,
    totalLegs: legs.length,
    ratedLegs,
    voids,
    forfeits,
    refuterBudgetK,
    prover: ladders.prover,
    refuter: ladders.refuter,
    composite,
    models,
    classes: classList,
  };
}

export interface GapRow {
  model: string;
  verifiedRank: number; // 1-based on the verified composite
  persuasionRank: number; // 1-based on the flagship-division debate ranking
  delta: number; // verifiedRank - persuasionRank; positive = stronger at persuasion than execution
  notable: boolean; // |delta| >= 3
}

// Models present on BOTH the verified composite and the flagship debate board.
// Slugs are the same OpenRouter ids across leagues, so a direct string match ties them.
export function gapTable(): GapRow[] {
  const verified = verifiedSummary().composite;
  const vRank = new Map(verified.map((c, i) => [c.model, i + 1]));
  const flag = summary().divisions.find((d) => d.name === "flagship");
  const rankings = flag ? flag.rankings : [];
  const out: GapRow[] = [];
  rankings.forEach((r, i) => {
    const vr = vRank.get(r.model);
    if (vr === undefined) return;
    const persuasionRank = i + 1;
    const delta = vr - persuasionRank;
    out.push({ model: r.model, verifiedRank: vr, persuasionRank, delta, notable: Math.abs(delta) >= 3 });
  });
  return out.sort((a, b) => a.verifiedRank - b.verifiedRank);
}

// Transparency stats: how each judge votes, and each model's per-side record
// plus which judges voted for/against it.
export function stats() {
  const judges = new Map<string, { judge: string; votes: number; proVotes: number; agreed: number; decided: number }>();
  const models = new Map<
    string,
    { model: string; proDebates: number; proWins: number; conDebates: number; conWins: number; judgeVotes: Record<string, { for: number; against: number }> }
  >();
  const getJ = (j: string) => {
    if (!judges.has(j)) judges.set(j, { judge: j, votes: 0, proVotes: 0, agreed: 0, decided: 0 });
    return judges.get(j)!;
  };
  const getM = (m: string) => {
    if (!models.has(m)) models.set(m, { model: m, proDebates: 0, proWins: 0, conDebates: 0, conWins: 0, judgeVotes: {} });
    return models.get(m)!;
  };
  for (const s of allSeasons()) {
    for (const match of s.matches) {
      for (const leg of match.legs) {
        const pro = getM(leg.pro), con = getM(leg.con);
        pro.proDebates++;
        con.conDebates++;
        if (leg.winner === leg.pro) pro.proWins++;
        if (leg.winner === leg.con) con.conWins++;
        for (const v of leg.verdicts) {
          if (v.failed) continue;
          const j = getJ(v.judge);
          j.votes++;
          if (v.winner === "A") j.proVotes++;
          if (leg.winner) {
            j.decided++;
            const votedFor = v.winner === "A" ? leg.pro : leg.con;
            if (votedFor === leg.winner) j.agreed++;
          }
          const votedForModel = v.winner === "A" ? leg.pro : leg.con;
          const votedAgainstModel = v.winner === "A" ? leg.con : leg.pro;
          for (const [target, dir] of [[votedForModel, "for"], [votedAgainstModel, "against"]] as const) {
            const rec = getM(target).judgeVotes;
            rec[v.judge] ??= { for: 0, against: 0 };
            rec[v.judge][dir]++;
          }
        }
      }
    }
  }
  return { judges: [...judges.values()], models: [...models.values()] };
}
