# LLM Premier League v2: Continuous Ladder (initial design, 2026-07-21)

## Problem

v1 is a double round-robin season: perfect fairness, O(n^2) cost. At arena scale
(30-40 models) that is ~1,300 debates per season ($100+, days of wall clock).
The benchmark must cover the full arena.ai/leaderboard/agent field and stay
comparable to it (human-judged there, peer-LLM-judged here), while spending
tokens where they buy ranking information.

## Design

### Roster
All distinct models from the arena agent leaderboard available on OpenRouter
(one entry per distinct model; effort/thinking variants collapsed to the
strongest listed variant). Roster is config; adding a model is one line.

### Scheduling: information-optimal matchweeks
Play proceeds in **matchweeks** of K paired ties (K sized by a per-week budget).
Each tie = 2 legs, same motion, sides swapped (kept from v1: motion-side
difficulty cancels; legs are correlated and treated as one cluster).

Pair selection each matchweek maximizes expected ranking information:
1. **Uncertainty overlap**: prefer pairs whose rating CIs overlap (their order
   is unsettled; a result moves the table).
2. **Novelty**: prefer pairs with the fewest prior meetings.
3. **Exposure balance**: hard cap on per-model matches per week; soft floor so
   every model plays regularly; new entrants get boosted sampling until their
   CI shrinks (provisional-rating behavior).
4. Deterministic given (ratings snapshot, seed): resumable and auditable.

### Rating: Bradley-Terry, not chronological Elo
Sparse, uneven schedules make Elo path-dependent (who you met early matters).
v2 fits **Bradley-Terry with a global side-advantage term** over the full
result history (draws = half win), refit after every matchweek:
- Report on the familiar Elo-like scale (1500-centered, 400/ln(10) scaling).
- CIs by cluster bootstrap over ties (pairs of legs).
- Order-independent: seasons, ladders, and v1 history all merge cleanly.
Online Elo remains as a display-only "form" indicator.

### Judging (unchanged from v1)
Jury of 5 rotating peers per debate (seeded, resume-stable), drawn from the
full roster minus debaters and the motion's proposer. Anonymized transcripts,
low-temperature verdicts, rubric 0-40 + vote, majority decides, per-judge bias
stats public. With 30+ peers the rotation pool is deep; every model accumulates
a judging record.

### Motions
Each matchweek, a rotating subset of 5 models proposes motions into the shared
bank (curated by a seed-rotated curator). Proposer never debates nor judges its
own motion. Bank persists; each tie draws a fresh motion.

### Narrative layer
- The ladder is continuous; the public leaderboard is always current.
- A "season" becomes a calendar window (e.g., 4 matchweeks): most points in
  the window = season champion, keeping titles and the trophy cabinet.
- Site shows "our rank vs arena rank" side by side + Spearman correlation:
  the headline claim is where peer-LLM judgment disagrees with human judgment.

### Budget
Config: usdPerMatchweek target; scheduler sizes K accordingly (~$3-5/week at
current prices → ~$15-20/month for a 30+ model board). Expensive models play
the same number of matches as everyone (fairness first, cost follows).

### Migration
v1 season-league-001 (12 models, 132 debates) becomes the seed history for the
first BT fit. Nothing is discarded.

## Review notes

### Kimi K3 (2026-07-21)
Answers to open questions:
1. Replace greedy CI-overlap with **expected Fisher information** (D/A-optimal design): each i-j match adds weight p_ij(1-p_ij) to the BT information (Laplacian); pick pairs maximizing log-det/trace gain under exposure caps. ~20 lines, deterministic, subsumes novelty (repeated pairs saturate). Greedy CI-overlap wastes matches whose outcome is near-certain *given the rest of the network*.
2. **Global side term only** — per-model side terms are ~35 weakly-identified params, pure variance at this sample size.
3. **Davidson tie model** if draw rate >15% (likely with 5-judge majorities); report half-win as sensitivity check; revert to half-win if draws <10%.
4. Both failure modes real: (a) ping-ponging → per-pair rematch cooldown + superlinear novelty penalty; (b) **mid-table starvation is the #1 risk** — reserve ~25% of each week's matches for **connectivity** (maximize algebraic connectivity / Fiedler value of the played-graph), independent of uncertainty. Cheap, essential for BT CI calibration on sparse graphs.
5. Cold start: seed new entrants at 1500 (not penalized), ~2x provisional sampling, **stratified opponents** (one strong/mid/weak per week, NOT CI-overlap — else they only meet neighbors and get globally-anchored-wrong ratings); exposure hard cap applies to entrants too.

Top weaknesses:
1. **Peer-judging validity is the load-bearing assumption.** If Spearman vs arena is low, can't tell "peers judge differently" from "peer judging is noisy/biased." Fix: reserve budget for a human-judged validation subsample, report judge-human agreement as first-class, and *model* judge identity (judge random effects), not just publish bias stats.
2. **Nonstationarity breaks a single pooled BT fit** (models silently updated on OpenRouter; worse than Elo which recency-weights). Fix: time-decayed likelihood (half-life ~1 season) or per-window fits. Current design is inconsistent: window-restricted titles but all-time pooled ratings.
3. **5 judges too few for the inferential claim.** Fix (nearly free, strictly more informative): feed **fractional outcomes = vote share** (4-1 → 0.8) into the BT likelihood instead of hard majority; optionally adaptive judge count (add judges on 3-2 pivotal ties).

### Fable 5 (2026-07-21)
Architecture: **ladder + BT is right.** Two changes + one make-or-break workstream.
- **Scheduling:** keep the uncertainty objective, but replace *greedy* selection with one **max-weight non-bipartite matching** (blossom) over the whole matchweek — greedy strands leftover models into junk pairings under exposure caps. Reserve **10-15% for seeded-random long-range pairs**: fixes chain-graph identifiability AND doubles as a **transitivity audit** (publish BT upset/residual rate on long-range pairs — transitivity is BT's load-bearing, suspect assumption for LLMs). First post-migration weeks MUST connect the 25 new models to the v1 core or BT is only identified up to disconnected components.
- **Draws — dissolve the question: fit BT at the LEG level** (5-judge majority can't tie), cluster-bootstrap over ties for CIs. No tie model needed. (Composes with Kimi's fractional outcomes: leg outcome = vote share, e.g. 4-1 → 0.8.)
- **Biggest credibility risk = correlated judge bias, esp. same-family self-preference.** Majority-of-5 kills idiosyncratic noise, not *shared* bias. Headline claim ("peer vs human disagreement") collapses if the delta is judge bias. Mandatory bundle: (1) **family-exclusion juries** (no judge from either debater's lab family), (2) hard length caps + publish length-win correlation, (3) **leave-one-family-out robustness** (refit BT dropping each lab's judges, publish max top-10 Spearman shift — this is the credibility artifact), (4) small human anchor (20-30 debates → "peers agree with humans X%").
- **Honesty flag:** arena *agent* board is a different *task* (agentic tool use), not just a different judge; Spearman-vs-arena confounds task with judge. Disclose, or compare against a more debate-like arena board.
Open-question answers: Q1 CI-overlap edge score is fine, the win is matching+random reserve not entropy machinery; Q2 global only; Q3 leg-level fit (above); Q4 rematch cooldown (≤1/3 weeks) + hard exposure floor (every model ≥1 tie/2 weeks) + "last played" on board; Q5 placement mini-schedule (top/median/bottom-quartile opponents), init 1500 wide prior, new entrants ≤20-25% of weekly K, **do NOT seed prior from arena rank** (contaminates independence). Flags: track per-proposer win-rate skew + topic diversity; size K from measured week-1 cost/tie (~22 calls/tie, estimate likely 2-3x optimistic).

### Codex (2026-07-21)
Converges with both. Key additions on numerical rigor: **penalized leg-level BT**, `logit P(i beats j) = theta_i - theta_j + beta_side * side_i`, **`sum(theta)=0`** for identifiability, **weak ridge** on strengths to avoid separation/infinite estimates under sparse schedules; **require the comparison graph connected for official ranks**, mark disconnected/barely-connected models **provisional**; cluster-bootstrap by two-leg tie. Scheduler: define ONE scalar pair score (CI overlap, rank proximity, repeat penalty, new-model priority, rolling exposure debt) and solve max-weight matching under hard rolling constraints — "priority list" is underspecified and non-reproducible. Reserve a share of each week for **curated reference motions** (detect rubric drift / motion-bank skew); store individual votes; publish per-judge calibration (side bias, panel agreement, divergence on repeated/reference motions).

## LOCKED SPEC v2 (three-way synthesis, 2026-07-21)

Unanimous across Codex + Kimi + Fable, adopted:

**Rating — penalized leg-level Bradley-Terry.**
- Model: `logit P(i beats j) = theta_i - theta_j + beta_side`, fit at the **leg** level (odd jury → no ties; the draw question dissolves — no Davidson, no half-win).
- Outcome is the **jury vote share** of the leg (4-1 → 0.8), not a hard win — propagates judge uncertainty into the likelihood, nearly free (Kimi).
- `sum(theta)=0` identifiability + weak **ridge** regularization (Codex). Report on Elo scale (1500-centered). Online Elo kept display-only as "form".
- CIs by **cluster bootstrap over ties**. **Connectivity required for an official rank**; else marked *provisional* (Codex).

**Scheduling — one scalar score, solved as max-weight matching.**
- Per-edge score from CI-overlap/info-gain × rank-proximity × novelty penalty × exposure debt; solve **max-weight non-bipartite matching** over the whole matchweek (not greedy) under hard constraints: ≤1 tie/model/week, ≥1 tie/model per 2 weeks, rematch cooldown ~3 weeks.
- Reserve **~20% for connectivity / long-range random pairs** → fixes sparse-graph identifiability AND is the **transitivity audit** (publish BT upset rate on long-range pairs).
- **Cold start**: init at ladder median, wide prior; new entrants ≤20-25% of weekly K, ≤3 ties each; opponents = **fixed ladder quantiles** (top/median/bottom), not CI-overlap; provisional until connected + CI-width threshold. **Do NOT seed prior from arena rank** (contaminates independence — Fable).

**Judging — bias control is the make-or-break workstream (all three, #1 risk).**
- 5 rotating peers, **family-exclusion** (no judge from either debater's lab family; family map in config).
- Hard **length caps** per speech + publish **length-win correlation**.
- **Leave-one-family-out robustness**: refit BT dropping each lab's judges, publish max top-10 Spearman shift — *the* credibility artifact (Fable).
- Reserve a share of motions as **curated reference motions** to detect rubric/bank drift (Codex); keep model-proposed motions but not as the whole distribution; publish per-proposer win-rate skew + topic diversity.
- **Human anchor**: 20-30 human-judged debates on a stratified sample → report "peers agree with humans X%". Designed-for now, populated later.

**Narrative honesty.** Arena *agent* board is a different **task** (agentic tool use), not just a different judge — Spearman-vs-arena confounds task with judge. Disclose prominently; also compare against a more debate-like arena board where possible.

**Migration.** v1 `season-league-001` (12 models) seeds the first BT fit; first matchweeks deliberately connect the ~25 new models to the v1 core. Size matchweek K from **measured week-1 cost/tie** (~22 calls/tie; estimates likely 2-3x optimistic — Fable), not a guess.

**Build order:**
- [x] (1) **BT engine** (`src/bt.ts`) on existing v1 data — leg-level, vote-share outcomes, global side term, sum(theta)=0 + ridge, connected-component provisional flag, cluster-bootstrap CI. Wired into `report.ts` as the PRIMARY rating (online Elo demoted to "form"), live on the board + public site. Unit-tested (strength recovery, provisional, determinism).
- [x] (1b) **Family-exclusion juries** (`selectJury` in `src/judge.ts`) — no judge from either debater's lab family; relaxes on tiny rosters; deterministic. Unit-tested.
- [ ] (2) Scheduler + ladder loop (max-weight matching + connectivity reserve + cold-start quantile placement + exposure constraints), proven under `LLM_SIM`.
- [ ] (3) Leave-one-family-out robustness score + length-win correlation + reference motions + site "vs arena" panel (with task-confound disclosure).
- [ ] (4) Start the real full-roster ladder deliberately after measuring week-1 cost/tie.

## Open questions for reviewers
1. Is greedy CI-overlap pairing good enough, or is there a materially better
   acquisition rule (e.g., expected reduction in rank entropy) that stays simple?
2. BT with a single global side term vs per-model side terms: is the latter
   worth the parameters at ~50-100 ties/week?
3. Draw handling in BT (half-win vs Davidson tie parameter)?
4. Any failure modes of exposure-balancing + uncertainty pairing interacting
   (e.g., ping-ponging on two uncertain models, starving mid-table)?
5. New-entrant cold start: provisional boost size, and guard against a new
   model burning the whole week's budget.
