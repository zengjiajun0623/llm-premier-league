import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Match, Season } from "./types.js";
import { mulberry32 } from "./rng.js";
import { resultsDir } from "./paths.js";
import { rateBT, type BtLeg } from "./bt.js";

const RESULTS = () => resultsDir();

export function loadSeasons(): Season[] {
  return readdirSync(RESULTS())
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(RESULTS(), f), "utf8")) as Season)
    .filter((s) => s.done)
    .sort((a, b) => a.id.localeCompare(b.id));
}

interface Agg {
  model: string;
  seasons: number;
  titles: number;
  podiums: number;
  avgPlacement: number;
  debates: number;
  debateWins: number;
  debateDraws: number;
  elo: number; // online Elo, display-only "form"
  eloLo: number;
  eloHi: number;
  rating: number; // Bradley-Terry, the PRIMARY ranking (Elo scale)
  ratingLo: number;
  ratingHi: number;
  provisional: boolean; // outside the largest connected play-graph component
}

interface LegLite {
  pro: string;
  con: string;
  winner: string | null;
  y: number; // PRO jury vote share, for Bradley-Terry
  cluster: string; // pairing id: both legs of a pairing resample together
}

const K = 32;

// Rankings never mix divisions: different lineups never meet, so their Elo
// pools are incomparable. Older season files predate the field.
export function divisionOf(s: Season): string {
  return (s.config as { division?: string }).division ?? (s.id.includes("cheap") ? "dev" : "flagship");
}

function runElo(legs: LegLite[], models: Iterable<string>): Map<string, number> {
  const elo = new Map<string, number>();
  for (const m of models) elo.set(m, 1500);
  for (const leg of legs) {
    const rp = elo.get(leg.pro) ?? 1500;
    const rc = elo.get(leg.con) ?? 1500;
    const expP = 1 / (1 + 10 ** ((rc - rp) / 400));
    const actual = leg.winner === leg.pro ? 1 : leg.winner === leg.con ? 0 : 0.5;
    elo.set(leg.pro, rp + K * (actual - expP));
    elo.set(leg.con, rc + K * (1 - actual - (1 - expP)));
  }
  return elo;
}

// Elo over every individual debate (legs included), chronological across
// seasons, with a bootstrap 95% CI (resample debates with replacement).
export function aggregate(seasons: Season[]): Agg[] {
  const stats = new Map<string, Agg>();
  const get = (m: string): Agg => {
    if (!stats.has(m)) {
      stats.set(m, { model: m, seasons: 0, titles: 0, podiums: 0, avgPlacement: 0, debates: 0, debateWins: 0, debateDraws: 0, elo: 1500, eloLo: 1500, eloHi: 1500, rating: 1500, ratingLo: 1500, ratingHi: 1500, provisional: true });
    }
    return stats.get(m)!;
  };

  const placementSums = new Map<string, number>();
  const legs: LegLite[] = [];

  for (const season of seasons) {
    for (const [model, place] of Object.entries(season.placements)) {
      const a = get(model);
      a.seasons++;
      if (place === 1) a.titles++;
      if (place <= 3) a.podiums++;
      placementSums.set(model, (placementSums.get(model) ?? 0) + place);
    }
    for (const match of season.matches) {
      for (const leg of match.legs) {
        const [p, c] = [get(leg.pro), get(leg.con)];
        p.debates++; c.debates++;
        if (leg.winner === leg.pro) p.debateWins++;
        else if (leg.winner === leg.con) c.debateWins++;
        else { p.debateDraws++; c.debateDraws++; }
        const cluster = `${season.id}:${[leg.pro, leg.con].sort().join("|")}`;
        const tot = (leg.votesPro ?? 0) + (leg.votesCon ?? 0);
        const y = tot > 0 ? leg.votesPro / tot : 0.5;
        legs.push({ pro: leg.pro, con: leg.con, winner: leg.winner, y, cluster });
      }
    }
  }

  const models = [...stats.keys()];
  const point = runElo(legs, models);

  // Seeded cluster bootstrap: resample pairings (both legs together), since
  // same-motion side-swapped legs are correlated, not independent draws.
  const clusters = new Map<string, LegLite[]>();
  for (const leg of legs) {
    if (!clusters.has(leg.cluster)) clusters.set(leg.cluster, []);
    clusters.get(leg.cluster)!.push(leg);
  }
  const clusterList = [...clusters.values()];
  const rnd = mulberry32(0xbeefcafe ^ legs.length);
  const B = 200;
  const samples = new Map<string, number[]>(models.map((m) => [m, []]));
  for (let b = 0; b < B && clusterList.length; b++) {
    const resampled: LegLite[] = [];
    for (let i = 0; i < clusterList.length; i++) {
      resampled.push(...clusterList[Math.floor(rnd() * clusterList.length)]);
    }
    const e = runElo(resampled, models);
    for (const m of models) samples.get(m)!.push(e.get(m)!);
  }

  // Bradley-Terry: the primary ranking. Order-independent, side-adjusted,
  // vote-share outcomes, provisional flag for weakly-connected models.
  const btLegs: BtLeg[] = legs.map((l) => ({ pro: l.pro, con: l.con, y: l.y, cluster: l.cluster }));
  const bt = new Map(rateBT(btLegs, models).map((r) => [r.model, r]));

  const out = [...stats.values()];
  for (const a of out) {
    a.elo = Math.round(point.get(a.model)!);
    const s = samples.get(a.model)!.sort((x, y) => x - y);
    if (s.length) {
      a.eloLo = Math.round(s[Math.floor(s.length * 0.025)]);
      a.eloHi = Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.975))]);
    }
    const r = bt.get(a.model);
    if (r) {
      a.rating = r.rating;
      a.ratingLo = r.lo;
      a.ratingHi = r.hi;
      a.provisional = r.provisional;
    }
    a.avgPlacement = a.seasons ? +(placementSums.get(a.model)! / a.seasons).toFixed(2) : 0;
  }
  // Non-provisional first, then by BT rating; provisional models sink.
  out.sort((a, b) => (a.provisional !== b.provisional ? (a.provisional ? 1 : -1) : b.rating - a.rating));
  return out;
}

const short = (m: string) => m.split("/")[1] ?? m;

export function printSeason(season: Season): void {
  console.log(`\n=== ${season.id} — cost $${season.totalCostUsd.toFixed(2)} ===`);
  for (const [g, table] of Object.entries(season.standings)) {
    console.log(`\n${g === "League" ? "League table" : `Group ${g}`}:  (W-D-L, pts, score diff)`);
    for (const s of table) {
      console.log(`  ${short(s.model).padEnd(24)} ${s.wins}-${s.draws}-${s.losses}  ${String(s.points).padStart(2)}pts  ${s.scoreDiff >= 0 ? "+" : ""}${s.scoreDiff}`);
    }
  }
  const koStage = (m: Match) => !m.stage.startsWith("group") && m.stage !== "league";
  for (const m of season.matches.filter(koStage)) {
    const legs = m.legs.map((l) => `${l.winner ? short(l.winner) : "draw"}`).join(", ");
    console.log(`${m.stage.padEnd(8)} ${short(m.home)} vs ${short(m.away)} → ${m.winner ? short(m.winner) : "draw"}  (legs: ${legs})`);
  }
  if (season.champion) console.log(`\n🏆 Champion: ${short(season.champion)}`);
}

export function printRankings(): void {
  const seasons = loadSeasons();
  if (!seasons.length) {
    console.log("No completed seasons in results/.");
    return;
  }
  const divisions = new Map<string, typeof seasons>();
  for (const s of seasons) {
    const d = divisionOf(s);
    if (!divisions.has(d)) divisions.set(d, []);
    divisions.get(d)!.push(s);
  }
  for (const [div, ss] of divisions) {
    const agg = aggregate(ss);
    console.log(`\n=== ${div.toUpperCase()} DIVISION (${ss.length} season${ss.length > 1 ? "s" : ""}) ===\n`);
    console.log(`   ${"model".padEnd(26)} ${"BT".padStart(5)} ${"95% CI".padStart(12)}  titles  W-D-L  (BT = Bradley-Terry, * = provisional)`);
    agg.forEach((a, i) => {
      const ci = `${a.ratingLo}-${a.ratingHi}`;
      const wdl = `${a.debateWins}-${a.debateDraws}-${a.debates - a.debateWins - a.debateDraws}`;
      const mark = a.provisional ? "*" : " ";
      console.log(
        `${String(i + 1).padStart(2)}. ${short(a.model).padEnd(26)} ${String(a.rating).padStart(5)}${mark}${ci.padStart(12)}  ${String(a.titles).padStart(5)}  ${wdl}`,
      );
    });
  }
  for (const s of seasons) console.log(`\n${s.id}: 🏆 ${short(s.champion!)}`);
}
