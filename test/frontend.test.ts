// Frontend consistency checks: the inline script must parse, and must not
// reference API fields the server no longer serves (the class of bug where the
// leaderboard silently mixed divisions came from exactly such a drift).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync(join(import.meta.dirname, "..", "public", "index.html"), "utf8");
const script = html.match(/<script>([\s\S]*)<\/script>/)![1];

test("inline script parses", () => {
  new Function(script); // throws on syntax error
});

test("frontend does not use retired top-level API fields", () => {
  assert.ok(!script.includes("summaryCache.rankings"), "use summaryCache.divisions, not the retired flat rankings field");
  assert.ok(!script.includes("sum.rankings"), "use sum.divisions, not the retired flat rankings field");
});

test("every fetch() path the frontend uses exists in the server routes", () => {
  const serverSrc = readFileSync(join(import.meta.dirname, "..", "src", "server.ts"), "utf8");
  const paths = [...script.matchAll(/fetch\("(\/api\/[a-z./]+)/g)].map((m) => m[1].replace(/\/$/, ""));
  assert.ok(paths.length >= 4);
  for (const p of new Set(paths)) {
    assert.ok(serverSrc.includes(p), `server must route ${p}`);
  }
});
