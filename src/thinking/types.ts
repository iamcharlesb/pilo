export interface ThinkingChallenge {
  title: string;
  problem: string;
  acceptanceCriteria: string[];
}

export interface ThinkingAnalysis {
  summary: string;
  steps: string[];
  risks: string[];
}

export interface ThinkingSolution {
  answer: string;
  evidence: string[];
}

export interface ThinkingReview {
  approved: boolean;
  feedback: string;
  proposedLesson?: string;
}

export interface ThinkingLesson {
  id: string;
  runId: string;
  instruction: string;
  status: "pending" | "approved" | "rejected";
  reviewer?: string;
}

export interface ThinkingContext {
  signal: AbortSignal;
}

export interface ThinkingTask {
  goal: string;
  level: number;
  lessons: string[];
}

export interface ThinkingReviewInput extends ThinkingTask {
  phase: "challenge" | "analysis" | "solution";
  challenge: ThinkingChallenge;
  analysis?: ThinkingAnalysis;
  solution?: ThinkingSolution;
  verification?: ThinkingVerification;
}

/** Each function may wrap a separately configured model or governed tool agent. */
export interface ThinkingAgents {
  question(input: ThinkingTask & { attempt: number; history: Array<Pick<ThinkingRun, "id" | "level" | "status" | "points" | "feedback">>; feedback: string }, context: ThinkingContext): Promise<ThinkingChallenge>;
  analysis(input: ThinkingTask & { challenge: ThinkingChallenge; feedback: string }, context: ThinkingContext): Promise<ThinkingAnalysis>;
  solver(input: ThinkingTask & { challenge: ThinkingChallenge; analysis: ThinkingAnalysis; feedback: string }, context: ThinkingContext): Promise<ThinkingSolution>;
  supervisor(input: ThinkingReviewInput, context: ThinkingContext): Promise<ThinkingReview>;
}

export interface ThinkingVerification {
  checks: Array<{ name: string; kind: "acceptance" | "transfer"; passed: boolean }>;
  feedback: string;
}

export interface ThinkingLimits {
  maxCycles: number;
  maxAgentCalls: number;
  maxDurationMs: number;
  maxRevisions: number;
  successesPerLevel: number;
  maxLevel: number;
  pointsPerSuccess: number;
  maxRetainedRuns: number;
}

export interface ThinkingEvent {
  stage: string;
  at: string;
  data: unknown;
}

export interface ThinkingRun {
  id: string;
  level: number;
  status: "running" | "succeeded" | "failed" | "interrupted";
  points: number;
  challengeKey?: string;
  feedback?: string;
  events: ThinkingEvent[];
}

export interface ThinkingState {
  version: 1;
  goal: string;
  level: number;
  points: number;
  mastered: boolean;
  /** Lifetime attempts, including runs whose detailed events have expired. */
  totalRuns: number;
  successes: Array<{ level: number; key: string }>;
  lessons: ThinkingLesson[];
  runs: ThinkingRun[];
}

export interface ThinkingStore {
  load(): Promise<ThinkingState | undefined>;
  save(state: ThinkingState): Promise<void>;
}

export interface ThinkingArenaConfig {
  goal: string;
  agents: ThinkingAgents;
  store: ThinkingStore;
  limits: ThinkingLimits;
  /** Trusted application code checks scope/difficulty and supplies a stable deduplication key.
   * Keys should identify equivalent tasks across rewordings and levels. Never trust a model's key.
   */
  qualifyChallenge(challenge: ThinkingChallenge, task: ThinkingTask, context: ThinkingContext): Promise<{
    accepted: boolean;
    key: string;
    feedback: string;
  }>;
  /** Trusted application code owns checks and hidden transfer cases; agents cannot edit them. */
  verifySolution(challenge: ThinkingChallenge, solution: ThinkingSolution, task: ThinkingTask, context: ThinkingContext): Promise<ThinkingVerification>;
}

export interface ThinkingSession {
  state: ThinkingState;
  agentCalls: number;
  stopReason: "cycle_limit" | "call_limit" | "deadline" | "aborted" | "mastered";
}
