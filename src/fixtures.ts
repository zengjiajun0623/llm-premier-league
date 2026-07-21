import type { Match, Standing } from "./types.js";
import { shuffle } from "./rng.js";

const GROUP_NAMES = "ABCDEFGH";

export function drawGroups(competitors: string[], rnd: () => number): Record<string, string[]> {
  if (competitors.length % 4 !== 0 || competitors.length < 4) {
    throw new Error("competitor count must be a multiple of 4 (min 4)");
  }
  const shuffled = shuffle(competitors, rnd);
  const groups: Record<string, string[]> = {};
  const nGroups = competitors.length / 4;
  for (let g = 0; g < nGroups; g++) {
    groups[GROUP_NAMES[g]] = shuffled.slice(g * 4, g * 4 + 4);
  }
  return groups;
}

// Round-robin pairings for a group of 4: 6 matches.
export function roundRobinPairs(models: string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      pairs.push([models[i], models[j]]);
    }
  }
  return pairs;
}

export function computeStandings(group: string[], matches: Match[]): Standing[] {
  const table = new Map<string, Standing>(
    group.map((m) => [m, { model: m, played: 0, wins: 0, draws: 0, losses: 0, points: 0, scoreDiff: 0 }]),
  );
  for (const match of matches) {
    const leg = match.legs[0];
    if (!leg) continue;
    const home = table.get(match.home)!;
    const away = table.get(match.away)!;
    home.played++;
    away.played++;
    const homeScore = leg.pro === match.home ? leg.scorePro : leg.scoreCon;
    const awayScore = leg.pro === match.away ? leg.scorePro : leg.scoreCon;
    home.scoreDiff += homeScore - awayScore;
    away.scoreDiff += awayScore - homeScore;
    if (match.winner === match.home) {
      home.wins++; home.points += 3; away.losses++;
    } else if (match.winner === match.away) {
      away.wins++; away.points += 3; home.losses++;
    } else {
      home.draws++; away.draws++; home.points++; away.points++;
    }
  }
  // Tiebreak: points, then judge-score differential, then aggregate
  // head-to-head wins across every meeting (a double round-robin has two).
  const arr = [...table.values()];
  arr.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.scoreDiff !== a.scoreDiff) return b.scoreDiff - a.scoreDiff;
    let aWins = 0, bWins = 0;
    for (const m of matches) {
      const between =
        (m.home === a.model && m.away === b.model) || (m.home === b.model && m.away === a.model);
      if (!between) continue;
      if (m.winner === a.model) aWins++;
      else if (m.winner === b.model) bWins++;
    }
    if (aWins !== bWins) return bWins - aWins;
    return a.model.localeCompare(b.model);
  });
  return arr;
}

// Knockout seeding: winners face runners-up of a different group.
// 2 groups: A1-B2, B1-A2 (semis). 4 groups: A1-B2, C1-D2, B1-A2, D1-C2 (quarters).
export function knockoutPairs(standings: Record<string, Standing[]>): [string, string][] {
  const names = Object.keys(standings).sort();
  const pairs: [string, string][] = [];
  if (names.length === 1) {
    // Single group of 4: top four go to semis, 1v4 and 2v3.
    const t = standings[names[0]];
    return [
      [t[0].model, t[3].model],
      [t[1].model, t[2].model],
    ];
  }
  for (let i = 0; i < names.length; i += 2) {
    const g1 = names[i], g2 = names[i + 1];
    pairs.push([standings[g1][0].model, standings[g2][1].model]);
    pairs.push([standings[g2][0].model, standings[g1][1].model]);
  }
  return pairs;
}
