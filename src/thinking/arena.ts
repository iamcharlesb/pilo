import { randomUUID } from "crypto";
import { redactSecretValues, redactSecrets } from "../security/redaction";
import type { ThinkingArenaConfig, ThinkingContext, ThinkingLimits, ThinkingReviewInput, ThinkingRun, ThinkingSession, ThinkingState, ThinkingTask } from "./types";
import { analysisOutput, challengeOutput, reviewOutput, solutionOutput, verificationOutput, verificationPassed } from "./validation";

class SessionStopped extends Error {
  constructor(readonly reason: ThinkingSession["stopReason"]) { super(reason); }
}

export function validateThinkingLimits(limits: ThinkingLimits): ThinkingLimits {
  const names: Array<keyof ThinkingLimits> = ["maxCycles", "maxAgentCalls", "maxDurationMs", "maxRevisions", "successesPerLevel", "maxLevel", "pointsPerSuccess", "maxRetainedRuns"];
  for (const name of names) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < (name === "maxRevisions" ? 0 : 1)) {
      throw new Error(`Invalid thinking limit: ${name}.`);
    }
  }
  if (limits.maxDurationMs > 2_147_483_647 || !Number.isSafeInteger(limits.maxLevel * limits.maxLevel * limits.pointsPerSuccess * limits.successesPerLevel)) {
    throw new Error("Thinking limits exceed supported numeric bounds.");
  }
  return { ...limits };
}

/** Explicit, bounded practice sessions. Models propose; application code owns rewards and progression. */
export class ThinkingArena {
  private busy = false;
  private readonly limits: ThinkingLimits;
  private readonly config: ThinkingArenaConfig;

  constructor(config: ThinkingArenaConfig) {
    if (!config.goal.trim()) throw new Error("A thinking goal is required.");
    this.limits = validateThinkingLimits(config.limits);
    this.config = { ...config, agents: { ...config.agents }, goal: config.goal.trim() };
  }

  private async load(): Promise<ThinkingState> {
    const state = await this.config.store.load();
    if (!state) return { version: 1, goal: this.config.goal, level: 1, points: 0, mastered: false, totalRuns: 0, successes: [], lessons: [], runs: [] };
    if (state.version !== 1 || state.goal !== this.config.goal || !Number.isSafeInteger(state.level) ||
      state.level < 1 || state.level > this.limits.maxLevel || !Number.isSafeInteger(state.points) || state.points < 0 ||
      typeof state.mastered !== "boolean" || !Array.isArray(state.runs) || !Array.isArray(state.lessons) || !Array.isArray(state.successes)) {
      throw new Error("Invalid or incompatible thinking state.");
    }
    // Migrate pre-retention v1 snapshots without resetting progress or duplicate keys.
    state.totalRuns ??= state.runs.length;
    if (!Number.isSafeInteger(state.totalRuns) || state.totalRuns < state.runs.length) {
      throw new Error("Invalid thinking run count.");
    }
    return structuredClone(state);
  }

  private async save(state: ThinkingState): Promise<void> {
    state.runs.splice(0, Math.max(0, state.runs.length - this.limits.maxRetainedRuns));
    await this.config.store.save(redactSecretValues(structuredClone(state)));
  }

  /** Human/application review only. No agent receives this method as a tool. */
  async reviewLesson(id: string, decision: "approved" | "rejected", reviewer: string): Promise<void> {
    if (this.busy) throw new Error("Thinking arena is already busy.");
    if (!reviewer.trim() || !["approved", "rejected"].includes(decision)) throw new Error("A reviewer and valid decision are required.");
    this.busy = true;
    try {
      const state = await this.load();
      const lesson = state.lessons.find(item => item.id === id);
      if (!lesson || lesson.status !== "pending") throw new Error("Pending lesson not found.");
      lesson.status = decision;
      lesson.reviewer = reviewer.trim();
      await this.save(state);
    } finally { this.busy = false; }
  }

  async run(options: { signal?: AbortSignal } = {}): Promise<ThinkingSession> {
    if (this.busy) throw new Error("Thinking arena is already busy.");
    this.busy = true;
    const controller = new AbortController();
    let stopReason: ThinkingSession["stopReason"] = "cycle_limit";
    let calls = 0;
    const cancel = () => { stopReason = "aborted"; controller.abort(); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const timer = setTimeout(() => { stopReason = "deadline"; controller.abort(); }, this.limits.maxDurationMs);
    const finishExecution = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    };
    const context: ThinkingContext = { signal: controller.signal };
    const check = () => { if (controller.signal.aborted) throw new SessionStopped(stopReason); };
    // Race cooperative cancellation too: a non-cooperating adapter cannot schedule another stage.
    // Its underlying side effects still require a sandbox/provider that honors AbortSignal.
    const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
      check();
      let listener: () => void = () => {};
      const aborted = new Promise<never>((_, reject) => {
        listener = () => reject(new SessionStopped(stopReason));
        controller.signal.addEventListener("abort", listener, { once: true });
      });
      try {
        const result = await Promise.race([Promise.resolve().then(() => { check(); return work(); }), aborted]);
        check();
        return structuredClone(result);
      } finally { controller.signal.removeEventListener("abort", listener); }
    };

    try {
      const state = await this.load();
      // Interrupted outward actions are never replayed automatically.
      for (const run of state.runs) {
        if (run.status === "running") { run.status = "interrupted"; run.feedback = "Previous session interrupted; actions were not replayed."; }
      }
      await this.save(state);
      for (let cycle = 0; cycle < this.limits.maxCycles && !state.mastered; cycle++) {
        if (controller.signal.aborted) break;
        if (calls >= this.limits.maxAgentCalls) { stopReason = "call_limit"; break; }
        const run: ThinkingRun = { id: randomUUID(), level: state.level, status: "running", points: 0, events: [] };
        state.totalRuns++;
        state.runs.push(run);
        await this.save(state);
        const task: ThinkingTask = { goal: state.goal, level: state.level,
          lessons: state.lessons.filter(l => l.status === "approved").map(l => l.instruction) };
        const event = async (stage: string, data: unknown) => {
          run.events.push({ stage, at: new Date().toISOString(), data: redactSecretValues(data) });
          await this.save(state);
        };
        const call = async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
          check();
          if (calls >= this.limits.maxAgentCalls) throw new SessionStopped("call_limit");
          calls++;
          await event(`${stage}.started`, { call: calls });
          const result = await bounded(work);
          await event(stage, result);
          return result;
        };
        const review = async (input: ThinkingReviewInput) => {
          const result = reviewOutput(await call(`supervisor.${input.phase}`, () => this.config.agents.supervisor(structuredClone(input), context)));
          if (result.proposedLesson && !state.lessons.some(l => l.instruction === result.proposedLesson)) {
            state.lessons.push({ id: randomUUID(), runId: run.id, instruction: result.proposedLesson, status: "pending" });
            await this.save(state);
          }
          return result;
        };
        try {
          let feedback = "";
          let accepted: ReturnType<typeof challengeOutput> | undefined;
          for (let revision = 0; revision <= this.limits.maxRevisions; revision++) {
            const challenge = challengeOutput(await call("question", () => this.config.agents.question(
              structuredClone({ ...task, attempt: state.totalRuns, history: state.runs.slice(0, -1).map(({ id, level, status, points, feedback }) =>
                ({ id, level, status, points, feedback })), feedback }), context)));
            const qualification = await bounded(() => this.config.qualifyChallenge(structuredClone(challenge), structuredClone(task), context));
            if (typeof qualification.accepted !== "boolean" || typeof qualification.key !== "string" ||
              typeof qualification.feedback !== "string" || (qualification.accepted && !qualification.key.trim())) {
              throw new Error("Invalid challenge qualification.");
            }
            await event("qualification", qualification);
            qualification.key = qualification.key.trim();
            const duplicate = state.successes.some(s => s.key === qualification.key);
            if (!qualification.accepted || duplicate) {
              feedback = duplicate ? "Equivalent challenge already completed. Propose a genuinely different challenge." : qualification.feedback;
              continue;
            }
            const assessment = await review({ ...task, phase: "challenge", challenge });
            feedback = assessment.feedback;
            if (assessment.approved) { accepted = challenge; run.challengeKey = qualification.key; break; }
          }
          if (accepted) {
            const challenge = accepted;
            for (let revision = 0; revision <= this.limits.maxRevisions; revision++) {
              const analysis = analysisOutput(await call("analysis", () => this.config.agents.analysis(structuredClone({ ...task, challenge, feedback }), context)));
              const assessment = await review({ ...task, phase: "analysis", challenge, analysis });
              feedback = assessment.feedback;
              if (!assessment.approved) continue;
              const solution = solutionOutput(await call("solver", () => this.config.agents.solver(structuredClone({ ...task, challenge, analysis, feedback }), context)));
              const verification = verificationOutput(await bounded(() => this.config.verifySolution(structuredClone(challenge), structuredClone(solution), structuredClone(task), context)));
              await event("verification", verification);
              const finalReview = await review({ ...task, phase: "solution", challenge, analysis, solution, verification });
              feedback = `${verification.feedback}\n${finalReview.feedback}`;
              check();
              if (verificationPassed(verification) && finalReview.approved) {
                run.status = "succeeded";
                run.points = this.limits.pointsPerSuccess * run.level;
                state.points += run.points;
                state.successes.push({ level: run.level, key: run.challengeKey! });
                if (state.successes.filter(s => s.level === run.level).length >= this.limits.successesPerLevel) {
                  if (state.level === this.limits.maxLevel) state.mastered = true;
                  else state.level++;
                }
                break;
              }
            }
          }
          if (run.status === "running") run.status = "failed";
          run.feedback = feedback;
        } catch (error) {
          run.status = error instanceof SessionStopped ? "interrupted" : "failed";
          run.feedback = redactSecrets(error instanceof Error ? error.message : String(error));
          if (error instanceof SessionStopped) { stopReason = error.reason; finishExecution(); }
          await event("stopped", { status: run.status, feedback: run.feedback });
          if (error instanceof SessionStopped) break;
        }
        // Terminal cycles use the final flush below, after execution timers stop.
        if (cycle + 1 === this.limits.maxCycles || state.mastered || calls >= this.limits.maxAgentCalls) break;
        await this.save(state);
      }
      finishExecution();
      if (state.mastered) stopReason = "mastered";
      else if (!controller.signal.aborted && calls >= this.limits.maxAgentCalls) stopReason = "call_limit";
      await this.save(state);
      return { state: redactSecretValues(structuredClone(state)), agentCalls: calls, stopReason };
    } finally {
      finishExecution();
      controller.abort();
      this.busy = false;
    }
  }
}
