// Penalized leg-level Bradley-Terry rating (v2 design, three-way reviewed).
//
// Why BT over chronological Elo: sparse, uneven, adaptively-scheduled play makes
// Elo path-dependent (who you met early biases the result). BT fits the whole
// history at once, so ordering is irrelevant and seasons/ladders/v1 history all
// merge. Fit at the LEG level (odd jury can't tie → the draw question dissolves).
//
// Model:  logit P(i beats j as PRO) = theta_i - theta_j + betaSide
//   - outcome per leg = jury VOTE SHARE (4-1 -> 0.8), not a hard win: this
//     propagates judge (dis)agreement into the likelihood for ~free.
//   - sum(theta)=0 for identifiability; weak ridge to avoid separation on sparse
//     graphs. Reported on the Elo scale (1500-centered, 400/ln10).
//   - CIs by cluster bootstrap over TIES (both legs of a pairing resample as one).
//   - models outside the largest connected component are flagged provisional.

const SCALE = 400 / Math.log(10);
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export interface BtLeg {
  pro: string;
  con: string;
  y: number; // PRO vote share in [0,1]
  cluster: string; // pairing id; both legs of a tie share it
}

export interface BtRating {
  model: string;
  rating: number; // Elo scale
  lo: number;
  hi: number;
  provisional: boolean;
}

interface Fit {
  theta: Map<string, number>;
  betaSide: number;
}

function fitBT(legs: BtLeg[], models: string[], ridge = 0.5, iters = 4000, lr = 0.05): Fit {
  const theta = new Map(models.map((m) => [m, 0]));
  let betaSide = 0;
  for (let it = 0; it < iters; it++) {
    const grad = new Map(models.map((m) => [m, 0]));
    let gSide = 0;
    for (const leg of legs) {
      const p = sigmoid((theta.get(leg.pro) ?? 0) - (theta.get(leg.con) ?? 0) + betaSide);
      const r = p - leg.y; // gradient of BCE wrt the logit
      grad.set(leg.pro, (grad.get(leg.pro) ?? 0) + r);
      grad.set(leg.con, (grad.get(leg.con) ?? 0) - r);
      gSide += r;
    }
    for (const m of models) {
      const g = (grad.get(m) ?? 0) + ridge * (theta.get(m) ?? 0);
      theta.set(m, (theta.get(m) ?? 0) - (lr * g) / Math.max(1, legs.length));
    }
    betaSide -= (lr * gSide) / Math.max(1, legs.length);
    // Recenter to satisfy sum(theta)=0.
    const mean = models.reduce((s, m) => s + (theta.get(m) ?? 0), 0) / models.length;
    for (const m of models) theta.set(m, (theta.get(m) ?? 0) - mean);
  }
  return { theta, betaSide };
}

// Largest connected component of the played graph; smaller-component models are
// only loosely tied to the main ladder and get flagged provisional.
function mainComponent(legs: BtLeg[], models: string[]): Set<string> {
  const adj = new Map<string, Set<string>>(models.map((m) => [m, new Set()]));
  for (const l of legs) {
    adj.get(l.pro)?.add(l.con);
    adj.get(l.con)?.add(l.pro);
  }
  let best = new Set<string>();
  const seen = new Set<string>();
  for (const start of models) {
    if (seen.has(start)) continue;
    const comp = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      if (comp.has(n)) continue;
      comp.add(n);
      seen.add(n);
      for (const nb of adj.get(n) ?? []) if (!comp.has(nb)) stack.push(nb);
    }
    if (comp.size > best.size) best = comp;
  }
  return best;
}

// Deterministic mulberry32 so bootstrap CIs are reproducible.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rateBT(legs: BtLeg[], models: string[], B = 100): BtRating[] {
  if (!legs.length || models.length < 2) {
    return models.map((m) => ({ model: m, rating: 1500, lo: 1500, hi: 1500, provisional: true }));
  }
  const toElo = (t: number) => Math.round(1500 + t * SCALE);
  const point = fitBT(legs, models);
  const main = mainComponent(legs, models);

  // Cluster bootstrap: resample whole ties (both legs together), refit.
  const byCluster = new Map<string, BtLeg[]>();
  for (const l of legs) {
    if (!byCluster.has(l.cluster)) byCluster.set(l.cluster, []);
    byCluster.get(l.cluster)!.push(l);
  }
  const clusters = [...byCluster.values()];
  const rand = rng(0x1a2b3c ^ legs.length);
  const samples = new Map<string, number[]>(models.map((m) => [m, []]));
  for (let b = 0; b < B; b++) {
    const resampled: BtLeg[] = [];
    for (let i = 0; i < clusters.length; i++) resampled.push(...clusters[Math.floor(rand() * clusters.length)]);
    const f = fitBT(resampled, models, 0.5, 1500);
    for (const m of models) samples.get(m)!.push(toElo(f.theta.get(m) ?? 0));
  }

  return models
    .map((m): BtRating => {
      const s = samples.get(m)!.sort((x, y) => x - y);
      return {
        model: m,
        rating: toElo(point.theta.get(m) ?? 0),
        lo: s[Math.floor(s.length * 0.025)],
        hi: s[Math.min(s.length - 1, Math.floor(s.length * 0.975))],
        provisional: !main.has(m),
      };
    })
    .sort((a, b) => b.rating - a.rating);
}
