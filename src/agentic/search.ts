// Track A — free, no-key search backend for the evidence crawl.
//
// The rated board never touches the live web at prediction time; this module is
// used ONLY at crawl time (crawl.ts) to build the frozen per-question evidence
// pool. It is deliberately network-tolerant: every failure degrades to [] / ""
// rather than throwing, so a flaky provider yields an under-covered pool (which
// the coverage gate then drops) instead of crashing the crawl.
//
// Backend: DuckDuckGo's keyless HTML endpoint (lite.duckduckgo.com/lite). Result
// links are wrapped as `//duckduckgo.com/l/?uddg=<URL-ENCODED-TARGET>&...`; we
// decode the `uddg` param to recover the real destination. `fetchReadable` is a
// plain HTTPS GET with tags/scripts stripped and a byte cap.
//
// SIM: AGENTIC_SIM=1 short-circuits ALL network to a canned fixture map so the
// crawl (and its tests) run fully offline and deterministically.

import { readFileSync, existsSync } from "node:fs";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// --- SIM fixtures -----------------------------------------------------------
//
// AGENTIC_FIXTURE points at a JSON file:
//   { "search": { "<query-substring>": SearchResult[] , "*": SearchResult[] },
//     "fetch":  { "<url>": "readable text", "*": "fallback text" } }
// Lookups are exact-key first, then case-insensitive substring, then "*".

interface Fixture {
  search?: Record<string, SearchResult[]>;
  fetch?: Record<string, string>;
}

let fixtureCache: Fixture | null = null;
let fixtureCacheKey: string | undefined; // AGENTIC_FIXTURE path the cache was built from

function loadFixture(): Fixture | null {
  const path = process.env.AGENTIC_FIXTURE;
  if (path === fixtureCacheKey) return fixtureCache; // cache valid for this path
  fixtureCacheKey = path;
  if (!path || !existsSync(path)) {
    fixtureCache = null;
    return null;
  }
  try {
    fixtureCache = JSON.parse(readFileSync(path, "utf8")) as Fixture;
  } catch {
    fixtureCache = null;
  }
  return fixtureCache;
}

function fixtureLookup<T>(map: Record<string, T> | undefined, key: string): T | undefined {
  if (!map) return undefined;
  if (key in map) return map[key];
  const lk = key.toLowerCase();
  for (const k of Object.keys(map)) {
    if (k === "*") continue;
    if (lk.includes(k.toLowerCase()) || k.toLowerCase().includes(lk)) return map[k];
  }
  return map["*"];
}

export function isSim(): boolean {
  return process.env.AGENTIC_SIM === "1";
}

// --- DDG-lite HTML parsing (exported for unit tests) ------------------------

// Decode a DDG redirect href (`//duckduckgo.com/l/?uddg=<enc>&rut=...`) to the
// real target URL. Returns the input unchanged if it carries no uddg param.
export function decodeUddg(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (!m) {
    // Absolute or protocol-relative direct link.
    if (href.startsWith("//")) return `https:${href}`;
    return href;
  }
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return "";
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Parse the DDG-lite results page into structured results. Tolerant of markup
// drift: it scans for `class="result-link"` anchors and pairs each with the
// nearest following `class="result-snippet"` cell.
export function parseDdgLite(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const linkRe =
    /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1]));
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = linkRe.exec(html))) {
    const url = decodeUddg(m[1]);
    const title = stripTags(m[2]);
    if (!url || !title) {
      i++;
      continue;
    }
    out.push({ title, url, snippet: snippets[i] ?? "" });
    i++;
  }
  return out;
}

// --- public API -------------------------------------------------------------

const SEARCH_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 8 * 1024;

// Search the free backend; returns up to k results. Error-tolerant: [] on any
// failure. SIM reads the canned fixture instead of the network.
export async function search(query: string, k = 6): Promise<SearchResult[]> {
  if (isSim()) {
    const fx = loadFixture();
    const hit = fixtureLookup(fx?.search, query) ?? [];
    return hit.slice(0, k);
  }
  // Aggregate keyless news RSS providers (Google News + Bing News). These do
  // not CAPTCHA the way the DDG HTML endpoint now does, and news is the primary
  // evidence a forecaster needs. Results are deduped by host+title.
  const q = encodeURIComponent(query);
  const feeds = [
    `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
    `https://www.bing.com/news/search?q=${q}&format=rss`,
  ];
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const feed of feeds) {
    try {
      const res = await fetch(feed, { headers: { "User-Agent": UA, Accept: "application/rss+xml,text/xml" }, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
      if (!res.ok) continue;
      for (const r of parseRss(await res.text())) {
        const key = (r.title || r.url).toLowerCase().slice(0, 80);
        if (seen.has(key) || !r.title) continue;
        seen.add(key);
        out.push(r);
        if (out.length >= k) return out;
      }
    } catch {
      /* skip a flaky feed */
    }
  }
  return out.slice(0, k);
}

// Parse RSS <item> blocks into search results (title, link, description snippet).
function parseRss(xml: string): SearchResult[] {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  const pick = (block: string, tag: string) => {
    const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
    if (!m) return "";
    return m[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/&(#\d+|[a-z]+);/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  };
  return items.map((b) => ({ title: pick(b, "title"), url: pick(b, "link"), snippet: pick(b, "description").slice(0, 300) })).filter((r) => r.url);
}

// Fetch a URL and return readable plain text (scripts/styles/tags stripped,
// whitespace collapsed, capped at maxBytes). "" on any failure. SIM uses the
// fixture's `fetch` map.
export async function fetchReadable(url: string, maxBytes = DEFAULT_MAX_BYTES): Promise<string> {
  if (isSim()) {
    const fx = loadFixture();
    const text = fixtureLookup(fx?.fetch, url) ?? "";
    return text.slice(0, maxBytes);
  }
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,text/plain" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return "";
    const ct = res.headers.get("content-type") ?? "";
    let body = await res.text();
    // Drop script/style blocks before stripping tags.
    body = body
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
    const text = ct.includes("text/html") || /<[a-z!]/i.test(body) ? stripTags(body) : body.replace(/\s+/g, " ").trim();
    return text.slice(0, maxBytes);
  } catch {
    return "";
  }
}
