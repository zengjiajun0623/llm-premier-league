# v3 Ship Plan (2026-07-21)

## Goal

Ship **LLM Premier League v3**: the first fully autonomous, zero-human LLM
benchmark — no human authors any question, judges any match, or touches any
score — covering the arena.ai/leaderboard/agent field, and running itself
nightly.

Definition of shipped:
1. **Verified board** (adversarial refutation, execution-graded) is live and
   primary on https://llm-premier-league.vercel.app with two BT ladders
   (prover/refuter) + composite, CIs, per-class ratings.
2. **Persuasion board** (peer-judged debate) runs beside it, honestly labeled.
3. **Execution-vs-persuasion gap** table with significance is the headline.
4. The whole thing advances **autonomously on a nightly cadence** within a
   budget cap, survives provider outages, and republishes the site itself.
5. Every stage is gated by the **verification loop** (below).

## Verification loop (gates every milestone)

- `./verify.sh` — typecheck + full test suite + **simulated end-to-end runs of
  BOTH leagues** (`LLM_SIM=1`, `SANDBOX=local`): free, offline, deterministic.
  No code ships and no real-money run starts unless green.
- **Pilot gate before scale**: every new mechanism runs a cheap-roster
  real-money pilot first; measured cost/leg, forfeit rate, harness-void rate
  must be inside pre-set bands before the flagship roster runs.
- **Runtime invariants**: per-run budget cap aborts cleanly at the cap;
  provider failures defer, never stall; results files atomic + resumable.
- **Post-run audits** (published, not just logged): per-class discrimination,
  jury family-exclusion compliance, refutation reproducibility, cost per
  rating bit.

## Milestones

- **M1 — League-1 engine** (in progress, Opus executor): 5 platform-owned
  artifact classes, podman hermetic sandbox, match engine, two-ladder BT,
  sim tests. DoD: verify.sh green including sim refutation ladder.
- **M2 — Integrity + cost pilot**: cheap roster, real money (~$0.5). DoD:
  cost/leg measured; forfeit + void rates in band; refutations reproduce 3/3;
  go/no-go recorded.
- **M3 — Flagship verified ladder**: 12-model arena roster, enough rounds for
  non-provisional ratings on the main component. DoD: two boards + composite
  with CIs; per-class ratings.
- **M4 — Site v3**: Verified board primary; Persuasion board; gap table with
  CIs + significance; methodology page stating the zero-human claim and the
  honest labels ("survived adversarial refutation at budget B"). DoD: live on
  Vercel, mobile-checked.
- **M5 — Persuasion league resumes** under its new name/framing (existing
  debate engine; resolvable-motion judge calibration is phase 2). DoD: debate
  matchweeks run without human triggering, feed League-3 board.
- **M6 — Nightly autonomy**: scheduled matchweek runner (verified + debate)
  with budget cap, then refit + republish. DoD: two consecutive nights run
  with zero human touches, within budget, site updated.
- **M7 — Self-authored corpus**: admission pipeline (mutation gate, fuzz
  band, validator round-trip) for model-proposed artifact classes; bootstrap
  classes re-proposed through the same gates and retired if they fail.
  DoD: ≥1 model-proposed class admitted mechanically and rated.
- **M8 — Autonomous enrollment**: the nightly runner polls the OpenRouter
  catalog (and the arena board) for newly listed frontier models and enrolls
  them itself: ladder-median start, wide prior, provisional tag, placement
  mini-schedule vs top/median/bottom-quartile opponents, ≤20-25% of weekly
  budget for all newcomers combined, queueing on simultaneous launches, prior
  NEVER seeded from arena rank. DoD: a newly listed model appears on the board
  as provisional with zero human action.
- **Later**: forecasting league (templated), Lean proof classes, judge-weight
  calibration from resolvable motions, stylometry residual audit.

## Budget posture

M2 ≈ $0.5 · M3 ≈ $8-15 (measure at M2, don't guess) · nightly ≈ $3-5 capped.
Auto top-up is on; the cap is in config and enforced by the runner, not by
intention.

## M2 gate record (2026-07-21)

GO. Pilot verified-pilot-001, cheap roster, podman sandbox, 10 rated legs:
cost/leg $0.0029 (band: <$0.10), void rate 0% (band: <10%), forfeit rate 10%,
refutations reproduced 3/3. Role split confirmed informative (gemini: weakest
prover, top refuter). Refutation legs ~30x cheaper per rating bit than judged
debate. Proceeding to M3.

## M7 record (2026-07-21)

Pipeline live. First real autonomous admission: qwen3.7-max proposed
"longest-increasing-subarray"; gates passed (mutation 2/2 caught, constant
baseline fails 97%, band >= 30%). Wired into the ladder rotation with
proposer exclusion; it gets rated in the next verified round. Follow-up:
re-propose the five bootstrap classes through the same gates and retire any
that fail (queued for a coming night).

## Standing policy: incident to guard (2026-07-21)

Every incident closes with two artifacts, never one: the fix, and the
mechanical check that would have caught it, wired into verify.sh / audit /
publish gates. Applied so far: reasoning-model empty completions (token
budgets + sim probes), provider outages (deferral + retry passes), division
mixing (disjointness test), false championship (90% seal guard + audit),
misread analysis fields (domain checks + canonical reporter), out-of-envelope
refutations (retroactive envelope re-validation). This policy is self-
initiated: guards are built when the incident is found, not when requested.
