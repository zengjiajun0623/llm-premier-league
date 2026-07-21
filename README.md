# LLM Premier League

A fully autonomous, agent-driven benchmark that ranks LLMs by making them **debate each other** in a football-style league: a double round-robin where every model faces every other model twice, once on each side of the motion. Elo with bootstrap confidence intervals is the ranking; season titles are the trophy cabinet.

## Why a league (not a cup)

A knockout crowns a champion off a handful of noisy debates and starves eliminated models of data. A double round-robin gives every model identical exposure, cancels side advantage by construction (home leg = PRO, away leg = CON), and feeds a per-debate Elo that converges across seasons. A cup mode (groups + knockout) is kept for spectacle: `--mode cup`.

## Fully autonomous design

- **Motions are model-generated**: at season kickoff every competitor proposes 5 motions; the pool is deduped and curated by a neutral model. A model never debates a motion it proposed. `topics.json` is the static fallback.
- **Judging is by peers**: the jury is drawn from competitors not on the floor (all of them, or a seeded rotating subset when `maxJury` caps jury size for cost — every peer still judges a large share of the season). No hand-curated judge list. Judges see only "Debater A/B" — identities hidden. Majority vote decides; rubric scores (logic, evidence, responsiveness, clarity; 0-40 each) break ties; a true tie is a draw (1 point each). Set `judging: "panel"` for a curated panel instead.
- **Judge accountability is public**: the Stats page tracks each judge's votes, PRO-side lean, and agreement with the majority.
- **Standard harness for everyone**: every debater runs through the same minimal chat harness — identical system prompt, word limits, temperature, and token caps via OpenRouter. No vendor agent scaffolding, so the benchmark measures the model, not harness fit.

## Format

- A match = one debate: opening → rebuttal → closing (both sides, full transcript visible).
- League scoring: win 3, draw 1, loss 0; table tiebreak by judge-score differential, then head-to-head.
- Ranking: Elo (K=32) over every debate across all seasons, with bootstrap 95% CIs; titles/podiums/avg placement from finished seasons.
- Every debate checkpoints to `results/season-*.json`; interrupted seasons resume exactly. Draws and schedules are seed-deterministic.

## Usage

Needs `OPENROUTER_API_KEY` in the environment (falls back to `~/anon-router/.env`).

```bash
npm install
npm start -- run                        # one flagship league season (8 models, 56 debates)
npm start -- run --mode cup             # World Cup spectacle mode
npm start -- run --seasons 3            # several seasons, different schedules
npm start -- run --cheap                # budget lineup for testing
npm start -- rankings                   # all-time table
npm start -- smoke                      # single cheap debate, pipeline check
npx tsx src/server.ts                   # live viewer + open JSON API on :5199
```

## Viewer

`src/server.ts` serves a scoreboard UI: leaderboard (the centerpiece), live match view with speech-by-speech streaming, full match archive with transcripts and every judge's vote, per-model pages, and judge-bias stats. Open data endpoints: `/api/summary`, `/api/live`, `/api/debates`, `/api/debate`, `/api/stats`.

## Known limitations (reviewed by Codex and Kimi K3, 2026-07-20)

Adopted from review: same motion for both legs of a pairing (side-difficulty cancels; legs cluster together in the bootstrap), motion proposer excluded from judging that debate, judge temperature 0.2, curator rotates with the season seed, judge scores clamped, transcripts flagged as untrusted input to judges.

Accepted risks, disclosed rather than solved: peer judges are competitors (collusion/strategic voting is structurally possible; mitigated by anonymization, per-judge public bias stats, and majority-of-many); stylometric self-recognition through anonymization; judges cannot fact-check evidence, so confident fabrication can score; the fixed 3-turn word-capped format measures "debate in this harness," not general intelligence. Elo treats peer-judged outcomes as cleaner paired comparisons than they are — the bootstrap CI understates model-level uncertainty; a hierarchical Bradley-Terry model with judge/motion/side effects is the planned upgrade.

## Verification loop

`./verify.sh` (also `npm run verify`) runs before any real-money season and after every code change:

1. Typecheck.
2. `test/` via node:test — unit invariants (fixtures, standings, tiebreaks, Elo/CI math, divisions) plus a **full simulated season**: `LLM_SIM=1` replaces every model call with deterministic offline fakes, so an entire league (motions → debates → peer verdicts → table → placements) runs end to end in about a second. The e2e suite asserts the design invariants directly: same motion across both legs with sides swapped, proposer never debates nor judges its own motion, juries exclude debaters, interrupted seasons resume to byte-identical results, and the server API keeps division Elo pools disjoint with flagship listed first.
3. Frontend consistency: the inline script must parse and may only reference API fields the server actually serves (this class of drift is what once put dev and flagship models on one leaderboard).

## Cost

Flagship league season = 56 debates + peer judging ≈ $6-8 via OpenRouter. Cheap lineup ≈ 30x less.
