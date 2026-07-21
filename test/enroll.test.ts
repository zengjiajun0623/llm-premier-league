// M8 enrollment tests. No real-money / network calls: ENROLL_SIM=1 plus a
// per-test ENROLL_FIXTURE canned catalog, roster.json redirected to a temp dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ENROLL_SIM = "1";

const enrollMod = await import("../src/enroll.ts");
const { discover, familyKey, enroll, loadRoster, saveRoster } = enrollMod;
type CatalogModel = import("../src/enroll.ts").CatalogModel;
type Roster = import("../src/enroll.ts").Roster;

const NOW = Date.now();
const DAY = 86400_000;
const daysAgoSec = (d: number) => Math.floor((NOW - d * DAY) / 1000);

function model(id: string, opts: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    created: daysAgoSec(2),
    architecture: { output_modalities: ["text"], modality: "text->text" },
    pricing: { prompt: "0.000001", completion: "0.000002" },
    ...opts,
  };
}

function freshTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "enroll-"));
  process.env.ROSTER_PATH = join(dir, "roster.json");
  return dir;
}

// Write a fixture catalog file and point ENROLL_FIXTURE at it.
function fixture(models: CatalogModel[]): void {
  const dir = mkdtempSync(join(tmpdir(), "enroll-fix-"));
  const p = join(dir, "catalog.json");
  writeFileSync(p, JSON.stringify({ data: models }));
  process.env.ENROLL_FIXTURE = p;
}

function seedRosterFile(slugs: string[]): void {
  const roster: Roster = {
    models: slugs.map((slug) => ({ slug, enrolledAt: new Date(NOW).toISOString(), source: "bootstrap", provisionalUntilLegs: 0 })),
  };
  saveRoster(roster);
}

// --- discover(): the filter cases --------------------------------------------

test("discover: filters cover new/enrolled/family/stale/overpriced", () => {
  const roster: Roster = {
    models: [{ slug: "openai/gpt-5.6-sol", enrolledAt: "x", source: "bootstrap", provisionalUntilLegs: 0 }],
  };
  const catalog: CatalogModel[] = [
    model("anthropic/claude-newthink-1"), // genuinely new frontier -> enrolled
    model("openai/gpt-5.6-sol"), // already in roster -> skipped
    model("openai/gpt-5.6-turbo"), // same family "gpt-5.6" as enrolled -> skipped
    model("anthropic/claude-old-2", { created: daysAgoSec(730) }), // 2y old -> skipped
    model("google/gemini-lux-9", { pricing: { prompt: "0.0001" } }), // $100/M -> skipped
    model("randomlab/whatever-1"), // org not in allowlist -> skipped
    model("nvidia/nemotron-vision-1", { architecture: { output_modalities: ["image"] } }), // non-text out -> skipped
  ];
  const got = discover(catalog, roster, NOW).map((m) => m.id);
  assert.deepEqual(got, ["anthropic/claude-newthink-1"]);
});

test("familyKey: org + first two dash tokens", () => {
  assert.equal(familyKey("openai/gpt-5.6-sol"), "openai:gpt-5.6");
  assert.equal(familyKey("anthropic/claude-opus-4.8"), "anthropic:claude-opus");
});

// --- enroll(): seeding + cap + queue ------------------------------------------

test("enroll: first run seeds bootstrap roster from FLAGSHIP", async () => {
  freshTmp();
  fixture([]); // empty catalog: nothing to enroll, but seeding must persist
  const r = await enroll();
  assert.equal(r.seeded, true);
  assert.ok(r.roster.models.length >= 8);
  assert.ok(r.roster.models.every((m) => m.source === "bootstrap"));
  assert.ok(existsSync(process.env.ROSTER_PATH!));
});

test("enroll: caps at 2 per run and queues the overflow (earliest first)", async () => {
  freshTmp();
  seedRosterFile(["openai/gpt-5.6-sol"]);
  fixture([
    model("google/gemini-alpha-1", { created: daysAgoSec(1) }),
    model("deepseek/deepseek-beta-1", { created: daysAgoSec(5) }),
    model("qwen/qwen-gamma-1", { created: daysAgoSec(3) }),
  ]);
  const r = await enroll();
  assert.deepEqual(r.enrolled.map((m) => m.id), ["deepseek/deepseek-beta-1", "qwen/qwen-gamma-1"]);
  assert.deepEqual(r.queued.map((m) => m.id), ["google/gemini-alpha-1"]);
  const onDisk = loadRoster()!;
  assert.ok(onDisk.models.some((m) => m.slug === "deepseek/deepseek-beta-1" && m.source === "auto"));
  assert.ok(onDisk.models.find((m) => m.slug === "deepseek/deepseek-beta-1")!.provisionalUntilLegs > 0);
  // queued model must NOT be persisted this run
  assert.ok(!onDisk.models.some((m) => m.slug === "google/gemini-alpha-1"));
});

test("enroll: dry-run does not write roster.json", async () => {
  const dir = freshTmp();
  seedRosterFile(["openai/gpt-5.6-sol"]);
  const before = readFileSync(join(dir, "roster.json"), "utf8");
  fixture([model("moonshotai/kimi-omega-1")]);
  const r = await enroll({ dryRun: true });
  assert.equal(r.enrolled.length, 1);
  assert.equal(readFileSync(join(dir, "roster.json"), "utf8"), before); // unchanged
});

test("enroll: idempotent - second run enrolls nothing new", async () => {
  freshTmp();
  seedRosterFile(["openai/gpt-5.6-sol"]);
  fixture([model("x-ai/grok-delta-1"), model("meta/muse-epsilon-1")]);
  const r1 = await enroll();
  assert.equal(r1.enrolled.length, 2);
  const r2 = await enroll(); // same fixture, both now in roster
  assert.equal(r2.enrolled.length, 0);
  assert.equal(r2.discovered.length, 0);
  assert.equal(r2.seeded, false);
});

// --- atomicity: writes go through tmp + rename --------------------------------

test("saveRoster: writes atomically via tmp + rename (no .tmp left behind)", () => {
  const dir = freshTmp();
  const roster: Roster = {
    models: [{ slug: "anthropic/claude-fable-5", enrolledAt: "x", source: "bootstrap", provisionalUntilLegs: 0 }],
  };
  saveRoster(roster);
  const p = join(dir, "roster.json");
  assert.ok(existsSync(p));
  assert.ok(!existsSync(`${p}.tmp`)); // rename consumed the tmp file
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), roster);
});
