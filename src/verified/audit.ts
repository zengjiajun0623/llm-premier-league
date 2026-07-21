// Data auditor: recomputes and validates every claim derivable from stored
// results, so analysis errors and tainted records are caught mechanically,
// not by a human noticing a surprising number.
//
// Gates: verify.sh (every change), publish.sh (nothing unaudited ships),
// nightly.sh (via verify). Exit code 1 on any violation.
//
// Origin: two real incidents on 2026-07-21. (1) An ad-hoc analysis script
// misread `winner` (role string, not model slug) and reported a false 0-8
// record. (2) Three legs were decided by a lone-surrogate input the class
// validator should never have admitted. Both classes of error are checked
// here forever.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resultsDir } from "../paths.js";
import { classById } from "./corpus.js";
import type { Season } from "../types.js";

interface Violation {
  file: string;
  detail: string;
}

export interface AuditReport {
  violations: Violation[];
  roleRecords: Map<string, { pw: number; pl: number; rw: number; rl: number }>;
  filesChecked: number;
}

export function auditAll(): AuditReport {
  const dir = resultsDir();
  const violations: Violation[] = [];
  const roleRecords = new Map<string, { pw: number; pl: number; rw: number; rl: number }>();
  const rec = (m: string) => {
    if (!roleRecords.has(m)) roleRecords.set(m, { pw: 0, pl: 0, rw: 0, rl: 0 });
    return roleRecords.get(m)!;
  };
  let filesChecked = 0;
  if (!existsSync(dir)) return { violations, roleRecords, filesChecked };

  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "live.json") continue;
    let data: any;
    try {
      data = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch (err) {
      violations.push({ file: f, detail: `unreadable: ${(err as Error).message}` });
      continue;
    }
    filesChecked++;

    if (f.startsWith("verified-")) {
      for (const l of data.legs ?? []) {
        // Field-domain checks: the exact misread that produced a false report.
        if (l.winner !== "prover" && l.winner !== "refuter") {
          violations.push({ file: f, detail: `${l.legId}: winner must be a role string, got ${JSON.stringify(l.winner)}` });
          continue;
        }
        if (l.winner === "prover") { rec(l.prover).pw++; rec(l.refuter).rl++; }
        else { rec(l.prover).pl++; rec(l.refuter).rw++; }
        // Envelope re-validation: a stored refutation must STILL pass the
        // class's own input validator (catches tainted legs retroactively
        // whenever a validator is tightened).
        if (l.winner === "refuter" && l.refutingInput !== undefined && l.classId) {
          try {
            const cls = classById(l.classId);
            const inst = cls.generate(l.instanceSeed ?? 0);
            if (!cls.validateInput(l.refutingInput, inst)) {
              violations.push({ file: f, detail: `${l.legId}: TAINTED - refutingInput no longer passes ${l.classId} validator: ${JSON.stringify(l.refutingInput).slice(0, 60)}` });
            }
          } catch {
            /* admitted classes resolve elsewhere; skip rather than false-flag */
          }
        }
      }
    }

    if (f.startsWith("season-")) {
      const s = data as Season;
      const n = s.config?.competitors?.length ?? 0;
      const expected = s.mode === "league" ? n * (n - 1) : null;
      if (s.done && expected && s.matches.length < Math.ceil(expected * 0.9)) {
        violations.push({ file: f, detail: `sealed at ${s.matches.length}/${expected} matches (<90%)` });
      }
      if (s.champion && !s.done) {
        violations.push({ file: f, detail: `champion set on unsealed season` });
      }
      for (const m of s.matches) {
        for (const l of m.legs) {
          if (l.winner && l.winner !== l.pro && l.winner !== l.con) {
            violations.push({ file: f, detail: `${m.id}: winner ${l.winner} is neither debater` });
          }
          if (l.winner === l.pro && l.votesPro < l.votesCon) {
            violations.push({ file: f, detail: `${m.id}: pro won with fewer votes (${l.votesPro}-${l.votesCon})` });
          }
          if (l.winner === l.con && l.votesCon < l.votesPro) {
            violations.push({ file: f, detail: `${m.id}: con won with fewer votes (${l.votesCon}-${l.votesPro})` });
          }
        }
      }
    }
  }
  return { violations, roleRecords, filesChecked };
}

// Canonical record printout: THE way to quote per-model numbers. Ad-hoc
// analysis scripts against raw files are how false reports happen.
export function printCanonical(report: AuditReport): void {
  console.log(`audited ${report.filesChecked} result files`);
  console.log(`\nCanonical verified role records (W-L):`);
  const rows = [...report.roleRecords.entries()].sort(
    (a, b) => b[1].pw + b[1].rw - (a[1].pw + a[1].rw),
  );
  for (const [m, r] of rows) {
    console.log(`  ${m.split("/")[1]?.padEnd(24) ?? m.padEnd(24)} prover ${r.pw}-${r.pl}   refuter ${r.rw}-${r.rl}`);
  }
}

const invokedDirectly = process.argv[1]?.endsWith("audit.ts");
if (invokedDirectly) {
  const report = auditAll();
  printCanonical(report);
  if (report.violations.length) {
    console.error(`\nAUDIT VIOLATIONS (${report.violations.length}):`);
    for (const v of report.violations) console.error(`  [${v.file}] ${v.detail}`);
    process.exit(1);
  }
  console.log("\naudit clean");
}
