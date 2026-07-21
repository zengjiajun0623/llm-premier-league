// Shared read-side API: used by the live viewer server (src/server.ts) and the
// static exporter (src/export.ts), so localhost and the public site are
// guaranteed to serve identical data shapes.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Season } from "./types.js";
import { aggregate, divisionOf } from "./report.js";
import { resultsDir } from "./paths.js";
import { computeStandings } from "./fixtures.js";

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
