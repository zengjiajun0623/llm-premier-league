// Track A — the pi agent harness the models actually run inside.
//
// This is a THIN wrapper: it registers web_search / web_fetch / run_python as pi
// tools and delegates every call to the shared, tested core (src/agentic/
// tools-core.ts). The core reads the FROZEN evidence pool (env EVIDENCE_FILE),
// enforces the tool-call BUDGET (env AGENTIC_BUDGET, default 12), and logs every
// call to the research transcript (env TRANSCRIPT_FILE). Keeping the logic in the
// core keeps this file typebox-only so the tools stay unit-testable without pi.
//
// Loaded via: pi ... --no-builtin-tools -e pi-ext/agentic-tools.ts

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createHarness, loadPool, DEFAULT_BUDGET, type Harness } from "../src/agentic/tools-core.ts";

function makeHarness(): Harness {
  const evidenceFile = process.env.EVIDENCE_FILE;
  if (!evidenceFile) throw new Error("EVIDENCE_FILE env var is required for the agentic harness");
  const budget = Number(process.env.AGENTIC_BUDGET);
  return createHarness({
    pool: loadPool(evidenceFile),
    budget: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET,
    transcriptFile: process.env.TRANSCRIPT_FILE,
  });
}

export default function (pi: ExtensionAPI) {
  // One harness per pi process; budget + transcript state persist across calls.
  const harness = makeHarness();

  pi.registerTool({
    name: "web_search",
    label: "Evidence Search (frozen pool)",
    description:
      "Search the FROZEN per-question evidence pool with keywords. Returns the top matching documents' ids, titles, and snippets. This does NOT hit the live web — it retrieves over a fixed snapshot that is identical for every model. Better queries retrieve better evidence.",
    parameters: Type.Object({ query: Type.String({ description: "keyword search query" }) }),
    async execute(_id, params) {
      const r = harness.web_search(String((params as { query: string }).query));
      return { content: [{ type: "text", text: r.text }], details: { budgetExhausted: !!r.budgetExhausted } };
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Evidence Fetch (frozen pool)",
    description:
      "Fetch the full text of one pooled document by its id (e.g. 'd3'), as returned by web_search. Reads only the frozen evidence pool.",
    parameters: Type.Object({ id: Type.String({ description: "pooled document id, e.g. d1" }) }),
    async execute(_id, params) {
      const r = harness.web_fetch(String((params as { id: string }).id));
      return { content: [{ type: "text", text: r.text }], details: { budgetExhausted: !!r.budgetExhausted } };
    },
  });

  pi.registerTool({
    name: "run_python",
    label: "Run Python",
    description:
      "Execute a short Python 3 script for scratch calculation (probabilities, arithmetic over figures you found). Print results to stdout. No network.",
    parameters: Type.Object({ src: Type.String({ description: "python3 source to execute" }) }),
    async execute(_id, params) {
      const r = harness.run_python(String((params as { src: string }).src));
      return { content: [{ type: "text", text: r.text }], details: { budgetExhausted: !!r.budgetExhausted } };
    },
  });
}
