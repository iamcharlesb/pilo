import type { ThinkingAnalysis, ThinkingChallenge, ThinkingReview, ThinkingSolution, ThinkingVerification } from "./types";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Expected a non-empty string.");
  return value.trim();
}

function strings(value: unknown, nonEmpty = false): string[] {
  if (!Array.isArray(value) || (nonEmpty && !value.length)) throw new Error("Expected a string array.");
  return value.map(text);
}

export function challengeOutput(value: unknown): ThinkingChallenge {
  const v = object(value);
  return { title: text(v.title), problem: text(v.problem), acceptanceCriteria: strings(v.acceptanceCriteria, true) };
}

export function analysisOutput(value: unknown): ThinkingAnalysis {
  const v = object(value);
  return { summary: text(v.summary), steps: strings(v.steps, true), risks: strings(v.risks) };
}

export function solutionOutput(value: unknown): ThinkingSolution {
  const v = object(value);
  return { answer: text(v.answer), evidence: strings(v.evidence) };
}

export function reviewOutput(value: unknown): ThinkingReview {
  const v = object(value);
  if (typeof v.approved !== "boolean") throw new Error("Supervisor approval must be a boolean.");
  return { approved: v.approved, feedback: text(v.feedback),
    ...(v.proposedLesson === undefined ? {} : { proposedLesson: text(v.proposedLesson) }) };
}

export function verificationOutput(value: unknown): ThinkingVerification {
  const v = object(value);
  if (!Array.isArray(v.checks)) throw new Error("Verification requires checks.");
  const checks: ThinkingVerification["checks"] = v.checks.map(item => {
    const check = object(item);
    if (typeof check.passed !== "boolean" || (check.kind !== "acceptance" && check.kind !== "transfer")) {
      throw new Error("Invalid verification check.");
    }
    return { name: text(check.name), kind: check.kind, passed: check.passed };
  });
  return { checks, feedback: text(v.feedback) };
}

export function verificationPassed(value: ThinkingVerification): boolean {
  return value.checks.some(c => c.kind === "acceptance") &&
    value.checks.some(c => c.kind === "transfer") && value.checks.every(c => c.passed);
}
