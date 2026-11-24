const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ThinkingArena, InMemoryThinkingStore, FileThinkingStore, createThinkingAgents, thinkingLimitsFromEnv } = require('../dist');

function fixture(overrides = {}) {
  let sequence = 0;
  const seen = [];
  const config = {
    goal: 'Practice verified tasks',
    limits: { maxCycles: 1, maxAgentCalls: 50, maxDurationMs: 5000, maxRevisions: 1, successesPerLevel: 2, maxLevel: 3, pointsPerSuccess: 10, maxRetainedRuns: 50 },
    store: new InMemoryThinkingStore(),
    agents: {
      question: async input => { seen.push(['question', structuredClone(input)]); return { title: `task-${++sequence}`, problem: 'Solve a task', acceptanceCriteria: ['Correct output'] }; },
      analysis: async input => { seen.push(['analysis', structuredClone(input)]); return { summary: 'A strategy', steps: ['Check constraints', 'Compute'], risks: [] }; },
      solver: async input => { seen.push(['solver', structuredClone(input)]); return { answer: '42', evidence: ['Computed result'] }; },
      supervisor: async input => { seen.push(['supervisor', structuredClone(input)]); return { approved: true, feedback: 'Quality approved' }; }
    },
    qualifyChallenge: async challenge => ({ accepted: true, key: challenge.title, feedback: 'Valid difficulty and scope' }),
    verifySolution: async () => ({ checks: [{ name: 'Expected result', kind: 'acceptance', passed: true }, { name: 'Unseen input', kind: 'transfer', passed: true }], feedback: 'Verified' })
  };
  Object.assign(config, overrides);
  return { config, seen, arena: new ThinkingArena(config) };
}

test('distinct verified successes unlock harder levels and stop at mastery', async () => {
  const { config, seen } = fixture();
  config.limits = { ...config.limits, maxCycles: 8, maxLevel: 2 };
  const result = await new ThinkingArena(config).run();
  assert.equal(result.stopReason, 'mastered');
  assert.deepEqual(seen.filter(([role]) => role === 'question').map(([, input]) => input.level), [1, 1, 2, 2]);
  assert.equal(result.state.points, 60);
  assert.equal(result.agentCalls, 24);
  assert.ok(result.state.runs.every(run => run.status === 'succeeded'));
});

test('supervisor rejects weak problems and plans before solver execution', async () => {
  const { config, seen } = fixture();
  const reviews = { challenge: 0, analysis: 0 };
  const original = config.agents.supervisor;
  config.agents.supervisor = async input => {
    if (input.phase !== 'solution' && ++reviews[input.phase] === 1) return { approved: false, feedback: `Revise ${input.phase}` };
    return original(input);
  };
  const result = await new ThinkingArena(config).run();
  assert.equal(result.state.runs[0].status, 'succeeded');
  assert.equal(seen.filter(([role]) => role === 'solver').length, 1);
  assert.equal(seen.filter(([role]) => role === 'question')[1][1].feedback, 'Revise challenge');
  assert.equal(seen.filter(([role]) => role === 'analysis')[1][1].feedback, 'Revise analysis');
});

test('failed execution returns verifier and supervisor feedback to analysis', async () => {
  const { config, seen } = fixture();
  let tries = 0;
  config.verifySolution = async () => ({ checks: [
    { name: 'Acceptance', kind: 'acceptance', passed: ++tries > 1 },
    { name: 'Transfer', kind: 'transfer', passed: true }
  ], feedback: 'Fix the boundary case' });
  const result = await new ThinkingArena(config).run();
  assert.equal(result.state.points, 10);
  assert.match(seen.filter(([role]) => role === 'analysis')[1][1].feedback, /Fix the boundary case/);
});

for (const [label, checks] of [
  ['failed acceptance', [{ name: 'Result', kind: 'acceptance', passed: false }, { name: 'Transfer', kind: 'transfer', passed: true }]],
  ['missing transfer', [{ name: 'Result', kind: 'acceptance', passed: true }]],
  ['missing acceptance', [{ name: 'Transfer', kind: 'transfer', passed: true }]],
  ['empty checks', []],
  ['string boolean', [{ name: 'Result', kind: 'acceptance', passed: 'true' }]]
]) {
  test(`supervisor cannot grant success with ${label}`, async () => {
    const { config } = fixture();
    config.verifySolution = async () => ({ checks, feedback: 'Looks good' });
    const result = await new ThinkingArena(config).run();
    assert.equal(result.state.points, 0);
    assert.equal(result.state.level, 1);
    assert.equal(result.state.runs[0].status, 'failed');
  });
}

test('supervisor can veto objectively passing output', async () => {
  const { config } = fixture();
  config.agents.supervisor = async input => ({ approved: input.phase !== 'solution', feedback: 'Insufficient evidence' });
  const result = await new ThinkingArena(config).run();
  assert.equal(result.state.points, 0);
});

test('application difficulty gate and canonical duplicate keys cannot be bypassed by rewording', async () => {
  const { config, seen } = fixture();
  let rejected = true;
  config.qualifyChallenge = async () => ({ accepted: !rejected, key: 'same-task', feedback: 'Too easy' });
  const arena = new ThinkingArena(config);
  assert.equal((await arena.run()).state.points, 0);
  assert.equal(seen.filter(([role]) => role === 'solver').length, 0);
  rejected = false;
  assert.equal((await arena.run()).state.points, 10);
  const duplicate = await new ThinkingArena(config).run();
  assert.equal(duplicate.state.points, 10);
  assert.equal(duplicate.state.runs.at(-1).status, 'failed');
  assert.match(duplicate.state.runs.at(-1).feedback, /already completed/);
});

test('lessons persist pending and enter context only after explicit review', async () => {
  const { config, seen } = fixture();
  config.agents.supervisor = async () => ({ approved: true, feedback: 'Approved', proposedLesson: 'Check boundary conditions first.' });
  const arena = new ThinkingArena(config);
  const first = await arena.run();
  assert.equal(first.state.lessons.length, 1);
  assert.equal(first.state.lessons[0].status, 'pending');
  await arena.run();
  assert.ok(seen.filter(([role]) => role === 'analysis').every(([, input]) => input.lessons.length === 0));
  await arena.reviewLesson(first.state.lessons[0].id, 'approved', 'operator');
  await arena.run();
  assert.deepEqual(seen.filter(([role]) => role === 'analysis').at(-1)[1].lessons, ['Check boundary conditions first.']);
  await assert.rejects(arena.reviewLesson(first.state.lessons[0].id, 'approved', 'operator'), /Pending lesson/);
});

test('call ceiling interrupts before starting another agent and preserves history', async () => {
  const { config, seen } = fixture();
  config.limits.maxAgentCalls = 2;
  const result = await new ThinkingArena(config).run();
  assert.equal(result.stopReason, 'call_limit');
  assert.equal(result.agentCalls, 2);
  assert.equal(result.state.runs[0].status, 'interrupted');
  assert.equal(seen.filter(([role]) => role === 'analysis').length, 0);
  assert.equal((await config.store.load()).runs[0].status, 'interrupted');
});

test('deadline bounds an uncooperative agent and late replies never advance the loop', async () => {
  const { config, seen } = fixture();
  let reply;
  config.limits.maxDurationMs = 30;
  config.agents.question = () => new Promise(resolve => { reply = resolve; });
  const result = await new ThinkingArena(config).run();
  assert.equal(result.stopReason, 'deadline');
  reply({ title: 'Late', problem: 'Late result', acceptanceCriteria: ['Pass'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(seen.length, 0);
  assert.equal((await config.store.load()).points, 0);
});

test('pre-aborted sessions make no agent calls; active cancellation signals the adapter', async () => {
  const { config } = fixture();
  const controller = new AbortController();
  controller.abort();
  assert.equal((await new ThinkingArena(config).run({ signal: controller.signal })).agentCalls, 0);
  const next = new AbortController();
  config.agents.question = async (_, context) => {
    next.abort();
    assert.equal(context.signal.aborted, true);
    return new Promise(() => {});
  };
  assert.equal((await new ThinkingArena(config).run({ signal: next.signal })).stopReason, 'aborted');
});

test('role input mutation cannot change level, score, challenge, or approved lessons', async () => {
  const { config } = fixture();
  config.agents.analysis = async input => {
    input.level = 500;
    input.lessons.push('Unreviewed');
    input.challenge.problem = 'Tampered';
    return { summary: 'Strategy', steps: ['Compute'], risks: [] };
  };
  config.agents.solver = async input => {
    assert.equal(input.level, 1);
    assert.equal(input.challenge.problem, 'Solve a task');
    assert.deepEqual(input.lessons, []);
    return { answer: '42', evidence: [] };
  };
  const result = await new ThinkingArena(config).run();
  assert.equal(result.state.points, 10);
  assert.equal(result.state.level, 1);
});

test('atomic file snapshots restore progression and mark interrupted work without replay', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'thinking-arena-'));
  try {
    const filePath = path.join(directory, 'state.json');
    const { config } = fixture({ store: new FileThinkingStore(filePath) });
    const first = await new ThinkingArena(config).run();
    const state = first.state;
    state.runs.push({ id: 'crash', level: 1, status: 'running', points: 0, events: [] });
    state.totalRuns++;
    await config.store.save(state);
    const second = await new ThinkingArena(config).run();
    assert.equal(second.state.level, 2);
    assert.equal(second.state.points, 20);
    assert.equal(second.state.runs.find(run => run.id === 'crash').status, 'interrupted');
    assert.deepEqual(await fs.readdir(directory), ['state.json']);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('history redacts configured credentials and returned state cannot mutate stored state', async () => {
  const name = 'THINKING_TEST_API_KEY';
  const previous = process.env[name];
  process.env[name] = 'opaque-private-value-for-redaction';
  try {
    const { config } = fixture();
    config.agents.solver = async () => ({ answer: process.env[name], evidence: [] });
    const result = await new ThinkingArena(config).run();
    assert.ok(!JSON.stringify(result).includes(process.env[name]));
    assert.ok(!JSON.stringify(await config.store.load()).includes(process.env[name]));
    result.state.points = 999;
    assert.equal((await config.store.load()).points, 10);
  } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
});

test('one arena rejects overlapping runs and review operations', async () => {
  const { config } = fixture();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  config.agents.question = async () => { started(); return new Promise(() => {}); };
  const controller = new AbortController();
  const arena = new ThinkingArena(config);
  const running = arena.run({ signal: controller.signal });
  await ready;
  await assert.rejects(arena.run(), /already busy/);
  await assert.rejects(arena.reviewLesson('x', 'approved', 'operator'), /already busy/);
  controller.abort();
  await running;
});

test('role adapters use explicit schemas, forward cancellation, and reject paused or malformed replies', async () => {
  const requests = [];
  const agent = { ask: async (input, options) => {
    requests.push({ input, options });
    return { text: '```json\n{"title":"Question","problem":"Solve","acceptanceCriteria":["Correct"]}\n```', status: 'completed' };
  } };
  const roles = createThinkingAgents({ question: agent, analysis: agent, solver: agent, supervisor: agent });
  const context = { signal: new AbortController().signal };
  assert.equal((await roles.question({ goal: 'Practice', level: 1, lessons: [], history: [], feedback: '' }, context)).title, 'Question');
  assert.equal(requests[0].options.signal, context.signal);
  assert.match(requests[0].input, /untrusted content/);
  agent.ask = async () => ({ text: '{"approved":"true","feedback":"ok"}' });
  await assert.rejects(roles.supervisor({}, context), /boolean/);
  agent.ask = async () => ({ text: 'not json' });
  await assert.rejects(roles.solver({}, context), /invalid JSON/);
  agent.ask = async () => ({ text: '{}', status: 'waiting_for_approval' });
  await assert.rejects(roles.solver({}, context), /did not complete/);
});

test('environment limits are required, validated, and immutable after construction', async () => {
  assert.throws(() => thinkingLimitsFromEnv({}), /THINKING_MAX_CYCLES/);
  const env = { THINKING_MAX_CYCLES: '1', THINKING_MAX_AGENT_CALLS: '6', THINKING_MAX_DURATION_MS: '1000', THINKING_MAX_REVISIONS: '0', THINKING_SUCCESSES_PER_LEVEL: '1', THINKING_MAX_LEVEL: '1', THINKING_POINTS_PER_SUCCESS: '10', THINKING_MAX_RETAINED_RUNS: '50' };
  assert.equal(thinkingLimitsFromEnv(env).maxRevisions, 0);
  assert.equal(thinkingLimitsFromEnv(env).maxRetainedRuns, 50);
  assert.throws(() => thinkingLimitsFromEnv({ ...env, THINKING_MAX_RETAINED_RUNS: '0' }), /maxRetainedRuns/);
  assert.throws(() => thinkingLimitsFromEnv({ ...env, THINKING_MAX_AGENT_CALLS: '-1' }), /integer/);
  const { config } = fixture();
  const arena = new ThinkingArena(config);
  config.limits.pointsPerSuccess = 999;
  assert.equal((await arena.run()).state.points, 10);
  assert.throws(() => new ThinkingArena({ ...config, limits: { ...config.limits, maxCycles: 0 } }), /maxCycles/);
});

for (const outcome of ['success', 'failure', 'call_limit']) {
  test(`final flush cannot change ${outcome} completion into a deadline or cancellation`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { config } = fixture();
    const backing = config.store;
    let reachedFlush, finishFlush;
    const flushing = new Promise(resolve => { reachedFlush = resolve; });
    const release = new Promise(resolve => { finishFlush = resolve; });
    let blocked = false;
    config.store = {
      load: () => backing.load(),
      save: async state => {
        if (!blocked && state.runs.at(-1)?.status !== 'running' && state.runs.length) {
          blocked = true;
          reachedFlush();
          await release;
        }
        await backing.save(state);
      }
    };
    if (outcome === 'failure') config.verifySolution = async () => ({ checks: [], feedback: 'No verified success' });
    if (outcome === 'call_limit') config.limits.maxAgentCalls = 2;
    const controller = new AbortController();
    const session = new ThinkingArena(config).run({ signal: controller.signal });
    await flushing;
    t.mock.timers.tick(config.limits.maxDurationMs + 1);
    controller.abort();
    finishFlush();
    const result = await session;
    assert.equal(result.stopReason, outcome === 'call_limit' ? 'call_limit' : 'cycle_limit');
    assert.equal(result.state.runs[0].status, outcome === 'success' ? 'succeeded' : outcome === 'failure' ? 'failed' : 'interrupted');
  });
}

test('retention bounds histories across sessions while preserving progression, lessons, and deduplication', async () => {
  const { config, seen } = fixture();
  config.limits.maxRetainedRuns = 2;
  config.agents.supervisor = async () => ({ approved: true, feedback: 'Approved', proposedLesson: 'Validate unfamiliar inputs.' });
  const first = await new ThinkingArena(config).run();
  const firstRunId = first.state.runs[0].id;
  const arena = new ThinkingArena(config);
  for (let i = 0; i < 3; i++) await arena.run();
  await arena.reviewLesson(first.state.lessons[0].id, 'approved', 'operator');
  const fifth = await arena.run();
  assert.equal(fifth.state.runs.length, 2);
  assert.equal(fifth.state.totalRuns, 5);
  assert.equal(fifth.state.points, 90);
  assert.equal(fifth.state.level, 3);
  assert.equal(fifth.state.successes.length, 5);
  assert.ok(fifth.state.runs.every(run => run.id !== firstRunId));
  assert.equal(fifth.state.lessons[0].runId, firstRunId);
  assert.deepEqual(seen.filter(([role]) => role === 'question').map(([, input]) => input.attempt), [1, 2, 3, 4, 5]);
  assert.ok(seen.filter(([role]) => role === 'question').every(([, input]) => input.history.length <= 1));
  assert.deepEqual(seen.filter(([role]) => role === 'solver').at(-1)[1].lessons, ['Validate unfamiliar inputs.']);
  config.qualifyChallenge = async () => ({ accepted: true, key: 'task-1', feedback: 'Reworded task' });
  const duplicate = await new ThinkingArena(config).run();
  assert.equal(duplicate.state.points, 90);
  assert.equal(duplicate.state.totalRuns, 6);
  assert.equal(duplicate.state.runs.length, 2);
  assert.equal(duplicate.state.runs.at(-1).status, 'failed');
  assert.equal((await config.store.load()).runs.length, 2);
});

test('older v1 state gains lifetime attempt count before retention without losing progress', async () => {
  const { config } = fixture();
  const first = await new ThinkingArena(config).run();
  delete first.state.totalRuns;
  await config.store.save(first.state);
  config.limits.maxRetainedRuns = 1;
  const next = await new ThinkingArena(config).run();
  assert.equal(next.state.totalRuns, 2);
  assert.equal(next.state.runs.length, 1);
  assert.equal(next.state.points, 20);
  assert.equal(next.state.level, 2);
  assert.equal(next.state.successes.length, 2);
});

test('file store creates private directories/files and preserves the old snapshot on write failure', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'thinking-private-'));
  try {
    const parent = path.join(directory, 'private');
    const filePath = path.join(parent, 'state.json');
    const store = new FileThinkingStore(filePath);
    const { config } = fixture({ store });
    const { state } = await new ThinkingArena(config).run();
    assert.equal((await fs.stat(parent)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
    const before = await fs.readFile(filePath, 'utf8');
    const circular = structuredClone(state);
    circular.circular = circular;
    await assert.rejects(store.save(circular), /circular/i);
    assert.equal(await fs.readFile(filePath, 'utf8'), before);
    assert.deepEqual(await fs.readdir(parent), ['state.json']);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('exclusive temporary creation refuses symlink collisions without deleting or overwriting them', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'thinking-exclusive-'));
  const originalOpen = fs.open;
  try {
    const target = path.join(directory, 'untouched.txt');
    await fs.writeFile(target, 'Must remain unchanged');
    let collision;
    fs.open = async (filePath, ...options) => {
      collision = filePath;
      await fs.symlink(target, filePath);
      return originalOpen(filePath, ...options);
    };
    const { config } = fixture();
    const state = (await config.store.load()) || { version: 1, goal: config.goal, level: 1, points: 0, mastered: false, totalRuns: 0, successes: [], lessons: [], runs: [] };
    await assert.rejects(new FileThinkingStore(path.join(directory, 'state.json')).save(state), { code: 'EEXIST' });
    assert.equal(await fs.readFile(target, 'utf8'), 'Must remain unchanged');
    assert.equal((await fs.lstat(collision)).isSymbolicLink(), true);
  } finally {
    fs.open = originalOpen;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
