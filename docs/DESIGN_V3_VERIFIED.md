# LLM Premier League v3: Verified Core, Judged Show (initial spec, 2026-07-21)

## Premise

Zero-human autonomous benchmark. v2's insight (ladder + Bradley-Terry) stays.
v3 changes the *scoring substrate*: LLM-as-judge is a fallback, not a primitive.
Judged debate measures "persuasiveness to a population of LLM juries" — real,
but not intelligence, and it has a ceiling at the jury's competence plus known
biases (verbosity, confidence, stylometric self-preference). The fix: make
reality the judge; use models only to set the exam. Three leagues, ranked by
epistemic weight, all feeding Bradley-Terry ladders.

## League 1 — Verified self-play (the backbone)

**Prover-refuter code games.** A match between models A and B:
1. A submits an artifact: a program P plus a machine-checkable claim C
   ("P satisfies spec S on any input meeting precondition Q"). The spec S is
   itself executable (property checker / reference oracle / test harness).
2. B gets P + C + S and must produce a refutation: a concrete input x meeting Q
   such that P violates S on x. B has N attempts (config, default 3).
3. Execution decides: if any x breaks P, refuter wins the leg. If none do,
   prover wins. Sides swap for the return leg (same-artifact-class, fresh
   artifact). No judge anywhere in the loop.

**Task generation is self-play too**: the prover authors P and C. Difficulty
scales automatically with the population; every artifact is fresh (no
training-set contamination). Degenerate-task filter without humans:
- C must be *demonstrably nontrivial*: prover must also supply 3 passing
  example inputs (executed to confirm P meets S on them; otherwise forfeit).
- Discrimination filter at the season level: artifact classes where win rate
  is ~100% for either role across the board stop counting for rating.
- Sandbox: execution in a resource-limited container (time/memory caps,
  no network); infinite-loop or crash of the *harness* voids the leg (replay
  with fresh artifact), crash of P on a valid x is a refutation win.

**Lean proof games (phase 2)**: prover proposes conjecture + proof, Lean kernel
checks; refuter may instead submit a counterexample/disproof. Same BT ladder.

**Rating**: leg-level BT exactly as v2 (bt.ts), outcome in {0,1} (execution is
binary), cluster = artifact pair. Separate ladder: `verified` division.

## League 2 — Forecasting (slow, purest signal)

Weekly question set generated mechanically from public feeds with unambiguous
resolution criteria (market prices at T, sports scores, weather station
readings, scheduled releases). Every model answers with a probability; scored
by proper scoring rule (Brier) at resolution. No judge; reality resolves.
Runs as a background league; ratings = rolling Brier skill score vs the field
median. Feeds a third board: `forecast`.

## League 3 — Judged debate (kept, demoted, repriced)

The existing v2 debate ladder continues as the persuasion/argumentation axis
and the spectator product. Changes:

1. **Resolvable-motion calibration**: a fraction (~25%) of motions are seeded
   with machine-resolvable claims (code behavior, math facts checkable by
   execution, forecast-style claims that resolve). Judges are scored on
   whether they voted for the objectively correct side.
2. **Earned jury weight**: a judge's vote weight on open motions =
   f(accuracy on resolvable motions, League-1 rating). Anchor chain bottoms
   out in executed artifacts, not opinions. Weights published.
3. **Stylometry kill**: transcripts pass through a neutral paraphrase
   normalizer (one fixed cheap model, temperature 0) before judging; PRO/CON
   and presentation order randomized; residual self-preference audited and
   published. (Cost: +1 cheap call per speech.)
4. Family exclusion, length caps, length-win correlation: as v2.

## The headline: divergence

Site leads with the **Verified board**; the Judged board sits beside it, and
the **divergence table** (rank on judged minus rank on verified) is a
first-class result: high-judged/low-verified = rhetoric machine, detected
autonomously.

## Migration & cost

- v2 debate ladder and all history remain (League 3).
- League 1 MVP: prover-refuter code games in a local sandbox (Docker or
  subprocess-ulimit), same OpenRouter roster, ~$0.02-0.05/leg (short
  artifacts, no juries) — an order of magnitude cheaper per rating bit than
  judged debate.
- Build order: (1) prover-refuter engine + sandbox + sim tests; (2) verified
  ladder + site board + divergence table; (3) resolvable-motion calibration
  into the debate league; (4) paraphrase normalizer; (5) forecasting league;
  (6) Lean games.

## Review notes

### Kimi K3 (2026-07-21)
**Foundational catch: prover-authored specs are the design's error** — they
reintroduce "the model sets its own exam" inside the verified league and enable
~60% of the attack surface (vacuous specs, trivially-true claims, obfuscation
farming, difficulty-setting symmetry exploit). **Minimal closing rule set:**
1. **Specs/problems are corpus-owned and pre-registered; models author only
   solutions and counterexamples.** New specs may be model-proposed but enter
   the corpus only through a mechanical admission gate: **mutation testing**
   (spec must catch k≥2 mutants of a reference solution — non-vacuity proven
   by execution, no human curation).
2. **Hermetic container from day one** (no network, read-only FS, tmpfs,
   seccomp, PID caps; spec/harness invisible at runtime; refutations must
   reproduce 3/3 in fresh containers). Subprocess+ulimit fails on FS reads
   alone. Non-negotiable: we reward models for outsmarting the harness.
3. **Scheduler assigns artifact classes and pairings** (not prover choice);
   complexity/size lint gates; refuter scored on attempts-used; per-class
   pre-registered execution cost envelopes (kills refuter-DoS); family
   exclusion + statistical throw-detection (collusion audit).
4. **Two ladders (prover / refuter), not one with a role term** — the roles
   diverge and the divergence is itself signal; combined board = labeled mean.
Other answers: judge weights from resolvable-motion accuracy ONLY (drop
League-1 rating from the weight function — coding ability ≠ judging ability;
keep as published covariate); Beta-shrinkage weights, floor n≥30, cap 3x,
provisional label until n≥50; resolvable motions must be format-indistinguishable
(30-90 day delayed resolution, never marked at judge time; publish
detection-attempt audits). **Don't paraphrase-normalize by default** — a third
model's biases enter the pipeline and precision blurs; instead audit
stylometric self-preference statistically (regress votes on similarity,
publish residual) and A/B normalization ONLY if residual exceeds threshold,
measured against resolvable-motion accuracy (the instrument League 3 already
builds). Forecasting: fully templated question generation from feed data via
seeded RNG (model-generated questions are gamed by construction); models may
nominate questions passing mechanical admissibility, and nominators are rated
on question quality (Brier spread), not their own answers. Weakness #2:
execution-verified ≠ intelligence-relevant (Goodhart: "who was RLHF'd on
coding contests") — diversify artifact classes fast (Lean to phase 1.5,
constraint-satisfaction classes), publish per-class ratings.

### Codex (2026-07-21)
Converges with Kimi on all majors: platform-owned specs (prover's control of
S/Q breaks the game), two ladders, container isolation day one, templated
forecasting questions only, normalizer only if A/B-proven harmless on
resolvable-motion accuracy. Codex additions: (a) **N=3 refutation attempts is
too few — it's bounded adversarial testing, not verification**; give the
refuter a batch of inputs (or an executable search strategy) under a compute
budget; (b) **honest labeling**: report "survived adversarial refutation at
budget B", don't call it "verified" — overclaiming is weakness #1; (c)
**harness-crash denial-of-result**: run P and checker in separate constrained
processes; if P caused the failure it's a prover LOSS, void only independently
reproducible harness defects, cap replays; (d) refutation counts only for
inputs within the class's declared size/resource envelope; (e) admission phase:
platform fuzzers + reference agents band-check difficulty before rating; (f)
judge weights: ≥100 resolvable votes before any effect, shrinkage to ~300;
(g) divergence table needs significance tests + neutral label
("persuasion-vs-execution gap"), not "rhetoric machine detected".

## LOCKED SPEC v3 (three-way synthesis, 2026-07-21)

**League 1 — Adversarial refutation games (the backbone).**
- **Artifact classes are platform-owned and pre-registered**: each class
  defines the spec S (executable checker), precondition Q, input grammar +
  serialization, size bounds, resource envelope, and hidden smoke cases.
  Models author ONLY solutions (prover: program P) and attacks (refuter:
  a batch of up to K concrete inputs). No self-dealt exams.
- **Corpus growth stays autonomous**: models may propose new classes, admitted
  solely by mechanical gates — mutation testing (spec catches k≥2 mutants of a
  reference solution), platform fuzz calibration into a target difficulty band,
  validator round-trip. No human curation.
- **A leg**: scheduler assigns class + pairing (never prover choice). Prover
  submits P (lint/size-gated); platform validates with smoke cases (fail =
  forfeit). Refuter submits up to K=10 inputs in one shot. Execution decides:
  any in-envelope input where P violates S (or crashes) = refuter wins; else
  prover wins. Refutations must reproduce 3/3 in fresh sandboxes. Ties
  impossible. Return leg swaps roles on a fresh artifact of the same class.
- **Sandbox: hermetic container, day one, non-negotiable.** No network,
  read-only FS, tmpfs quota, cgroup CPU/mem/pid caps, non-root, stdout caps,
  P and checker in separate processes, spec/harness invisible to P at runtime.
  If P caused the failure → prover loss; only reproducible harness defects
  void a leg, with capped replays.
- **Ratings: two BT ladders (prover, refuter)** via bt.ts; composite Verified
  score = labeled mean. Per-class ratings published (anti-Goodhart: a single
  drilled skill can't masquerade as general capability). Family exclusion +
  pair-contribution caps + throw-detection audit (collusion).
- **Honest labeling**: the board reports "survived adversarial refutation at
  budget B", with refuter-budget-conditioned confidence. Never "verified".

**League 2 — Forecasting.** Templated question generation ONLY (seeded RNG
over pre-approved public feeds; frozen resolution criteria; timestamped before
answers). Participant models never author scored questions; they may nominate
candidates passing mechanical admissibility, and nominators are scored on
question quality (Brier spread across the field), not their own answers.
Brier-scored at resolution; slow background league.

**League 3 — Judged debate (persuasion axis; the show).** Continues as v2.
Changes: (a) ~25% resolvable motions, format-indistinguishable, delayed
resolution 30-90d, never marked at judge time; (b) **judge vote weights earned
from resolvable-motion accuracy ONLY** (League-1 rating published as covariate,
not in the weight): Beta-shrinkage, no effect before ~50 resolvable votes, full
strength ~300, cap 3x, "provisional" label until then; (c) NO paraphrase
normalizer by default — audit stylometric self-preference statistically and
A/B normalization only if the residual crosses a threshold, judged by
resolvable-motion accuracy; (d) publish detection-attempt audits.

**Headline.** Verified board first; divergence table labeled
"persuasion-vs-execution gap" with significance tests and CIs — not an
automatic "rhetoric machine" verdict.

**Build order:** (1) League-1 MVP: artifact-class schema + starter corpus +
sandbox runner + match engine + two-ladder BT + sim tests; (2) verified board
+ divergence panel on the site; (3) resolvable-motion calibration in League 3;
(4) admission-gate machinery for model-proposed classes; (5) forecasting;
(6) Lean classes.

## Open questions for reviewers

1. Prover-refuter incentive soundness: does "prover must supply 3 passing
   examples" + discrimination filter actually close the degenerate-task
   loopholes (trivially unbreakable P, spec-gaming, obfuscated-but-broken P
   designed to eat refuter attempts)? What's the cleanest additional rule?
2. Scoring asymmetry: prover and refuter are different skills. One BT ladder
   with role as a side-effect term (like betaSide), or two separate ladders?
3. Sandbox: is subprocess + ulimit enough for model-authored code, or is
   container isolation non-negotiable from day one?
4. Resolvable-motion judge calibration: minimum sample size before weights
   kick in; how to stop judges detecting resolvable motions and behaving
   differently on them?
5. Paraphrase normalizer: does it destroy argument quality signal along with
   style? How to measure that trade-off autonomously?
6. Forecasting league: how to make question generation non-gameable when the
   models themselves generate the questions?
