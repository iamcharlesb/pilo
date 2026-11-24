import { validateThinkingLimits } from "./arena";
import type { ThinkingLimits } from "./types";

/** No operational defaults: deployment limits must be explicitly configured. */
export function thinkingLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): ThinkingLimits {
  const read = (name: string) => {
    const value = env[`THINKING_${name}`]?.trim();
    if (!value || !/^\d+$/.test(value)) throw new Error(`Set THINKING_${name} to an integer.`);
    return Number(value);
  };
  return validateThinkingLimits({
    maxCycles: read("MAX_CYCLES"), maxAgentCalls: read("MAX_AGENT_CALLS"),
    maxDurationMs: read("MAX_DURATION_MS"), maxRevisions: read("MAX_REVISIONS"),
    successesPerLevel: read("SUCCESSES_PER_LEVEL"), maxLevel: read("MAX_LEVEL"),
    pointsPerSuccess: read("POINTS_PER_SUCCESS"), maxRetainedRuns: read("MAX_RETAINED_RUNS")
  });
}
