// League-1 scheduling + two-ladder BT rating.
//
// A run = R rounds. Each round pairs all roster models (seeded rotation). Role
// orientation depends on (round + i + j) parity so, across rounds, everyone both
// proves and refutes and every pair meets in both orders. The scheduler assigns
// class + instance seed deterministically per leg, so a run is fully resumable
// by leg id.

import { rateBT, type BtLeg, type BtRating } from "../bt.js";
import { mulberry32, shuffle } from "../rng.js";
import { classForLeg } from "./corpus.js";
import { allClasses, proposerOf } from "./admission/runtime.js";
import type { ArtifactClass, LegResult, ProblemInstance } from "./types.js";

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, "_");
}

export interface PlannedLeg {
  legId: string;
  round: number;
  cls: ArtifactClass;
  instance: ProblemInstance;
  prover: string;
  refuter: string;
}

// Deterministic schedule for the whole run.
export function planRun(runId: string, roster: string[], rounds: number, seed = 1): PlannedLeg[] {
  const legs: PlannedLeg[] = [];
  let legCounter = 0;
  for (let round = 0; round < rounds; round++) {
    // Seeded rotation of the roster per round so pair orientation varies.
    const order = shuffle(roster, mulberry32((seed ^ 0x5eed) + round * 1013));
    const n = order.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const orient = (round + i + j) % 2 === 0;
        const prover = orient ? order[i] : order[j];
        const refuter = orient ? order[j] : order[i];
        // Rotate over built-ins + mechanically admitted proposals, skipping any
        // class proposed by either player (no self-dealt exams).
        const proposers = proposerOf();
        const pool = allClasses().filter((c) => {
          const by = proposers.get(c.id);
          return by !== prover && by !== refuter;
        });
        const cls = pool.length ? pool[((legCounter % pool.length) + pool.length) % pool.length] : classForLeg(legCounter);
        const instanceSeed = hashStr(`${runId}|${round}|${prover}|${refuter}|${cls.id}`) & 0x7fffffff;
        const instance = cls.generate(instanceSeed);
        const legId = `${runId}-r${round}-${cls.id}-${sanitize(prover)}-vs-${sanitize(refuter)}`;
        legs.push({ legId, round, cls, instance, prover, refuter });
        legCounter++;
      }
    }
  }
  return legs;
}

export interface LadderTable {
  prover: BtRating[];
  refuter: BtRating[];
  composite: { model: string; composite: number; prover: number; refuter: number }[];
}

// Build the two BT ladders + composite from finished, non-void legs.
//
// A leg is prover_i vs refuter_j, so proving skill and refuting skill are TWO
// distinct latent abilities. A single symmetric BT over (pro=prover,con=refuter)
// cannot separate them (the refuter ladder collapses to a copy of the prover
// ladder). Instead we fit ONE bipartite attack/defense BT: every model gets a
// separate prover-avatar `P::model` and refuter-avatar `R::model` node.
//   logit P(prover i beats refuter j) = theta[P::i] - theta[R::j]
// so theta[P::i] = proving strength and theta[R::j] = refuting strength (higher
// = harder to refute against = better refuter). They are estimated jointly on a
// common scale, then split into the two published ladders.
const PRO = "P::";
const REF = "R::";

export function computeLadders(results: LegResult[], roster: string[]): LadderTable {
  const live = results.filter((r) => !r.void);

  const legs: BtLeg[] = [];
  for (const r of live) {
    const cluster = `${[r.prover, r.refuter].sort().join("|")}|${r.classId}`;
    legs.push({ pro: PRO + r.prover, con: REF + r.refuter, y: r.winner === "prover" ? 1 : 0, cluster });
  }

  const avatars = [...roster.map((m) => PRO + m), ...roster.map((m) => REF + m)];
  const rated = rateBT(legs, avatars);
  const byAvatar = new Map(rated.map((x) => [x.model, x]));

  const strip = (prefix: string) =>
    roster
      .map((m) => {
        const a = byAvatar.get(prefix + m);
        return a
          ? { ...a, model: m }
          : { model: m, rating: 1500, lo: 1500, hi: 1500, provisional: true };
      })
      .sort((a, b) => b.rating - a.rating);

  const prover = strip(PRO);
  const refuter = strip(REF);
  const pMap = new Map(prover.map((x) => [x.model, x.rating]));
  const rMap = new Map(refuter.map((x) => [x.model, x.rating]));

  const composite = roster
    .map((m) => {
      const p = pMap.get(m) ?? 1500;
      const rr = rMap.get(m) ?? 1500;
      return { model: m, composite: Math.round((p + rr) / 2), prover: p, refuter: rr };
    })
    .sort((a, b) => b.composite - a.composite);

  return { prover, refuter, composite };
}
