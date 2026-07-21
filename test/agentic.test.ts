// Track A (Agentic Forecasting) tests. Fully offline + deterministic:
//   AGENTIC_SIM=1   -> search/crawl read a canned fixture (no network)
//   FEED_SIM=1      -> canned prices for question generation/resolution
//   RESULTS_DIR     -> temp dir, so sim sets never touch real results.
// No pi / no real-money model calls: pose runs the SIM arm; the harness tools
// are exercised by calling tools-core directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTIC_SIM = "1";
process.env.FEED_SIM = "1";

import { parseDdgLite, decodeUddg } from "../src/agentic/search.ts";
import { buildEvidencePool, seedQueries, type CrawlQuestion } from "../src/agentic/crawl.ts";
import { createHarness, loadPool, BUDGET_EXHAUSTED_MSG, type Harness } from "../src/agentic/tools-core.ts";
import { pose, resolveAll, loadAgenticFile, agenticRoster, type AgenticFile } from "../src/agentic/run.ts";
import { summarize } from "../src/agentic/score.ts";
import { scoreModels } from "../src/forecast/score.ts";
import type { EvidencePool } from "../src/agentic/crawl.ts";
import type { ForecastFile, Question } from "../src/forecast/feeds.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400e3;

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function useTmpResults(): string {
  const dir = tmp("agentic-res-");
  process.env.RESULTS_DIR = dir;
  return dir;
}

// A fixture that yields N distinct, usable docs for ANY query ("*" fallbacks).
function writeCoveringFixture(dir: string, n = 6): string {
  const search = Array.from({ length: n }, (_, i) => ({
    title: `Doc ${i} on the asset outlook`,
    url: `https://example.com/article-${i}`,
    snippet: `Snippet ${i}: analysts weigh the asset price path.`,
  }));
  const fetch: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    fetch[`https://example.com/article-${i}`] =
      `Long readable article ${i}. ` +
      `The market outlook and price analysis for the asset are discussed at length here, `.repeat(4) +
      `with figures, context, and dated commentary number ${i}.`;
  }
  const path = join(dir, `fixture-cover-${n}.json`);
  writeFileSync(path, JSON.stringify({ search: { "*": search }, fetch }));
  return path;
}

// --- 1. DDG-lite HTML parser + uddg decoding --------------------------------
test("search: parseDdgLite decodes uddg redirect links and pairs snippets", () => {
  const target = "https://www.reuters.com/markets/crypto/some-story-2026-07-20/";
  const enc = encodeURIComponent(target);
  const html = `
    <table>
      <tr><td>
        <a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=${enc}&rut=abc">Reuters: crypto story</a>
      </td></tr>
      <tr><td class="result-snippet">Analysts expect the metric near 41,900 by week end.</td></tr>
      <tr><td>
        <a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://example.org/x")}&rut=z">Example</a>
      </td></tr>
      <tr><td class="result-snippet">Second snippet here.</td></tr>
    </table>`;
  assert.equal(decodeUddg(`//duckduckgo.com/l/?uddg=${enc}&rut=abc`), target, "uddg param decodes to the real URL");
  const results = parseDdgLite(html);
  assert.equal(results.length, 2, "two result links parsed");
  assert.equal(results[0].url, target, "first result URL decoded");
  assert.equal(results[0].title, "Reuters: crypto story");
  assert.match(results[0].snippet, /41,900/, "snippet paired to its link");
  assert.equal(results[1].url, "https://example.org/x");
});

// --- 2. coverage gate drops an under-covered question -----------------------
test("crawl: coverage gate marks a thin pool under-covered", async () => {
  const dir = useTmpResults();
  const q: CrawlQuestion = { id: "bitcoin-7d-under", asset: "bitcoin", threshold: 70000, horizon: "7d", resolveAt: NOW + 7 * DAY };

  // Fixture that returns NO search results -> 0 usable docs -> under-covered.
  const empty = join(dir, "fixture-empty.json");
  writeFileSync(empty, JSON.stringify({ search: { "*": [] }, fetch: {} }));
  process.env.AGENTIC_FIXTURE = empty;
  const thin = await buildEvidencePool(q, { force: true });
  assert.equal(thin.docs.length, 0);
  assert.equal(thin.underCovered, true, "empty pool is under-covered");

  // A covering fixture on a different question id -> rated.
  process.env.AGENTIC_FIXTURE = writeCoveringFixture(dir, 6);
  const fat = await buildEvidencePool({ ...q, id: "bitcoin-7d-covered" }, { force: true });
  assert.ok(fat.docs.length >= 4, "enough distinct usable docs (hash-deduped)");
  assert.equal(fat.underCovered, false, "covered pool is rated");
  assert.ok(seedQueries(q).length >= 3, "seed queries derived from the question");
});

// --- 3. harness budget exhaustion after N calls -----------------------------
test("tools-core: budget exhausts after N calls; over-budget tools refuse", () => {
  const pool: EvidencePool = {
    qid: "q", question: "?", builtAt: "", queries: [], minDocs: 4, underCovered: false,
    docs: [
      { id: "d1", url: "u1", title: "bitcoin price outlook", text: "bitcoin will likely close above the threshold, analysts say 75000.", hash: "h1" },
      { id: "d2", url: "u2", title: "market note", text: "some other market commentary about ethereum.", hash: "h2" },
    ],
  };
  const tPath = join(tmp("agentic-tx-"), "t.jsonl");
  const h = createHarness({ pool, budget: 2, transcriptFile: tPath });

  const r1 = h.web_search("bitcoin price");
  assert.ok(!r1.budgetExhausted && /d1/.test(r1.text), "1st call retrieves matching doc");
  const r2 = h.web_fetch("d1");
  assert.ok(!r2.budgetExhausted && /75000/.test(r2.text), "2nd call fetches full doc text");
  const r3 = h.web_search("anything");
  assert.equal(r3.budgetExhausted, true, "3rd call over budget");
  assert.equal(r3.text, BUDGET_EXHAUSTED_MSG);
  assert.equal(h.callsUsed(), 2, "over-budget calls are not charged past the cap");

  // transcript is JSONL: 2 charged calls + 1 rejected (call=0)
  const lines = readFileSync(tPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => l.call), [1, 2, 0]);
  assert.equal(lines[2].ok, false);
});

// --- 4. pose (SIM) produces one prediction+transcript per model, resumable --
test("run: pose (sim) predicts per model with a transcript, resumable-identical", async () => {
  const dir = useTmpResults();
  process.env.AGENTIC_FIXTURE = writeCoveringFixture(dir, 6);
  process.env.FEED_SIM_PRICES = JSON.stringify({ bitcoin: 60000, ethereum: 3000, solana: 150 });

  const file = await pose({ id: "agentic-t1", nowMs: NOW });
  const roster = agenticRoster();
  assert.ok(roster.length >= 2);

  const rated = file.questions.filter((q) => !q.underCovered);
  assert.ok(rated.length > 0, "some questions rated");
  for (const q of rated) {
    assert.equal(Object.keys(q.predictions).length, roster.length, "one prediction per model");
    for (const m of roster) {
      assert.ok(q.predictions[m] >= 0.01 && q.predictions[m] <= 0.99, "clamped probability");
      const tp = q.transcripts?.[m];
      assert.ok(tp && existsSync(tp), "transcript written per (question,model)");
      const entries = readFileSync(tp!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(entries.length >= 2, "canned 2-step transcript");
      assert.deepEqual(entries.slice(0, 2).map((e) => e.tool), ["web_search", "web_fetch"]);
    }
    assert.ok(q.evidenceFile && existsSync(q.evidenceFile), "evidence pool persisted");
  }

  // resume: same predictions on rerun
  const again = await pose({ id: "agentic-t1", nowMs: NOW });
  assert.deepEqual(
    again.questions.map((q) => [q.id, q.predictions]),
    file.questions.map((q) => [q.id, q.predictions]),
    "resume reproduces identical predictions",
  );
});

// --- 5. scoring integrates agentic predictions after resolution -------------
test("score: agentic predictions resolve and populate the board", async () => {
  useTmpResults();
  process.env.AGENTIC_FIXTURE = writeCoveringFixture(process.env.RESULTS_DIR!, 6);
  process.env.FEED_SIM_PRICES = JSON.stringify({ bitcoin: 60000, ethereum: 3000, solana: 150 });
  await pose({ id: "agentic-t2", nowMs: NOW });

  const before = summarize([loadAgenticFile("agentic-t2")!], [], NOW);
  assert.equal(before.counts.resolvedQuestions, 0, "nothing resolved before deadlines");

  const { changed } = await resolveAll(NOW + 40 * DAY);
  assert.equal(changed, 1, "matured agentic file settled");
  const after = summarize([loadAgenticFile("agentic-t2")!], [], NOW + 40 * DAY);
  assert.ok(after.counts.resolvedQuestions > 0, "questions resolved");
  assert.ok(after.board.some((r) => r.n > 0), "board populated from agentic predictions");
});

// --- 6. reading decisive evidence beats ignoring it -------------------------
test("harness+score: a model that reads decisive evidence beats one that ignores it", () => {
  // Decisive pool: bitcoin will finish WELL ABOVE the 50000 threshold.
  const pool: EvidencePool = {
    qid: "bitcoin-7d-dec", question: "?", builtAt: "", queries: [], minDocs: 4, underCovered: false,
    docs: [
      { id: "d1", url: "u", title: "bitcoin surges", text: "bitcoin trading at 90000 and set to hold well above 50000 into next week.", hash: "h" },
      { id: "d2", url: "u2", title: "noise", text: "unrelated commentary.", hash: "h2" },
    ],
  };

  // Reader: searches + fetches d1, extracts a decisive figure -> predicts YES.
  const reader = createHarness({ pool, budget: 12 });
  reader.web_search("bitcoin price");
  const fetched = reader.web_fetch("d1").text;
  const num = Number(fetched.match(/\b(\d{4,6})\b/)?.[1] ?? "0");
  const readerP = num >= 50000 ? 0.95 : 0.05; // decisive evidence -> confident correct side
  const ignorerP = 0.5; // ignores the pool

  const mkQ = (): Question => ({
    id: "bitcoin-7d-dec", asset: "bitcoin", kind: "close_above", threshold: 50000, horizon: "7d", horizonMs: 7 * DAY,
    resolveAt: NOW, createdAt: NOW, spotAtCreate: 60000,
    resolved: true, outcome: 1, resolvedPrice: 90000, resolvedAt: NOW,
    predictions: { reader: readerP, ignorer: ignorerP },
  });
  const file: ForecastFile = { id: "dec", createdAt: "", updatedAt: "", roster: ["reader", "ignorer"], questions: [mkQ()] };
  const rows = scoreModels([file]);
  const reader_ = rows.find((r) => r.model === "reader")!;
  const ignorer_ = rows.find((r) => r.model === "ignorer")!;
  assert.ok(reader_.brier < ignorer_.brier, "evidence reader has lower Brier");
  assert.equal(rows[0].model, "reader", "evidence reader ranks first");

  // and the uplift diagnostic is well formed when a closed arm is paired
  const closed: ForecastFile = {
    id: "z", createdAt: "", updatedAt: "", roster: ["reader"],
    questions: [{ ...mkQ(), predictions: { reader: 0.5 } }],
  };
  const agentic: AgenticFile = { id: "z", createdAt: "", updatedAt: "", arm: "agentic", roster: ["reader"], questions: [{ ...mkQ() }] };
  const summ = summarize([agentic], [closed], NOW);
  const up = summ.uplift.find((u) => u.model === "reader")!;
  assert.ok(up && up.uplift > 0, "reader shows positive tool uplift vs a 0.5 closed guess");
});
