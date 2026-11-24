// Offline by default. No model, browser, network, or recurring job is started.
// Configure THINKING_* limits (see docs/gamified-thinking.md), then:
//   npm run build
//   node --env-file=.env examples/23-gamified-thinking.cjs
// Add --live to explicitly use four separately configured model agents.
const { createHash } = require('node:crypto');
const {
  ThinkingArena, InMemoryThinkingStore, FileThinkingStore,
  createThinkingAgents, createAgent, thinkingLimitsFromEnv
} = require('../dist');

const operations = ['sort', 'unique', 'nonnegative'];
function required(level) { return operations.slice(0, level); }
function apply(input, pipeline) {
  let output = [...input];
  for (const operation of pipeline) {
    if (operation === 'sort') output.sort((a, b) => a - b);
    else if (operation === 'unique') output = [...new Set(output)];
    else if (operation === 'nonnegative') output = output.filter(n => n >= 0);
    else throw new Error('Unknown pipeline operation');
  }
  return output;
}
function specification(challenge) {
  const spec = JSON.parse(challenge.problem);
  if (!Array.isArray(spec.input) || spec.input.length === 0 || !spec.input.every(Number.isSafeInteger) ||
      !Array.isArray(spec.requirements) || !spec.requirements.every(op => operations.includes(op))) {
    throw new Error('Invalid integer pipeline challenge');
  }
  return spec;
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const goal = 'Practice reusable integer data-cleaning pipelines. Challenges must encode problem as a JSON string containing {input:number[],requirements:string[]}. '
  + 'At level 1 require ["sort"]; level 2 ["sort","unique"]; level 3 ["sort","unique","nonnegative"]. '
  + 'Sort is numeric ascending; unique removes duplicates; nonnegative keeps values >= 0. '
  + 'Propose varied inputs containing negatives, zero, and duplicates. Solver answer must be a JSON string containing {pipeline:string[],output:number[]}. '
  + 'The pipeline must also work on unseen arrays. Never output executable source code.';

function offlineAgents() {
  return {
    question: async ({ level, attempt }) => ({
      title: `Pipeline practice ${attempt}`,
      problem: JSON.stringify({ input: [attempt + 1, -3, 0, 2, 2, -1], requirements: required(level) }),
      acceptanceCriteria: ['Correct requested output', 'Reusable pipeline works on unfamiliar arrays']
    }),
    analysis: async ({ challenge }) => ({
      summary: 'Use only the permitted declarative operations in the requested order.',
      steps: specification(challenge).requirements,
      risks: ['Default JavaScript sorting is lexical; use numeric ascending order.']
    }),
    solver: async ({ challenge }) => {
      const { input, requirements } = specification(challenge);
      return { answer: JSON.stringify({ pipeline: requirements, output: apply(input, requirements) }), evidence: ['Declarative pipeline and computed output supplied for independent checks.'] };
    },
    supervisor: async ({ phase, verification }) => ({
      approved: phase !== 'solution' || verification.checks.every(check => check.passed),
      feedback: 'The challenge, strategy, and evidence meet this practice exercise’s requirements.',
      ...(phase === 'solution' ? { proposedLesson: 'When sorting numbers in JavaScript, use a numeric comparator and test negatives, duplicates, zero, and multi-digit values.' } : {})
    })
  };
}

async function main() {
  const limits = thinkingLimitsFromEnv();
  if (limits.maxLevel > operations.length) throw new Error('This example supports up to three difficulty levels.');
  let agents = offlineAgents();
  if (process.argv.includes('--live')) {
    const provider = process.env.THINKING_PROVIDER;
    if (!['openai', 'anthropic', 'gemini', 'ollama', 'perplexity'].includes(provider)) throw new Error('Set THINKING_PROVIDER for live mode.');
    const roleAgents = {};
    for (const role of ['question', 'analysis', 'solver', 'supervisor']) {
      const model = process.env[`THINKING_${role.toUpperCase()}_MODEL`] || process.env.THINKING_MODEL;
      if (!model) throw new Error(`Set THINKING_${role.toUpperCase()}_MODEL or THINKING_MODEL.`);
      // No tools or shared conversation memory. Provider credentials come from its normal environment.
      roleAgents[role] = createAgent({ provider, model });
    }
    agents = createThinkingAgents(roleAgents);
  }
  const store = process.env.THINKING_STATE_FILE
    ? new FileThinkingStore(process.env.THINKING_STATE_FILE) : new InMemoryThinkingStore();
  const arena = new ThinkingArena({
    goal, agents, store, limits,
    qualifyChallenge: async (challenge, task) => {
      try {
        const spec = specification(challenge);
        const accepted = equal(spec.requirements, required(task.level)) && spec.input.some(n => n < 0) &&
          spec.input.includes(0) && new Set(spec.input).size < spec.input.length;
        // Canonical application-owned key blocks rewording/reordering an already solved task.
        const key = createHash('sha256').update(JSON.stringify({
          input: [...spec.input].sort((a, b) => a - b), requirements: spec.requirements
        })).digest('hex');
        return { accepted, key, feedback: accepted ? 'Difficulty and scope verified.' : 'Match this level’s requirements and include negatives, zero, and duplicates.' };
      } catch {
        return { accepted: false, key: '', feedback: 'Problem must be valid JSON with integer input and permitted requirements.' };
      }
    },
    verifySolution: async (challenge, solution) => {
      const spec = specification(challenge);
      try {
        const result = JSON.parse(solution.answer);
        if (!Array.isArray(result.pipeline) || !result.pipeline.every(op => operations.includes(op))) throw new Error('Invalid pipeline');
        const actual = apply(spec.input, result.pipeline);
        // These application-owned cases are not sent to question, analysis, or solver agents.
        const holdouts = [[10, 2, -5, 0, 2], [], [-2, -2, -1], [0, 0], [100, 9, 11, -10]];
        return {
          checks: [
            { name: 'Requested output matches independent computation', kind: 'acceptance', passed: equal(result.output, apply(spec.input, spec.requirements)) && equal(actual, result.output) },
            ...holdouts.map((input, index) => ({ name: `Hidden array ${index + 1}`, kind: 'transfer', passed: equal(apply(input, result.pipeline), apply(input, spec.requirements)) }))
          ], feedback: 'Independently checked the output and reusable pipeline.'
        };
      } catch {
        return { checks: [{ name: 'Valid declarative solution', kind: 'acceptance', passed: false }], feedback: 'Return a JSON answer with a permitted pipeline and its output.' };
      }
    }
  });
  const result = await arena.run();
  console.log(JSON.stringify({ mode: process.argv.includes('--live') ? 'live' : 'offline demonstration',
    stopReason: result.stopReason, level: result.state.level, points: result.state.points,
    agentCalls: result.agentCalls, runs: result.state.runs.map(({ level, status, points }) => ({ level, status, points })),
    pendingLessons: result.state.lessons.filter(lesson => lesson.status === 'pending').length
  }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
