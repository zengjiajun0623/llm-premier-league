// Track A — per-question FROZEN evidence pool builder.
//
// Before any model runs, expand a forecasting question into seed queries, search
// each over the free backend (search.ts), fetch the top pages, and dedup the
// readable text into a pool of documents. The pool is hashed + timestamped and
// persisted atomically to results/evidence-<qid>.json. It is IDENTICAL for every
// model (built once), which is what makes the rated board reproducible and fair.
//
// COVERAGE GATE: if the pool has fewer than MIN_DOCS usable documents it is
// marked `underCovered`; the caller (run.ts) drops such a question from the rated
// set (too thin a pool degrades into a closed-book test with extra steps).

import { writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { resultsDir } from "../paths.js";
import { search, fetchReadable, type SearchResult } from "./search.js";

export interface EvidenceDoc {
  id: string; // stable per-pool doc id ("d1", "d2", ...)
  url: string;
  title: string;
  text: string;
  hash: string; // sha256 of text (dedup + provenance)
}

export interface EvidencePool {
  qid: string;
  question: string; // human-readable question statement
  builtAt: string; // ISO timestamp of the crawl
  queries: string[]; // the seed queries that were run
  docs: EvidenceDoc[];
  minDocs: number;
  underCovered: boolean; // docs.length < minDocs
}

// A minimal shape the crawler needs; the real Question (feeds.ts) is a superset.
export interface CrawlQuestion {
  id: string;
  asset: string;
  threshold: number;
  horizon: string;
  resolveAt: number;
  spotAtCreate?: number;
}

const MIN_DOCS_DEFAULT = 4;
const MIN_TEXT_LEN = 120; // shorter than this = not a usable doc
const PER_QUERY_RESULTS = 5;
const MAX_DOCS = 12;

export function minDocs(): number {
  const v = Number(process.env.AGENTIC_MIN_DOCS);
  return Number.isFinite(v) && v > 0 ? v : MIN_DOCS_DEFAULT;
}

function evidencePath(qid: string): string {
  return join(resultsDir(), `evidence-${qid}.json`);
}

function writeJson(path: string, data: object): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Human-readable statement of the templated question (also the pool's title).
export function questionStatement(q: CrawlQuestion): string {
  const when = new Date(q.resolveAt).toISOString().slice(0, 10);
  return `Will the price of ${q.asset} (USD) be at or above ${q.threshold} on ${when}?`;
}

// Derive seed queries from the question: entity + forecast/news/date terms. Kept
// mechanical (no model input) so the pool is reproducible from the question alone.
export function seedQueries(q: CrawlQuestion): string[] {
  const when = new Date(q.resolveAt).toISOString().slice(0, 10);
  const month = new Date(q.resolveAt).toISOString().slice(0, 7);
  const asset = q.asset;
  return [
    `${asset} price forecast ${month}`,
    `${asset} price prediction ${when}`,
    `${asset} news ${month}`,
    `${asset} price analysis`,
    `${asset} usd price today`,
  ];
}

export function loadEvidencePool(qid: string): EvidencePool | null {
  const p = evidencePath(qid);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as EvidencePool;
  } catch {
    return null;
  }
}

export interface BuildOptions {
  force?: boolean; // rebuild even if a pool file already exists
  perQuery?: number; // results fetched per seed query
  maxDocs?: number; // cap on total docs
}

// Build (or load-if-present) the frozen evidence pool for a question. Idempotent:
// an existing pool file is returned untouched unless `force`. The pool is
// persisted atomically before return.
export async function buildEvidencePool(q: CrawlQuestion, opts: BuildOptions = {}): Promise<EvidencePool> {
  if (!opts.force) {
    const existing = loadEvidencePool(q.id);
    if (existing) return existing;
  }
  const perQuery = opts.perQuery ?? PER_QUERY_RESULTS;
  const cap = opts.maxDocs ?? MAX_DOCS;
  const queries = seedQueries(q);

  // Search every seed query; collect candidate result links (deduped by URL).
  const seen = new Set<string>();
  const candidates: SearchResult[] = [];
  for (const query of queries) {
    const results = await search(query, perQuery);
    for (const r of results) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      candidates.push(r);
    }
  }

  // Fetch each candidate's readable text; keep usable (long-enough) docs, deduped
  // by content hash so mirror pages don't inflate the pool.
  const docs: EvidenceDoc[] = [];
  const hashes = new Set<string>();
  for (const c of candidates) {
    if (docs.length >= cap) break;
    const body = (await fetchReadable(c.url)).trim();
    // Redirect/consent pages (e.g. Google News links) yield near-empty bodies;
    // fall back to the RSS snippet, which is genuine headline+summary evidence.
    const combined = (c.snippet ? `${c.title}. ${c.snippet}` : body).trim();
    const usable = body.length >= MIN_TEXT_LEN ? `${c.snippet ?? ""}\n\n${body}`.trim() : combined;
    if (usable.length < 60) continue; // headline+snippet floor
    const hash = sha256(usable);
    if (hashes.has(hash)) continue;
    hashes.add(hash);
    docs.push({ id: `d${docs.length + 1}`, url: c.url, title: c.title || c.url, text: usable, hash });
  }

  // Guaranteed structured evidence (no-key, no-CAPTCHA): current market data and
  // encyclopedic background, so the pool is never starved and every model gets
  // the same hard numbers to reason from.
  for (const extra of await structuredEvidence(q)) {
    if (docs.length >= cap) break;
    const hash = sha256(extra.text);
    if (hashes.has(hash)) continue;
    hashes.add(hash);
    docs.unshift({ id: `d0-${docs.length}`, url: extra.url, title: extra.title, text: extra.text, hash });
  }

  const md = minDocs();
  const pool: EvidencePool = {
    qid: q.id,
    question: questionStatement(q),
    builtAt: new Date().toISOString(),
    queries,
    docs,
    minDocs: md,
    underCovered: docs.length < md,
  };
  writeJson(evidencePath(q.id), pool);
  return pool;
}

// CoinGecko market data + Wikipedia summary as guaranteed evidence docs.
// Both are free/no-key/no-CAPTCHA and identical for all models.
async function structuredEvidence(q: CrawlQuestion): Promise<{ url: string; title: string; text: string }[]> {
  if (process.env.AGENTIC_SIM === "1") return [];
  const asset = q.asset.toLowerCase();
  const out: { url: string; title: string; text: string }[] = [];
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/${asset}?localization=false&tickers=false&community_data=false&developer_data=false`, { signal: AbortSignal.timeout(12000) });
    if (r.ok) {
      const d: any = await r.json();
      const m = d.market_data;
      out.push({
        url: `https://www.coingecko.com/en/coins/${asset}`,
        title: `${d.name} market data (CoinGecko, ${new Date().toISOString().slice(0, 10)})`,
        text: `${d.name} (${(d.symbol || "").toUpperCase()}) current price $${m.current_price.usd}. 24h change ${m.price_change_percentage_24h?.toFixed(2)}%, 7d ${m.price_change_percentage_7d?.toFixed(2)}%, 30d ${m.price_change_percentage_30d?.toFixed(2)}%. 24h range $${m.low_24h.usd}-$${m.high_24h.usd}. All-time high $${m.ath.usd} (${(m.ath_change_percentage.usd)?.toFixed(1)}% from ATH). Market cap rank ${d.market_cap_rank}.`,
      });
    }
  } catch { /* skip */ }
  try {
    const wiki = q.asset.charAt(0).toUpperCase() + q.asset.slice(1);
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wiki)}`, { signal: AbortSignal.timeout(12000) });
    if (r.ok) {
      const d: any = await r.json();
      if (d.extract) out.push({ url: d.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${wiki}`, title: `${d.title} (Wikipedia)`, text: d.extract });
    }
  } catch { /* skip */ }
  return out;
}

export { evidencePath };
