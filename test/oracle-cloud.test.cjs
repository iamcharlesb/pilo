const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execute, config, assertIdle, run } = require('../tools/oracle/oracle.cjs');

const environment = {
  PILO_OCI_INSTANCE_ID: 'ocid1.instance.oc1.test.example', PILO_OCI_PROFILE: 'DEFAULT',
  PILO_OCI_REGION: 'us-ashburn-1', PILO_OCI_SSH_HOST: '192.0.2.1', PILO_OCI_SSH_USER: 'ubuntu',
  PILO_OCI_SSH_IDENTITY: '/private/test-key', PILO_OCI_SSH_PORT: '22', PILO_OCI_APP_PORT: '8766',
  PILO_OCI_MAX_OCPUS: '2', PILO_OCI_MAX_MEMORY_GB: '12', PILO_OCI_ALLOWED_SHAPE: 'VM.Standard.A1.Flex'
};
const vm = state => ({ shape: 'VM.Standard.A1.Flex', 'shape-config': { ocpus: 2, 'memory-in-gbs': 12 }, 'lifecycle-state': state });
const idle = () => ({ status: { ok: true, isRunning: false, activeRuns: [], learnSessionRunning: false, learnAwaitingApproval: false }, queue: { jobs: [] }, schedules: { schedules: [] } });
function fake(state, snapshot = idle()) {
  const calls = [];
  return { calls, invoke: async (file, args, interactive) => {
    calls.push({ file, args, interactive });
    if (file === 'ssh') return JSON.stringify(snapshot);
    return JSON.stringify({ data: vm(state) });
  } };
}

test('Oracle status is read-only and running start is idempotent', async () => {
  for (const command of ['status', 'start']) {
    const f = fake('RUNNING');
    await execute(command, config(environment), false, f.invoke);
    assert.equal(f.calls.length, 1);
    assert.ok(f.calls[0].args.includes('get'));
  }
});

test('Oracle start uses only the configured instance and rejects unexpected capacity', async () => {
  const f = fake('STOPPED');
  await execute('start', config(environment), false, f.invoke);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1].args.includes('START'));
  assert.ok(f.calls[1].args.includes(environment.PILO_OCI_INSTANCE_ID));
  const calls = [];
  await assert.rejects(execute('start', config(environment), false, async (...args) => {
    calls.push(args);
    return JSON.stringify({ data: { ...vm('STOPPED'), 'shape-config': { ocpus: 4, 'memory-in-gbs': 24 } } });
  }), /shape/);
  assert.equal(calls.length, 1);
});

test('shutdown requires explicit confirmation and refuses busy, pending, scheduled, and unknown work', async () => {
  const f = fake('RUNNING');
  await assert.rejects(execute('stop', config(environment), false, f.invoke), /confirm-stop/);
  assert.equal(f.calls.length, 1);
  const variants = [undefined, {}, { ...idle(), status: { ...idle().status, isRunning: true } },
    { ...idle(), status: { ...idle().status, activeRuns: [{ hasPendingApproval: true }] } },
    { ...idle(), status: { ...idle().status, learnAwaitingApproval: true } },
    { ...idle(), queue: { jobs: [{ status: 'queued' }] } },
    { ...idle(), schedules: { schedules: [{ status: 'scheduled' }] } },
    { ...idle(), queue: { jobs: [{ status: 'future-unknown-state' }] } }];
  for (const snapshot of variants) assert.throws(() => assertIdle(snapshot), /refused/);
  const busy = fake('RUNNING', { ...idle(), queue: { jobs: [{ status: 'running' }] } });
  await assert.rejects(execute('stop', config(environment), true, busy.invoke), /refused/);
  assert.equal(busy.calls.some(call => call.args.includes('SOFTSTOP')), false);
});

test('shutdown fails closed on SSH errors or malformed status and uses SOFTSTOP only after idle preflight', async () => {
  for (const response of ['malformed', null]) {
    const f = fake('RUNNING');
    await assert.rejects(execute('stop', config(environment), true, async (...args) => {
      if (args[0] === 'ssh') { if (response === null) throw new Error('unavailable'); return response; }
      return f.invoke(...args);
    }));
    assert.equal(f.calls.length, 1);
  }
  const f = fake('RUNNING');
  await execute('stop', config(environment), true, f.invoke);
  assert.deepEqual(f.calls.map(call => call.file), ['oci', 'ssh', 'oci']);
  assert.ok(f.calls[2].args.includes('SOFTSTOP'));
  assert.ok(!f.calls[2].args.includes('STOP'));
});

test('SSH forwarding binds only loopback and never wakes a stopped VM', async () => {
  const stopped = fake('STOPPED');
  await assert.rejects(execute('connect', config(environment), false, stopped.invoke), /not RUNNING/);
  assert.equal(stopped.calls.length, 1);
  const active = fake('RUNNING');
  await execute('connect', config(environment), false, active.invoke);
  const ssh = active.calls[1];
  assert.ok(ssh.args.includes('127.0.0.1:8766:127.0.0.1:8766'));
  assert.ok(ssh.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(ssh.args.includes('ExitOnForwardFailure=yes'));
});

test('reject SSH option injection, relative identities, and invalid ports before invocation', () => {
  for (const override of [{ PILO_OCI_SSH_HOST: '-oProxyCommand=example' },
    { PILO_OCI_SSH_USER: 'ubuntu; id' }, { PILO_OCI_SSH_IDENTITY: '~/.ssh/key' },
    { PILO_OCI_APP_PORT: '8766; id' }, { PILO_OCI_PROFILE: '--debug' }]) {
    assert.throws(() => config({ ...environment, ...override }));
  }
});

test('failed subprocess diagnostics do not expose their output', async () => {
  const marker = 'private-diagnostic-example';
  await assert.rejects(run(process.execPath, ['-e', `console.error('${marker}'); process.exit(1)`]), error => !error.message.includes(marker));
});
