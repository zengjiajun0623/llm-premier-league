// M8 - Autonomous new-model discovery and enrollment.
//
//   npx tsx src/enroll.ts [--dry-run]
//
// Polls the OpenRouter catalog for newly listed frontier models and enrolls
// them into roster.json (repo root) with zero human action. Runs from
// nightly.sh BEFORE the verified round so a newcomer appears on the next
// board as provisional.
//
// SCOPE (M8, this file only): discovery + enrollment metadata. Placement is
// marked, not yet scheduled. run.ts still sources its roster from
// config.FLAGSHIP.competitors; wiring run.ts to read roster.json (and to run
// the placement mini-schedule vs top/median/bottom-quartile opponents at a
// ladder-median start with a wide prior) is the FOLLOW-UP integration step and
// is intentionally NOT done here -- see the placement TODO below. The prior is
// NEVER seeded from arena rank (roadmap M8 DoD): auto entries start provisional
// and earn their rating from placement legs only.
//
// No real-money calls in tests: ENROLL_SIM=1 returns a canned catalog fixture
// (ENROLL_FIXTURE=<path> overrides it) instead of hitting the network.

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./paths.js";
import { FLAGSHIP } from "./config.js";

const CATALOG_URL = "https://openrouter.ai/api/v1/models";

// Serious frontier labs. Org == the slug prefix before "/".
const ALLOWLIST = new Set([
  "anthropic",
  "openai",
  "google",
  "x-ai",
  "deepseek",
  "qwen",
  "moonshotai",
  "z-ai",
  "meta",
  "minimax",
  "xiaomi",
  "thinkingmachines",
  "mistralai",
  "nvidia",
]);

const WINDOW_MS = 45 * 24 * 60 * 60 * 1000; // "newly listed" = created within 45 days
const MAX_PROMPT_PER_M = 60; // price sanity: prompt < $60 / 1M tokens
const MAX_PER_RUN = 2; // cap new enrollments per run; queue the rest
// Placement metadata: how long an auto entry stays provisional. The actual
// placement mini-schedule (ladder-median start, wide prior, top/median/bottom-
// quartile opponents, <=20-25% of weekly budget for all newcomers combined,
// queueing on simultaneous launches) is a run.ts-side TODO; this file only
// records the intent so the scheduler can honor it.
const PROVISIONAL_LEGS = 24;

// --- key loading: same pattern as openrouter.loadKey (env, then anon-router). ---
function loadKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const env = readFileSync(join(homedir(), "anon-router/.env"), "utf8");
  const m = env.match(/OPENROUTER_API_KEY=(\S+)/);
  if (!m) throw new Error("OPENROUTER_API_KEY not found");
  return m[1];
}

export interface CatalogModel {
  id: string; // "org/model-name"
  name?: string;
  created?: number; // unix seconds
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    modality?: string;
  };
  pricing?: { prompt?: string; completion?: string };
}

export interface RosterEntry {
  slug: string;
  enrolledAt: string;
  source: "bootstrap" | "auto";
  provisionalUntilLegs: number;
}

export interface Roster {
  models: RosterEntry[];
}

export interface EnrollResult {
  discovered: CatalogModel[]; // all eligible new candidates, earliest-created first
  enrolled: CatalogModel[]; // the <=MAX_PER_RUN actually added this run
  queued: CatalogModel[]; // the overflow, to be picked up next run
  roster: Roster;
  seeded: boolean; // true when this run created roster.json from FLAGSHIP
}

// --- catalog fetch (sim-guarded) ---------------------------------------------

function simFixture(): CatalogModel[] {
  if (process.env.ENROLL_FIXTURE) {
    const raw = JSON.parse(readFileSync(process.env.ENROLL_FIXTURE, "utf8"));
    return Array.isArray(raw) ? raw : (raw.data as CatalogModel[]);
  }
  // Default deterministic fixture: one genuinely-new frontier model (relative to
  // now so it never ages out of the window) plus a stale one that is filtered.
  const nowSec = Math.floor(Date.now() / 1000);
  return [
    {
      id: "deepseek/deepseek-v5-pro",
      name: "DeepSeek: DeepSeek V5 Pro",
      created: nowSec - 2 * 86400,
      architecture: { output_modalities: ["text"], modality: "text->text" },
      pricing: { prompt: "0.0000009", completion: "0.0000027" },
    },
    {
      id: "openai/gpt-4o-legacy",
      name: "OpenAI: GPT-4o (legacy)",
      created: nowSec - 700 * 86400,
      architecture: { output_modalities: ["text"], modality: "text->text" },
      pricing: { prompt: "0.000005", completion: "0.000015" },
    },
  ];
}

export async function fetchCatalog(): Promise<CatalogModel[]> {
  if (process.env.ENROLL_SIM === "1") return simFixture();
  const res = await fetch(CATALOG_URL, {
    headers: {
      Authorization: `Bearer ${loadKey()}`,
      "HTTP-Referer": "https://github.com/jiajunzeng/llm-worldcup",
      "X-Title": "LLM Premier League",
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from catalog: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return (data.data ?? []) as CatalogModel[];
}

// --- discovery ---------------------------------------------------------------

// Family key = org + the first two dash-separated tokens of the model name.
// Used to skip obvious variants of an already-enrolled model.
export function familyKey(slug: string): string {
  const slash = slug.indexOf("/");
  const org = slash === -1 ? "" : slug.slice(0, slash);
  const model = slash === -1 ? slug : slug.slice(slash + 1);
  return `${org}:${model.split("-").slice(0, 2).join("-")}`;
}

export function discover(catalog: CatalogModel[], roster: Roster, now: number = Date.now()): CatalogModel[] {
  const enrolledSlugs = new Set(roster.models.map((m) => m.slug));
  const enrolledFamilies = new Set(roster.models.map((m) => familyKey(m.slug)));

  const eligible = catalog.filter((m) => {
    if (!m.id || m.id.indexOf("/") === -1) return false;
    const org = m.id.slice(0, m.id.indexOf("/"));
    if (!ALLOWLIST.has(org)) return false;

    // text-output chat models only.
    const out = m.architecture?.output_modalities;
    if (!out || !out.includes("text")) return false;

    // created within the window (and not implausibly in the future).
    const createdMs = (m.created ?? 0) * 1000;
    if (!createdMs || createdMs > now + 86400_000 || now - createdMs > WINDOW_MS) return false;

    // price sanity.
    const prompt = parseFloat(m.pricing?.prompt ?? "NaN");
    if (!Number.isFinite(prompt) || prompt * 1e6 >= MAX_PROMPT_PER_M) return false;

    // already enrolled, or an obvious variant of an enrolled model.
    if (enrolledSlugs.has(m.id)) return false;
    if (enrolledFamilies.has(familyKey(m.id))) return false;

    return true;
  });

  // Earliest-created first (fair FIFO across simultaneous launches), id tiebreak.
  eligible.sort((a, b) => (a.created ?? 0) - (b.created ?? 0) || a.id.localeCompare(b.id));
  return eligible;
}

// --- roster state (roster.json at repo root, ROSTER_PATH override) ------------

export function rosterPath(): string {
  return process.env.ROSTER_PATH ?? join(ROOT, "roster.json");
}

export function loadRoster(): Roster | null {
  const p = rosterPath();
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Roster;
}

function seedRoster(nowIso: string): Roster {
  return {
    models: FLAGSHIP.competitors.map((slug) => ({
      slug,
      enrolledAt: nowIso,
      source: "bootstrap" as const,
      provisionalUntilLegs: 0, // bootstrap models are already established
    })),
  };
}

export function saveRoster(roster: Roster): void {
  const p = rosterPath();
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(roster, null, 2));
  renameSync(tmp, p); // atomic swap: readers never see a half-written file
}

// --- orchestration -----------------------------------------------------------

export async function enroll(opts: { dryRun?: boolean } = {}): Promise<EnrollResult> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  let roster = loadRoster();
  let seeded = false;
  if (!roster) {
    roster = seedRoster(nowIso); // first run: bootstrap from FLAGSHIP roster
    seeded = true;
  }

  const catalog = await fetchCatalog();
  const discovered = discover(catalog, roster, now);
  const enrolled = discovered.slice(0, MAX_PER_RUN);
  const queued = discovered.slice(MAX_PER_RUN);

  for (const m of enrolled) {
    roster.models.push({
      slug: m.id,
      enrolledAt: nowIso,
      source: "auto",
      provisionalUntilLegs: PROVISIONAL_LEGS,
    });
  }

  if (!opts.dryRun && (seeded || enrolled.length > 0)) saveRoster(roster);

  return { discovered, enrolled, queued, roster, seeded };
}

// --- CLI ---------------------------------------------------------------------

function fmt(m: CatalogModel): string {
  const priceM = (parseFloat(m.pricing?.prompt ?? "0") * 1e6).toFixed(2);
  return `${m.id}  (created ${new Date((m.created ?? 0) * 1000).toISOString().slice(0, 10)}, $${priceM}/M in)`;
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  console.log(`=== enroll ${dryRun ? "(dry-run) " : ""}${new Date().toISOString()} ===`);
  const r = await enroll({ dryRun });
  if (r.seeded) console.log(`seeded roster.json from FLAGSHIP: ${r.roster.models.length} bootstrap models`);
  console.log(`discovered ${r.discovered.length} eligible new model(s):`);
  for (const m of r.discovered) console.log(`  - ${fmt(m)}`);
  console.log(`enrolled ${r.enrolled.length} (cap ${MAX_PER_RUN}):`);
  for (const m of r.enrolled) console.log(`  + ${m.id}  [provisional for ${PROVISIONAL_LEGS} legs]`);
  if (r.queued.length) {
    console.log(`queued ${r.queued.length} for a later run:`);
    for (const m of r.queued) console.log(`  ~ ${m.id}`);
  }
  if (dryRun) console.log("(dry-run: roster.json not written)");
  else console.log(`roster.json now has ${r.roster.models.length} models`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
