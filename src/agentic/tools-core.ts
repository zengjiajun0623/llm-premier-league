// Track A — the agent harness logic that reads the FROZEN evidence pool.
//
// This is the shared, dependency-light core used by BOTH the pi extension
// (pi-ext/agentic-tools.ts, which wraps these with typebox schemas) and the unit
// tests (which call the tool functions directly, offline). Keeping the logic here
// — with no typebox / pi imports — is what lets the tests exercise the real tool
// behaviour without the pi runtime.
//
// The harness deliberately does NOT touch the live web: web_search does keyword
// retrieval over the frozen pool; web_fetch returns a pooled doc's text. A
// pilot-set BUDGET caps tool calls; once exhausted every tool returns a fixed
// "budget exhausted" message. Every call+result is appended as JSONL to the
// transcript (the research trace the site publishes).

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { EvidenceDoc, EvidencePool } from "./crawl.js";

export interface ToolResult {
  text: string;
  budgetExhausted?: boolean;
}

export interface TranscriptEntry {
  ts: string;
  call: number; // 1-based index within this harness (0 = a rejected over-budget call)
  tool: string;
  args: unknown;
  ok: boolean;
  result: string; // truncated summary of what the tool returned
}

export const BUDGET_EXHAUSTED_MSG =
  "budget exhausted: no tool calls remain. Stop researching and output your final probability now.";

export const DEFAULT_BUDGET = 12;
const FETCH_BYTE_CAP = 8 * 1024;
const SEARCH_TOP_K = 5;
const SNIPPET_LEN = 240;
const RESULT_LOG_CAP = 400;

export function loadPool(evidenceFile: string): EvidencePool {
  if (!existsSync(evidenceFile)) throw new Error(`EVIDENCE_FILE not found: ${evidenceFile}`);
  return JSON.parse(readFileSync(evidenceFile, "utf8")) as EvidencePool;
}

export interface HarnessOptions {
  pool: EvidencePool;
  budget?: number;
  transcriptFile?: string; // JSONL sink; omitted in pure tests
  // Injected for tests; defaults to a real python3 subprocess.
  pythonRunner?: (src: string) => { ok: boolean; output: string };
}

export interface Harness {
  web_search(query: string): ToolResult;
  web_fetch(id: string): ToolResult;
  run_python(src: string): ToolResult;
  callsUsed(): number;
  budget: number;
}

// Score a doc for a keyword query: count case-insensitive term hits in title
// (weighted) + text. Cheap substring retrieval — "better queries retrieve
// better", so query skill is preserved and measured.
function scoreDoc(doc: EvidenceDoc, terms: string[]): number {
  const title = doc.title.toLowerCase();
  const text = doc.text.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (!t) continue;
    if (title.includes(t)) score += 3;
    // count occurrences in body (capped so one term can't dominate)
    let idx = 0;
    let hits = 0;
    while (hits < 8) {
      const at = text.indexOf(t, idx);
      if (at < 0) break;
      hits++;
      idx = at + t.length;
    }
    score += hits;
  }
  return score;
}

function snippetFor(doc: EvidenceDoc, terms: string[]): string {
  const text = doc.text;
  const lower = text.toLowerCase();
  // center the snippet on the first matching term if any
  let center = 0;
  for (const t of terms) {
    const at = lower.indexOf(t);
    if (at >= 0) {
      center = at;
      break;
    }
  }
  const start = Math.max(0, center - 40);
  return text.slice(start, start + SNIPPET_LEN).replace(/\s+/g, " ").trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function defaultPython(src: string): { ok: boolean; output: string } {
  // NOTE: The project's hermetic backend (src/verified/sandbox.ts, runInSandbox)
  // is podman-isolated but is built around a `solve(input)->json` protocol, which
  // does not fit an arbitrary research script. We therefore run a plain, isolated
  // python3 subprocess here (network is not needed for scratch computation) with
  // a wall-clock timeout and an output cap. For a fully hermetic run_python, swap
  // this runner for a runInSandbox-based one (the harness accepts a pythonRunner).
  try {
    const r = spawnSync("python3", ["-I", "-c", src], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    });
    if (r.error) return { ok: false, output: `python3 error: ${r.error.message}` };
    const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
    if (r.status !== 0) return { ok: false, output: `exit ${r.status}: ${truncate(out, 500)}` };
    return { ok: true, output: truncate(out || "(no output)", 2000) };
  } catch (e) {
    return { ok: false, output: `python3 spawn failed: ${(e as Error).message}` };
  }
}

// Build a stateful harness over a frozen pool. Budget + transcript state live in
// the closure and persist across tool calls within one agent run.
export function createHarness(opts: HarnessOptions): Harness {
  const pool = opts.pool;
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const transcriptFile = opts.transcriptFile;
  const python = opts.pythonRunner ?? defaultPython;
  let used = 0;

  function log(entry: TranscriptEntry) {
    if (!transcriptFile) return;
    try {
      appendFileSync(transcriptFile, JSON.stringify(entry) + "\n");
    } catch {
      /* transcript is best-effort */
    }
  }

  function overBudget(tool: string, args: unknown): ToolResult {
    log({ ts: new Date().toISOString(), call: 0, tool, args, ok: false, result: BUDGET_EXHAUSTED_MSG });
    return { text: BUDGET_EXHAUSTED_MSG, budgetExhausted: true };
  }

  function charge(tool: string, args: unknown, run: () => { ok: boolean; text: string }): ToolResult {
    if (used >= budget) return overBudget(tool, args);
    used++;
    const call = used;
    const { ok, text } = run();
    log({ ts: new Date().toISOString(), call, tool, args, ok, result: truncate(text, RESULT_LOG_CAP) });
    return { text };
  }

  return {
    budget,
    callsUsed: () => used,

    web_search(query: string): ToolResult {
      return charge("web_search", { query }, () => {
        const terms = query
          .toLowerCase()
          .split(/[^a-z0-9.]+/)
          .filter((t) => t.length >= 2);
        const ranked = pool.docs
          .map((d) => ({ d, s: scoreDoc(d, terms) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, SEARCH_TOP_K);
        if (ranked.length === 0) {
          return {
            ok: true,
            text: `No pooled documents matched "${query}". The evidence pool has ${pool.docs.length} docs (ids ${pool.docs
              .map((d) => d.id)
              .join(", ")}). Try broader terms or web_fetch a doc id directly.`,
          };
        }
        const lines = ranked.map(
          ({ d }) => `- id=${d.id} | ${truncate(d.title, 100)}\n    ${truncate(snippetFor(d, terms), SNIPPET_LEN)}`,
        );
        return { ok: true, text: `Top matches from the frozen evidence pool:\n${lines.join("\n")}` };
      });
    },

    web_fetch(id: string): ToolResult {
      return charge("web_fetch", { id }, () => {
        const doc = pool.docs.find((d) => d.id === id);
        if (!doc) {
          return {
            ok: false,
            text: `No document with id="${id}". Valid ids: ${pool.docs.map((d) => d.id).join(", ") || "(pool empty)"}.`,
          };
        }
        return {
          ok: true,
          text: `URL: ${doc.url}\nTITLE: ${doc.title}\n\n${doc.text.slice(0, FETCH_BYTE_CAP)}`,
        };
      });
    },

    run_python(src: string): ToolResult {
      return charge("run_python", { src: truncate(src, 200) }, () => {
        const r = python(src);
        return { ok: r.ok, text: r.output };
      });
    },
  };
}
