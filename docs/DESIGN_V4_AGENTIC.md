# v4: Agentic Benchmark (designed by Fable 5, 2026-07-21)

## Premise

Benchmark agentic capability - tool use, internet search, computer use - not
just text. Keep the invariant that has defined this project: reality or
execution judges, never an LLM, never a human. Forecasting is the ideal
agentic task because (a) real future events resolve it mechanically, (b) doing
it *well* requires agency (search the web, read sources, run calculations),
and (c) the value tools add is directly measurable. Track A makes forecasting
agentic; Track B extends to checkable computer-use tasks.

## Principle: benchmark the model at FULL agentic capability

A naked text prompt undersells a model - in production an LLM is an agent with
tools, planning, memory, and the ability to iterate. So we put every model in a
genuinely CAPABLE agent harness and measure what it can do. The primary ranking
is full-capability agentic performance, reality-graded.

Two design axes, and we resolve them opposite to the naive instinct:
- **Capability: MAXIMAL, not minimal.** The harness gives the model a real
  agent loop - generous tool-call budget, a planning/scratchpad channel,
  search + browse + code execution + short-term memory, self-correction and
  retry. Let the model show its full agency.
- **Identity: IDENTICAL across models.** The same rich harness for everyone.
  The thing to avoid is not richness - it is each lab's PROPRIETARY scaffold,
  which would confound "who wrote a better agent framework" with "which model
  is smarter." One shared, open, full-capability harness measures the model
  *as an agent*, which is the whole point.

## The full-capability harness over a FROZEN evidence pool

Both reviewers (Kimi, Codex) independently rejected live-web ranking as
non-reproducible and unfair (timing luck, provider churn). The resolution keeps
FULL agency while fixing fairness: freeze the evidence universe, not the agency.

**Per-question evidence snapshot (built before any model runs):** a fixed,
disclosed provider panel expands the question into many seed queries (topic-,
entity-, and date-based), fetches top-k results and their page text, dedups
into an evidence pool of N documents, hashes every source, timestamps it. This
pool is IDENTICAL for all models and is the rated evidence universe.

**The agent loop (identical for all, deliberately powerful):**
- `web_search(query)` -> retrieval over the FROZEN pool (arbitrary queries;
  better queries retrieve better - query skill is preserved and measured).
- `web_fetch(id)` -> full text of a pooled document (equal byte cap).
- `run_python(src)` -> the existing hermetic podman sandbox.
- `scratchpad(note)` / short-term memory the model manages itself.
- Multi-step: the model plans, acts, observes, revises, self-corrects. Budget
  is pilot-set at 10 calls, then RESET from measured p95 cost/question,
  pre-registered per question class, IDENTICAL across models (never adaptive,
  never per-model). Failed platform tool calls are retried at most once then
  charged to budget (no free-retry exploit). Every call+result logged; full
  per-question transcripts published.

Agency preserved (arbitrary multi-step queries over a broad pool); the only
thing removed is timing luck. Shared crawl also amortizes search cost.

**Live-web arm**: kept as a SEPARATE, UNRATED exhibition/robustness track, not
the leaderboard - it shows real-world behavior and flags snapshot coverage gaps.

## Secondary diagnostic: tool uplift

To separate research skill from base knowledge, also run a **closed-book** arm
(no tools, from parametric memory - the existing League 2). Then
`uplift = Brier(closed) - Brier(agentic)`. Uplift is a DIAGNOSTIC, never the
headline (it is a difference of noisy scores, has a headroom/regression-to-mean
confound, and is gameable by sandbagging the closed arm). Headline = agentic
Brier skill score with cluster-bootstrap CIs. Uplift is reported with paired
cluster-bootstrap CIs AND a regression-to-mean correction (regress uplift on
closed-book Brier; report residuals). To decompose WHERE uplift comes from, add
a **no-web control arm**: same scaffold, budget, and thinking-token allowance
but `run_python` only (no search). Search-uplift = Brier(no-web) - Brier(full);
this separates genuine research gain from "extra thinking tokens" and compute.

## Track A - Agentic Forecasting (flagship, ship first)

Questions: templated future-event questions (existing feed machinery), plus new
templated categories that reward research over a random-walk price guess:
scheduled releases, sports fixtures, dated economic prints, on-chain metrics -
anything with a mechanical public resolution source and a deadline far enough
out that the answer is not yet knowable but evidence exists. No model authors
questions (seeded draws over public feeds); reality resolves; Brier scores.

Grading: identical to League 2 (proper scoring rule, signal-weighted by horizon,
cluster-bootstrap CIs). Ratings for closed, agentic, and uplift.

## Track B - Agentic Tasks with checkable end-states (computer/tool use, phase 2)

For capabilities forecasting does not exercise (computer use, multi-step tool
orchestration), use tasks whose SUCCESS is machine-checkable, so grading stays
judge-free:
- A task = a goal + a deterministic checker over the end-state (e.g. "using the
  provided tools, find the value of X and write it as the answer" where the
  checker verifies the answer; or a sandboxed web/app environment where the
  checker inspects final DOM/file/db state).
- Same neutral harness; success is binary; Bradley-Terry or pass-rate over a
  task corpus admitted by the same mechanical mutation/fuzz gates as League 1.
- Computer use (GUI control) is the heaviest: real determinism and fair
  environments are hard, so it is explicitly phase 2, gated on Track A proving
  the harness. Honest scope: start with tool-use + web tasks that have
  checkable end-states; add GUI computer-use environments only when we can make
  them deterministic, free-to-run, and non-gameable.

## Anti-gaming and validity (revised per Kimi + Codex)

1. **Reproducibility = frozen per-question evidence pool** (see harness). The
   rated board never touches the live web. Live-web is a separate unrated track.
2. **Liquid-market leakage - mechanical, pre-registered thresholds,
   re-checked at prediction time.** A detector queries a FIXED source panel:
   Polymarket (Gamma API), Manifold (API), Kalshi (trade API), and one fixed
   sports-odds aggregator; matched to a question via its template->contract map
   plus fuzzy title search. **A market is LIQUID (question excluded from the
   headline board) if ALL hold:** (i) >= $25,000 cumulative traded volume
   (Manifold: >= 300 unique traders), (ii) >= 14 days of trading history ending
   on or after the question's creation date, (iii) either a two-sided spread
   < 5% or a last trade within the past 7 days. Uncertain/ambiguous matches are
   quarantined (treated as liquid = excluded). Re-checked at PREDICTION time (a
   market can open mid-flight -> drop). **Post-run leakage flag**: if any model
   transcript fetched a domain on the disallowed-market blocklist for that
   question, it is auto-removed from the headline. Separate unrated "beat the
   market" track keeps liquid-market questions with the market odds as baseline.
3. **Contamination - stated honestly, not overclaimed.** Future-only events kill
   answer leakage, NOT method contamination (templates, resolution sources,
   scaffold, tool APIs, and search strategies learned from public
   forecasting-corpus/benchmark transcripts). Disclosed as a residual limitation.
4. **Cost is an operating protocol, not a hope.** 10-call budget is PILOT-ONLY.
   Lock the question mix first; measure p95 cost/question; set the real cap from
   that, pre-registered per question class, identical across models. Publish
   $/question next to every score. The suite must not silently shrink to cheap
   questions to fit a cap.
5. **Tool-failure fairness without an exploit.** A failed platform tool call is
   retried at most once, then charged to budget - a model cannot farm free
   retries by spamming flaky calls.
6. **Harness-relativity, disclosed.** A single harness measures "model x this
   harness." Each release runs a SECOND harness profile (different tool-schema
   style, different k) on a subsample and publishes the cross-harness rank
   correlation; if rho < 0.9 we say so loudly. All results labeled
   "harness-relative"; the search provider panel, index date, and a retrieval-
   quality probe report are published so absolute numbers are not over-read.
7. **Arm-order randomized** per question (closed / no-web / full) so no arm
   systematically benefits from schedule position.

## Build order

(A1) Neutral tool harness (search+fetch+python) as one module + sim mode.
(A2) Agentic forecasting: agentic arm alongside the existing closed arm; uplift
scoring; per-question tool transcripts. (A3) Site: closed vs agentic vs uplift
boards + a sample tool transcript. (B1) Checkable tool-use task corpus + harness
reuse. (B2) Computer-use environments (deferred, honesty-gated).

## Round-1 review resolutions (Kimi + Codex, both applied)

1. Headline = agentic Brier skill score with CIs. Uplift demoted to diagnostic
   with RTM correction + a no-web control arm to decompose search vs compute.
2. Rated board runs on a FROZEN per-question evidence pool (arbitrary queries
   over it, so agency and query-skill are preserved); live web is unrated.
3. Liquid-market: mechanical pre-registered detector, re-checked at prediction
   time, post-run leakage auto-removal, separate "beat the market" track.
4. Fixed disclosed provider panel builds the frozen index; retrieval-quality
   probe report published; results labeled "harness-relative."
5. Track B: deterministic checkable end-states only (DOM/file/DB/CLI); computer
   use approximated by checkable browser end-states; pixel GUI = unranked annex.
6. Budget: 10-call pilot only; real cap from measured p95 cost/question,
   pre-registered per class, identical across models, never adaptive.
7. Cross-harness robustness (second profile on a subsample, publish rank rho).

## Coverage gate (adopted, per both reviewers)

Pre-registered coverage gate at generation time: a question is dropped before
rating if its evidence pool misses a pre-registered "gold" source set (too thin
a pool degrades into a closed-book test with extra steps). Mechanical, cheap;
because the pool is identical across models, under-coverage is noise not
unfairness, but the gate protects construct validity. In the pre-registration
before launch.

## Review outcome (2026-07-21)

Both reviewers PASS. Kimi K3 (round 2) and Codex (round 3): no remaining
blockers. Design locked. Build order stands: (A1) full-capability harness over
frozen evidence pool + sim; (A2) agentic forecasting arm + no-web control +
uplift diagnostic on the existing Brier machinery; (A3) site boards; (B) checkable
tool/computer-use tasks. External dependency for the live arm: a search API key
(Brave/Serper/Tavily) to build the per-question evidence crawl.
