// League-1 run driver + CLI.
//
//   npx tsx src/verified/run.ts --id verified-001 --rounds 2 [--cheap]
//
// Persists to results/verified-<id>.json atomically (tmp+rename, same pattern as
// tournament.ts). Resumable by leg id: finished legs are skipped on rerun.
//
// Honest labeling (LOCKED SPEC v3): the board reports models that "survived
// adversarial refutation at budget B" (K candidate inputs per refuter), never
// "verified".

import { writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { CHEAP, FLAGSHIP } from "../config.js";
import { resultsDir } from "../paths.js";
import { computeLadders, planRun, type LadderTable } from "./ladder.js";
import { runLeg } from "./match.js";
import type { LegResult } from "./types.js";

const K_BUDGET = 10;

export interface RunFile {
  id: string;
  createdAt: string;
  updatedAt: string;
  rounds: number;
  roster: string[];
  sandbox: string;
  refuterBudgetK: number;
  legs: LegResult[];
}

function runPath(id: string): string {
  return join(resultsDir(), `verified-${id}.json`);
}

function writeJson(path: string, data: object): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

function loadRun(id: string): RunFile | null {
  const p = runPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as RunFile;
}

export interface RunOptions {
  id: string;
  rounds: number;
  roster: string[];
  onLeg?: (leg: LegResult, done: number, total: number) => void;
}

// Execute (or resume) a run; returns the completed RunFile.
export async function executeRun(opts: RunOptions): Promise<RunFile> {
  const { id, rounds, roster } = opts;
  const plan = planRun(id, roster, rounds);

  const existing = loadRun(id);
  const done = new Map<string, LegResult>();
  if (existing) for (const l of existing.legs) done.set(l.legId, l);

  const file: RunFile = existing ?? {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rounds,
    roster,
    sandbox: process.env.SANDBOX === "local" ? "local(non-hermetic)" : "podman",
    refuterBudgetK: K_BUDGET,
    legs: [],
  };
  // Preserve ordering / dedupe by legId.
  const byId = new Map(file.legs.map((l) => [l.legId, l]));

  let completed = 0;
  for (const pl of plan) {
    if (byId.has(pl.legId)) {
      completed++;
      continue;
    }
    const result = await runLeg({
      legId: pl.legId,
      cls: pl.cls,
      instance: pl.instance,
      prover: pl.prover,
      refuter: pl.refuter,
    });
    byId.set(pl.legId, result);
    file.legs = plan.filter((p) => byId.has(p.legId)).map((p) => byId.get(p.legId)!);
    file.updatedAt = new Date().toISOString();
    writeJson(runPath(id), file);
    completed++;
    opts.onLeg?.(result, completed, plan.length);
  }

  // final normalized ordering
  file.legs = plan.filter((p) => byId.has(p.legId)).map((p) => byId.get(p.legId)!);
  writeJson(runPath(id), file);
  return file;
}

function fmtLadder(title: string, rows: { model: string; rating: number; lo: number; hi: number; provisional: boolean }[]): string {
  const lines = [title, "-".repeat(title.length)];
  for (const r of rows) {
    lines.push(
      `  ${String(r.rating).padStart(4)}  [${String(r.lo).padStart(4)}, ${String(r.hi).padStart(4)}]  ${r.model}${r.provisional ? "  (provisional)" : ""}`,
    );
  }
  return lines.join("\n");
}

export function formatReport(file: RunFile, table: LadderTable): string {
  const live = file.legs.filter((l) => !l.void);
  const forfeits = live.filter((l) => l.proverForfeit).length;
  const refuterWins = live.filter((l) => l.winner === "refuter").length;
  const voids = file.legs.length - live.length;
  const out: string[] = [];
  out.push(`\nLeague-1 run ${file.id}  (${file.rounds} round(s), sandbox=${file.sandbox})`);
  out.push(
    `legs: ${file.legs.length} total, ${live.length} rated, ${voids} void | ` +
      `refuter wins ${refuterWins}, prover forfeits ${forfeits}`,
  );
  out.push(`labeling: "survived adversarial refutation at budget K=${file.refuterBudgetK}"`);
  out.push("");
  out.push(fmtLadder("PROVER ladder (winning as prover)", table.prover));
  out.push("");
  out.push(fmtLadder("REFUTER ladder (winning as refuter)", table.refuter));
  out.push("");
  out.push("COMPOSITE (labeled mean)");
  out.push("------------------------");
  for (const c of table.composite) {
    out.push(`  ${String(c.composite).padStart(4)}  P=${c.prover} R=${c.refuter}  ${c.model}`);
  }
  return out.join("\n");
}

function parseArgs(argv: string[]): { id: string; rounds: number; cheap: boolean } {
  let id = "verified-001";
  let rounds = 2;
  let cheap = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--id") id = argv[++i];
    else if (argv[i] === "--rounds") rounds = Number(argv[++i]);
    else if (argv[i] === "--cheap") cheap = true;
  }
  return { id, rounds, cheap };
}

async function main() {
  const { id, rounds, cheap } = parseArgs(process.argv.slice(2));
  const roster = (cheap ? CHEAP : FLAGSHIP).competitors;
  console.log(`Starting League-1 run ${id}: ${roster.length} models, ${rounds} round(s), roster=${cheap ? "CHEAP" : "FLAGSHIP"}`);
  const file = await executeRun({
    id,
    rounds,
    roster,
    onLeg: (leg, i, n) => {
      const tag = leg.void ? "VOID" : leg.proverForfeit ? "FORFEIT" : leg.winner.toUpperCase();
      console.log(`  [${i}/${n}] ${leg.classId}: ${leg.prover} (P) vs ${leg.refuter} (R) -> ${tag}`);
    },
  });
  const table = computeLadders(file.legs, roster);
  console.log(formatReport(file, table));
}

// Run only when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
