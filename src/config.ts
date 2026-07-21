import type { Config } from "./types.js";

// 8 labs, one current flagship each (OpenRouter slugs verified live 2026-07-20).
export const FLAGSHIP: Config = {
  division: "flagship",
  // One league, one entry per lab, aligned with arena.ai/leaderboard/agent
  // (their board is human-judged; ours is peer-LLM-judged over the same field).
  // Sonnet 5 excluded by owner's call: Fable 5 + Opus 4.8 represent Anthropic.
  competitors: [
    "anthropic/claude-fable-5",
    "anthropic/claude-opus-4.8",
    "openai/gpt-5.6-sol",
    "moonshotai/kimi-k3",
    "z-ai/glm-5.2",
    "x-ai/grok-4.5",
    "qwen/qwen3.7-max",
    "google/gemini-3.1-pro-preview",
    "deepseek/deepseek-v4-pro",
    "meta/muse-spark-1.1",
    "minimax/minimax-m3",
    // inkling (Thinking Machines) swapped out 2026-07-21: persistent upstream
    // 429s stalled a season; Mimo V2.5 Pro is the next arena-listed lab.
    "xiaomi/mimo-v2.5-pro",
  ],
  // Rotating jury: 5 peers per match, seeded rotation over the eligible pool.
  // Majority-of-5 is robust to a single biased or erratic judge.
  maxJury: 5,
  judging: "peers",
  // Panel mode fallback only (judging: "panel").
  judgePool: [
    "anthropic/claude-opus-4.8",
    "openai/gpt-5.5",
    "google/gemini-3.1-pro-preview",
    "x-ai/grok-4.5",
    "deepseek/deepseek-v4-pro",
  ],
  judgesPerMatch: 3,
  generateTopics: true,
  topicsPerCompetitor: 5,
  // Headroom for reasoning models: hidden thinking spends from the same
  // budget; word limits in the prompts still cap the visible speech length.
  debaterMaxTokens: 900,
  judgeMaxTokens: 700,
  seed: 1,
};

// Cheap lineup for smoke-testing the pipeline (~100x cheaper).
export const CHEAP: Config = {
  division: "dev",
  competitors: [
    "deepseek/deepseek-v4-flash",
    "qwen/qwen3.6-flash",
    "openai/gpt-5.4-nano",
    "google/gemini-3.1-flash-lite",
  ],
  judging: "peers",
  judgePool: [
    "openai/gpt-5.4-mini",
    "deepseek/deepseek-v4-pro",
    "qwen/qwen3.6-plus",
    "google/gemini-3.1-flash-lite",
    "z-ai/glm-4.7",
  ],
  judgesPerMatch: 3,
  generateTopics: true,
  topicsPerCompetitor: 5,
  debaterMaxTokens: 700,
  judgeMaxTokens: 400,
  seed: 1,
};
