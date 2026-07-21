import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://openrouter.ai/api/v1/chat/completions";

function loadKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const env = readFileSync(join(homedir(), "anon-router/.env"), "utf8");
  const m = env.match(/OPENROUTER_API_KEY=(\S+)/);
  if (!m) throw new Error("OPENROUTER_API_KEY not found");
  return m[1];
}

let KEY: string | null = null; // lazy: sim mode and tests need no key

// LLM_SIM=1 short-circuits every model call with deterministic fake output so
// the whole tournament pipeline can run end-to-end in tests: free, offline,
// and reproducible (same inputs always produce the same season).
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function simChat(model: string, messages: ChatMessage[], opts: { json?: boolean }): ChatResult {
  const prompt = messages.map((m) => m.content).join("\n");
  const h = hashStr(`${model}||${prompt}`);
  if (prompt.includes('"keep"')) {
    const n = (prompt.match(/^\d+: /gm) ?? []).length;
    return { text: JSON.stringify({ keep: Array.from({ length: n }, (_, i) => i) }), costUsd: 0 };
  }
  if (prompt.includes("JSON array")) {
    const n = Number(prompt.match(/Propose (\d+)/)?.[1] ?? 5);
    const arr = Array.from({ length: n }, (_, i) => `Sim motion by ${model} #${i}: society should adopt policy ${i} despite the tradeoffs.`);
    return { text: JSON.stringify(arr), costUsd: 0 };
  }
  if (opts.json || prompt.includes('"winner"')) {
    return {
      text: JSON.stringify({ scoreA: 20 + (h % 15), scoreB: 20 + ((h >> 4) % 15), winner: h % 2 === 0 ? "A" : "B", reasoning: "sim verdict" }),
      costUsd: 0,
    };
  }
  return { text: `Sim speech ${h % 100000}: a structured argument for the assigned side, within the word limit.`, costUsd: 0 };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  costUsd: number;
}

export async function chat(
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  opts: { json?: boolean; temperature?: number } = {},
): Promise<ChatResult> {
  if (process.env.LLM_SIM === "1") return simChat(model, messages, opts);
  KEY ??= loadKey();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/jiajunzeng/llm-worldcup",
          "X-Title": "LLM Premier League",
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: opts.temperature ?? 0.7,
          usage: { include: true },
          // Keep hidden reasoning short on reasoning models so it cannot eat
          // the whole token budget and return an empty completion (ignored by
          // non-reasoning models).
          reasoning: { effort: "low" },
          ...(opts.json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status} from ${model}: ${body.slice(0, 300)}`);
      }
      const data: any = await res.json();
      if (data.error) throw new Error(`API error from ${model}: ${JSON.stringify(data.error).slice(0, 300)}`);
      const text: string = data.choices?.[0]?.message?.content ?? "";
      if (!text.trim()) throw new Error(`Empty completion from ${model}`);
      return { text, costUsd: data.usage?.cost ?? 0 };
    } catch (err) {
      lastErr = err;
      const wait = 2000 * (attempt + 1);
      console.error(`  [retry ${attempt + 1}] ${model}: ${(err as Error).message?.slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(`chat() failed for ${model}: ${(lastErr as Error).message}`);
}
