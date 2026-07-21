export interface Config {
  division: string; // rankings never mix divisions ("flagship", "dev", ...)
  competitors: string[]; // OpenRouter model slugs, length must be multiple of 4
  judging: "peers" | "panel"; // peers = every competitor not in the debate judges it
  maxJury?: number; // peers mode: cap jury size via seeded rotation (cost control)
  minJury?: number; // floor below which family-exclusion is relaxed (default 3)
  familyExclusion?: boolean; // peers mode: no judge from either debater's lab (default true)
  familyMap?: Record<string, string>; // model -> lab family override (defaults to org prefix)
  judgePool: string[]; // panel mode only: curated judge slugs
  judgesPerMatch: number; // panel mode only
  generateTopics: boolean; // competitors propose motions at season start
  topicsPerCompetitor: number;
  debaterMaxTokens: number;
  judgeMaxTokens: number;
  seed: number;
}

export type Side = "PRO" | "CON";

export interface Turn {
  side: Side;
  phase: "opening" | "rebuttal" | "closing";
  text: string;
}

export interface JudgeVerdict {
  judge: string;
  winner: "A" | "B"; // A = PRO, B = CON (anonymized order shown to judge)
  scoreA: number;
  scoreB: number;
  reasoning: string;
  failed?: boolean;
}

export interface DebateResult {
  topic: string;
  topicProposer?: string;
  pro: string; // model slug arguing PRO
  con: string;
  turns: Turn[];
  verdicts: JudgeVerdict[];
  winner: string | null; // model slug, null = draw
  votesPro: number;
  votesCon: number;
  scorePro: number;
  scoreCon: number;
  costUsd: number;
}

export interface Match {
  id: string;
  stage: string; // "group-A" | "semi" | "third" | "final" | ...
  home: string;
  away: string;
  legs: DebateResult[];
  winner: string | null; // null = draw (only allowed in group stage)
}

export interface Standing {
  model: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  scoreDiff: number;
}

export interface BankTopic {
  topic: string;
  proposer: string; // model slug; never debates its own motion
}

export interface Season {
  id: string;
  mode?: "cup" | "league"; // older season files predate this field (cup)
  startedAt: string;
  config: Config;
  groups: Record<string, string[]>;
  topicBank?: BankTopic[];
  matches: Match[];
  standings: Record<string, Standing[]>;
  placements: Record<string, number>; // model -> final placement (1 = champion)
  champion: string | null;
  totalCostUsd: number;
  done: boolean;
}
