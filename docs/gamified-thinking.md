# Gamifying Agent Thinking

`ThinkingArena` implements explicit, bounded practice with four roles: question,
analysis, solver, and supervisor. It improves operating instructions and reusable
strategies without updating model weights. Higher scores are evidence of passing
configured checks, not proof of general intelligence or novel capabilities.

## Execution

1. The question agent proposes a challenge for the current level.
2. Application code checks scope and difficulty and supplies a canonical task key.
3. The supervisor reviews the question; rejected questions return for revision.
4. The analysis agent proposes a strategy. The supervisor reviews it before solving.
5. The solver receives the approved analysis and produces an answer and evidence.
6. Application code independently checks acceptance and unfamiliar transfer cases.
7. The supervisor reviews the answer and verification. Failures return feedback to
   analysis; retries are bounded.
8. Only passing verification **and** supervisor approval earn points. Distinct
   successes at a level unlock the next level and its harder challenge requirements.

A successful task earns `pointsPerSuccess * level` points. Every check must pass,
with at least one acceptance check and one transfer check. Repeated canonical task
keys never earn additional credit. The application qualifier must enforce actual
complexity; the model cannot simply label an easy question as a higher level.

The supervisor may propose lessons in any review phase. They stay `pending` and
are excluded from operating context until an operator/application explicitly calls
`arena.reviewLesson(id, "approved", reviewer)`. Approval records a reviewer; it is
not an authentication mechanism. Keep this API outside model tool access. Review
lessons against evidence and unfamiliar cases before approval. Rejected lessons
are also retained. Only approved lessons for this arena's goal enter role inputs;
raw review transcripts are not used as persistent instructions.

## Configuration and runnable demonstration

Build with `npm run build`. Copy these example settings into the gitignored root
`.env`, adjusting budgets for your deployment:

```dotenv
THINKING_MAX_CYCLES=6
THINKING_MAX_AGENT_CALLS=60
THINKING_MAX_DURATION_MS=120000
THINKING_MAX_REVISIONS=1
THINKING_SUCCESSES_PER_LEVEL=2
THINKING_MAX_LEVEL=3
THINKING_POINTS_PER_SUCCESS=10
THINKING_MAX_RETAINED_RUNS=50
# Optional: retain progress between explicitly started sessions.
THINKING_STATE_FILE=.pilo/thinking/practice.json
```

On Node 22.12+, run:

```bash
node --env-file=.env examples/23-gamified-thinking.cjs
```

The default demonstration uses deterministic role fixtures and real, independent
checks for numeric data-cleaning pipelines: sorting, deduplication, and filtering.
It exercises the progression mechanism without model calls or network activity;
its score does not measure an LLM's ability. Unfamiliar arrays test a reusable
pipeline rather than trusting a solver's assertion. Solutions are declarative
JSON; no generated code is evaluated.

To explicitly use real agents, configure `THINKING_PROVIDER` and `THINKING_MODEL`
plus that provider's usual credential environment variables, then add `--live`.
Per-role overrides are `THINKING_QUESTION_MODEL`, `THINKING_ANALYSIS_MODEL`,
`THINKING_SOLVER_MODEL`, and `THINKING_SUPERVISOR_MODEL`. Models and credentials
are never hardcoded. The live example gives each role a separate agent, no tools,
and no shared conversation memory. Live mode can incur provider charges. No live
model call is required to build or test the feature.

## Integrating another domain

Import `ThinkingArena`, `createThinkingAgents`, `thinkingLimitsFromEnv`, and a
store from `pilo-runtime`. Pass four independently configured `SimpleAgent`
instances to `createThinkingAgents({ question, analysis, solver, supervisor })`,
or implement the typed `ThinkingAgents` functions directly. The adapter provides
compact role instructions and validates JSON responses. A paused, errored, or
malformed reply cannot count as a successful answer.

Construct the arena with:

```typescript
const arena = new ThinkingArena({
  goal,
  agents,
  limits: thinkingLimitsFromEnv(),
  store: new FileThinkingStore(stateFile),
  qualifyChallenge, // trusted scope/difficulty check and canonical task key
  verifySolution   // trusted acceptance checks and hidden transfer cases
});
const session = await arena.run({ signal: controller.signal });
```

The example provides complete implementations of both domain callbacks. Keep
qualifiers, verifier code, scoring policy, state files, and holdout datasets
outside agents' write and tool scopes. A verifier returning `passed: true`
unconditionally provides no meaningful protection. Do not use the model's own
proposed tests or task IDs as the sole source of truth. Maintain a separate,
unfamiliar evaluation suite to measure generalization and regressions; repeated
practice against the same transfer cases can overfit them.

The question agent receives a lifetime attempt number and retained run summaries; analysis and solver receive
supervisor feedback. The supervisor gets only the current phase's artifacts,
including verification results at final review. Each domain owns relevance and
selection of approved lessons; split unrelated goals into separate arenas.

## Limits, persistence, and execution boundaries

- Sessions start only with `run()`. Construction, notifications, lesson review,
  and saved snapshots never schedule model calls or paid recurring work.
- Cycle, role-invocation, revision, time, progression, and reward settings are
  explicitly configured. There are no unbounded retry loops.
- A role invocation may internally make multiple model/tool calls. The arena's
  `maxAgentCalls` counts role invocations, not tokens, tools, or dollars. Configure
  executor iteration limits, provider token limits, and existing governance
  budgets on tool-enabled agents. Arena limits do not replace those controls.
- Cancellation forwards `AbortSignal` and stops scheduling subsequent stages.
  An adapter or tool that ignores cancellation may continue an in-flight action;
  a hard execution deadline requires provider cancellation/process isolation.
- `FileThinkingStore` atomically saves private local snapshots with run events,
  feedback, scores, level, and lesson review status. Existing secret redaction is
  applied before persistence and return; it is best-effort redaction, not a
  permission boundary. Keep practice data non-sensitive.
- Newly created state directories use owner-only permissions (`0700`); temporary
  files are exclusively created (`wx`) with `0600` permissions before atomic rename.
  Existing directory permissions are not modified.
- `THINKING_MAX_RETAINED_RUNS` bounds the recent run records and event payloads
  kept in memory, snapshots, and question-agent history. Old runs expire on save;
  lifetime attempt counts, points, progression, duplicate keys, and lessons remain.
  Earlier v1 snapshots acquire their lifetime count from the existing run records.
  Lessons retain their source run ID even after its detailed trace expires; review
  or externally archive that evidence before expiry if needed. This bounds run-log
  growth, not lesson storage or the byte size of an individual model response.
- One arena instance rejects overlapping runs/reviews. File storage is for one
  local operator, with no cross-process lock or distributed execution guarantee.
  Do not share a file between writers. A different goal requires a different file.
- After interruption, the next explicit session marks unfinished runs interrupted
  and starts fresh work. It never replays outward actions. This is not exactly-once
  execution or a checkpoint-resume mechanism for a partially completed task.
- The maximum configured level becomes `mastered` after the required successes;
  it does not grant unrestricted capabilities or change tool permissions.

This feature is exported by the framework. It does not register desktop specialist
bots, change the browser runtime, or enable a background training service.
