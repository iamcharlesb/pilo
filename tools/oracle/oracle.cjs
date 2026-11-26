#!/usr/bin/env node
/** Personal Oracle VM lifecycle. OCI credentials remain on the operator's machine. */
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { parseArgs, parseEnv } = require('node:util');

const help = `Pilo Oracle launcher (Node.js 22.12+; OCI CLI and OpenSSH required)
Usage: node tools/oracle/oracle.cjs COMMAND --config /private/path/oracle.env
  status   Read VM lifecycle and check configured shape limits; never starts it
  start    Start the configured VM; does not submit an agent task
  connect  Forward the private Pilo UI over SSH; does not start the VM
  stop --confirm-stop
           Refuse known active/queued work, then request graceful VM shutdown
Configuration: tools/oracle/.env.example. No provisioning or automatic retries.
`;

function config(env) {
  const required = name => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Set ${name} in the private configuration file.`);
    return value;
  };
  const integer = (name, max) => {
    const value = Number(required(name));
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}.`);
    return value;
  };
  const c = {
    instance: required('PILO_OCI_INSTANCE_ID'), profile: required('PILO_OCI_PROFILE'),
    region: required('PILO_OCI_REGION'), host: required('PILO_OCI_SSH_HOST'),
    user: required('PILO_OCI_SSH_USER'), identity: required('PILO_OCI_SSH_IDENTITY'),
    port: integer('PILO_OCI_SSH_PORT', 65535), appPort: integer('PILO_OCI_APP_PORT', 65535),
    maxCpus: integer('PILO_OCI_MAX_OCPUS', 128), maxMemory: integer('PILO_OCI_MAX_MEMORY_GB', 1024),
    shape: required('PILO_OCI_ALLOWED_SHAPE')
  };
  if (!/^ocid1\.instance\.[A-Za-z0-9._-]+$/.test(c.instance) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(c.profile) || !/^[a-z0-9][a-z0-9-]*$/.test(c.region) ||
      !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(c.host) || !/^[a-z_][a-z0-9_-]*$/.test(c.user) ||
      !c.identity.startsWith('/') || /[\r\n\0]/.test(c.identity)) throw new Error('Invalid Oracle or SSH configuration. Use an absolute identity-file path.');
  return c;
}

function run(file, args, interactive = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let output = '', tooLarge = false;
    const timer = interactive ? undefined : setTimeout(() => child.kill('SIGTERM'), 65_000);
    child.stdout?.on('data', chunk => {
      output += chunk;
      if (output.length > 1024 * 1024) { tooLarge = true; child.kill('SIGTERM'); }
    });
    // Do not print OCI/SSH diagnostics, which may contain private configuration.
    child.stderr?.resume();
    child.once('error', () => { clearTimeout(timer); reject(new Error(`${file} could not be started. Check installation and private configuration.`)); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0 || tooLarge) reject(new Error(`${file} failed. Check account access, host verification, connectivity, and service readiness.`));
      else resolve(output);
    });
  });
}

function sshArgs(c) {
  return ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-p', String(c.port), '-i', c.identity];
}

function assertShape(vm, c) {
  const shape = vm['shape-config'];
  if (vm.shape !== c.shape || !Number.isFinite(shape?.ocpus) || !Number.isFinite(shape?.['memory-in-gbs']) ||
      shape.ocpus <= 0 || shape['memory-in-gbs'] <= 0 || shape.ocpus > c.maxCpus || shape['memory-in-gbs'] > c.maxMemory) {
    throw new Error('VM shape exceeds configured limits or does not match the allowed shape. No power action was requested.');
  }
}

function assertIdle(snapshot) {
  const { status, queue, schedules } = snapshot || {};
  if (status?.ok !== true || status.isRunning !== false || !Array.isArray(status.activeRuns) ||
      status.activeRuns.length || status.learnSessionRunning !== false || status.learnAwaitingApproval !== false ||
      !Array.isArray(queue?.jobs) || !Array.isArray(schedules?.schedules) ||
      queue.jobs.some(job => !['completed', 'failed', 'cancelled'].includes(job?.status)) ||
      schedules.schedules.some(job => !['completed', 'failed'].includes(job?.status))) {
    throw new Error('Shutdown refused: active, queued, scheduled, or unknown work. Finish/cancel work and remove upcoming schedules first.');
  }
}

async function execute(command, c, confirmed = false, invoke = run) {
  const oci = args => invoke('oci', [...args, '--profile', c.profile, '--region', c.region, '--output', 'json']);
  const vm = JSON.parse(await oci(['compute', 'instance', 'get', '--instance-id', c.instance])).data;
  assertShape(vm, c);
  const state = vm['lifecycle-state'];
  if (command === 'status') return { state, shape: vm.shape, ocpus: vm['shape-config'].ocpus, memoryGB: vm['shape-config']['memory-in-gbs'] };
  if (command === 'connect') {
    if (state !== 'RUNNING') throw new Error('VM is not RUNNING. Use start explicitly.');
    console.log(`Pilo: http://127.0.0.1:${c.appPort} (keep this tunnel open; Ctrl-C disconnects only)`);
    await invoke('ssh', [...sshArgs(c), '-o', 'ExitOnForwardFailure=yes', '-N', '-L',
      `127.0.0.1:${c.appPort}:127.0.0.1:${c.appPort}`, `${c.user}@${c.host}`], true);
    return { disconnected: true };
  }
  if (command === 'start' && state === 'RUNNING') return { state, changed: false };
  if (command === 'stop' && state === 'STOPPED') return { state, changed: false };
  if (command === 'stop') {
    if (!confirmed) throw new Error('stop requires --confirm-stop. Close other Pilo clients first; a status check cannot prevent concurrent new submissions.');
    if (state !== 'RUNNING') throw new Error('Wait for the VM lifecycle transition before stopping.');
    const probe = `const base='http://127.0.0.1:${c.appPort}'; Promise.all(['/api/status','/api/run/jobs','/api/schedules'].map(async p=>{const r=await fetch(base+p,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error();return r.json()})).then(([status,queue,schedules])=>console.log(JSON.stringify({status,queue,schedules}))).catch(()=>process.exit(1))`;
    // OpenSSH passes a remote command through a shell: quote fixed code explicitly.
    const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
    assertIdle(JSON.parse(await invoke('ssh', [...sshArgs(c), `${c.user}@${c.host}`, `node -e ${quote(probe)}`])));
  } else if (command !== 'start' || state !== 'STOPPED') {
    throw new Error('Unsupported command or VM lifecycle transition. Inspect status first.');
  }
  // Do not wait in one blocking tool call. Read status again to observe completion.
  await oci(['compute', 'instance', 'action', '--instance-id', c.instance, '--action', command === 'start' ? 'START' : 'SOFTSTOP']);
  return { requested: command, message: 'Use status to check completion. Starting the VM does not mean Pilo is ready yet.' };
}

async function main() {
  const { values, positionals } = parseArgs({ options: { config: { type: 'string' }, help: { type: 'boolean' }, 'confirm-stop': { type: 'boolean' } }, allowPositionals: true });
  if (values.help || !positionals.length) { console.log(help); return; }
  if (positionals.length !== 1 || !['status', 'start', 'connect', 'stop'].includes(positionals[0])) throw new Error('Unknown command; see --help.');
  if (!values.config) throw new Error('Pass --config with a private environment file.');
  const env = { ...parseEnv(readFileSync(values.config, 'utf8')), ...process.env };
  console.log(JSON.stringify(await execute(positionals[0], config(env), values['confirm-stop']), null, 2));
}
if (require.main === module) main().catch(error => { console.error(`Pilo Oracle: ${error instanceof SyntaxError ? 'Invalid configuration or service response.' : error.message}`); process.exitCode = 1; });
module.exports = { config, execute, assertIdle, assertShape, sshArgs, run };
