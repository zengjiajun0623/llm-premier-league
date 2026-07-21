// League 2 (Forecasting) — mechanical question generation.
//
// Design invariant (the whole point of this league): questions are TEMPLATED and
// non-model-authored. Models never write, nominate, or edit a scored question.
// Each question is drawn deterministically from (seed, feed snapshot) via seeded
// mulberry32 RNG over a FIXED asset list and FIXED templates, with a frozen,
// mechanically-resolvable criterion ("close at/above threshold at resolveAt").
// Because the feed is a free public price oracle (CoinGecko) and resolution is a
// pure numeric comparison, no judge — and no model — is ever in the loop.
//
// Feed: CoinGecko simple/price (no API key). Under FEED_SIM=1 a canned price map
// (env FEED_SIM_PRICES JSON, else defaults) is read instead of the network, so
// generation and resolution are fully offline and deterministic in tests.

import { mulberry32 } from "../rng.js";

// Fixed, pre-approved asset universe. CoinGecko ids.
export const ASSETS = ["bitcoin", "ethereum", "solana"] as const;
export type Asset = (typeof ASSETS)[number];

// Templated draw parameters (frozen; not model-authored).
const DELTAS = [0.02, 0.05, 0.1]; // threshold offset from spot
const HOUR_MS = 3_600e3;
const DAY_MS = 86_400e3;

// Resolution horizons. A short/long mix keeps the board LIVE (6h/24h resolve
// same-day) while long horizons (30d) test genuine foresight. `signalWeight`
// down-weights short horizons in the Brier ranking: over 6-24h an efficient
// liquid market is near a random walk, so short questions barely discriminate
// models; multi-day/weekly questions carry the real signal.
export interface Horizon {
  label: string;
  ms: number;
  signalWeight: number;
}
export const HORIZONS: Horizon[] = [
  { label: "6h", ms: 6 * HOUR_MS, signalWeight: 0.25 },
  { label: "24h", ms: 24 * HOUR_MS, signalWeight: 0.5 },
  { label: "3d", ms: 3 * DAY_MS, signalWeight: 1 },
  { label: "7d", ms: 7 * DAY_MS, signalWeight: 1 },
  { label: "30d", ms: 30 * DAY_MS, signalWeight: 1.5 },
];

export function signalWeightFor(label: string): number {
  return HORIZONS.find((h) => h.label === label)?.signalWeight ?? 1;
}

export interface Question {
  id: string;
  asset: Asset;
  kind: "close_above";
  threshold: number;
  horizon: string; // e.g. "6h","24h","3d","7d","30d"
  horizonMs: number;
  resolveAt: number; // epoch ms
  createdAt: number; // epoch ms
  spotAtCreate: number;
  // Per-model P(yes) in [0.01, 0.99], filled by predict.ts.
  predictions: Record<string, number>;
  // Resolution (resolve.ts), once resolveAt has passed.
  resolved?: boolean;
  outcome?: 0 | 1; // 1 if resolvedPrice >= threshold
  resolvedPrice?: number;
  resolvedAt?: number; // epoch ms the settlement price was read
}

export interface ForecastFile {
  id: string;
  createdAt: string;
  updatedAt: string;
  roster: string[];
  questions: Question[];
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function defaultSimPrices(): Record<string, number> {
  return { bitcoin: 60000, ethereum: 3000, solana: 150 };
}

// Current spot for a set of CoinGecko ids. FEED_SIM=1 short-circuits the network.
export async function fetchPrices(ids: readonly string[]): Promise<Record<string, number>> {
  if (process.env.FEED_SIM === "1") {
    const canned = process.env.FEED_SIM_PRICES
      ? (JSON.parse(process.env.FEED_SIM_PRICES) as Record<string, number>)
      : defaultSimPrices();
    const out: Record<string, number> = {};
    for (const id of ids) {
      if (typeof canned[id] !== "number") throw new Error(`FEED_SIM: no canned price for ${id}`);
      out[id] = canned[id];
    }
    return out;
  }
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, { usd?: number }>;
  const out: Record<string, number> = {};
  for (const id of ids) {
    const p = data[id]?.usd;
    if (typeof p !== "number") throw new Error(`CoinGecko: no usd price for ${id}`);
    out[id] = p;
  }
  return out;
}

// Deterministic given (seed, feed snapshot): one question per asset. The seed
// scopes an entire question set (a "pose"); per-asset draws are decorrelated by
// xor-ing a stable asset hash into the RNG seed.
export async function generateQuestions(seed: number, nowMs: number): Promise<Question[]> {
  const prices = await fetchPrices(ASSETS);
  const questions: Question[] = [];
  for (const asset of ASSETS) {
    const spot = prices[asset];
    // One question per (asset, horizon) so every pose spans the full 6h..30d
    // range: short ones resolve today, long ones test foresight.
    for (const horizon of HORIZONS) {
      const rnd = mulberry32((seed >>> 0) ^ hashStr(asset) ^ hashStr(horizon.label));
      const delta = DELTAS[Math.floor(rnd() * DELTAS.length)];
      const above = rnd() < 0.5; // threshold above or below spot
      const threshold = Math.round(spot * (1 + (above ? delta : -delta)) * 100) / 100;
      questions.push({
        id: `${asset}-${horizon.label}-${seed}`,
        asset,
        kind: "close_above",
        threshold,
        horizon: horizon.label,
        horizonMs: horizon.ms,
        resolveAt: nowMs + horizon.ms,
        createdAt: nowMs,
        spotAtCreate: spot,
        predictions: {},
      });
    }
  }
  return questions;
}
