# Pilo on Oracle: personal persistent VM

This launch kit manages one existing Oracle VM. It does not create infrastructure,
upgrade an account, grant cloud permissions, submit agent tasks, or start recurring
paid work. The server remains a private, single-operator service behind SSH.

## Create the account and VM

1. Create an account at https://www.oracle.com/cloud/free/ and select your home region
   carefully: Always Free compute is region-bound and capacity can be unavailable.
2. In the Console, create an Ubuntu 24.04 Arm VM using an Always Free-eligible
   `VM.Standard.A1.Flex` shape. Verify eligibility and tenancy quotas in the Console
   before launching. Current free-tenancy documentation lists a total of 2 OCPUs /
   12 GB RAM; paid-account allowances can differ. The launcher's limits are configured
   in its private environment file and do not prove that an instance is free.
3. Use a persistent boot volume within your tenancy's free allocation. Keep backups
   outside the VM: free idle instances can be reclaimed, and restart capacity is not
   guaranteed. Do not select deletion of the boot volume when terminating an instance.
4. Allow inbound SSH only from your IP (or a private bastion/VPN). Do not expose Pilo's
   HTTP port, Chrome debugging, or a desktop/VNC port. Reserve a stable address or
   update the launcher's SSH host if it changes. Configure the guest firewall too.

Sources checked November 25, 2026:
[free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm),
[stop billing](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/resource-billing-stopped-instances.htm),
[power actions](https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/compute/instance/action.html).
Oracle supplies a resource allowance, not a recurring dollar-credit wallet like Modal.

## Prepare the VM once

These are operator-run setup steps, not a script to execute without reviewing the
VM and account. Use an administrative SSH account for installation, and a separate
unprivileged `pilo` account with home `/var/lib/pilo` for the application.

Install Node.js 22.12+ (available as `node` on PATH), Git, Xvfb, xauth, and Playwright's
Ubuntu system dependencies. Put a reviewed checkout, including the initialized
`node/browser_agent` submodule, at `/opt/pilo`; keep this code owned by the administrator,
readable by `pilo`. Do not copy your laptop's `.env`, browser cookies, or private data.
If this kit is uncommitted, transfer only its reviewed files separately; ordinary
`git clone` will not include local changes.

From `/opt/pilo/node/browser_agent`, install and build:

```sh
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build:production
npx playwright install-deps chromium
```

The last command needs administrative permissions. Then create private persistent
directories and install the browser as the application user:

```sh
sudo install -d -o pilo -g pilo -m 700 /var/lib/pilo/data /var/lib/pilo/workspace /var/lib/pilo/browsers
sudo -u pilo env HOME=/var/lib/pilo PLAYWRIGHT_BROWSERS_PATH=/var/lib/pilo/browsers npx playwright install chromium
sudo install -d -m 700 /etc/pilo
sudo install -m 644 /opt/pilo/tools/oracle/pilo.service /etc/systemd/system/pilo.service
```

Create `/etc/pilo/runtime.env` as root (mode 600) with the following non-secret
service configuration. Set all operational limits and model selection explicitly
in `/var/lib/pilo/data/.env` using the application's `.env.example` as reference.
Keep that provider file owned by `pilo`, mode 600. Provider setup can also be done
in Settings through the private tunnel; credentials remain on the VM.

```dotenv
BROWSER_AGENT_UI_PORT=8766
```

Enable the service after reviewing the files:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now pilo
sudo systemctl status pilo
```

The service runs with a virtual display, uses Playwright's Arm-compatible Chromium,
and retains its dedicated browser profile under `/var/lib/pilo`. Validate browsing,
login, and streaming on the real VM; some websites may reject cloud IPs or Chromium.
Laptop sessions are not imported. Open tabs, in-memory approvals, and active jobs
do not survive VM stop. Existing queue recovery may restore previously queued jobs;
keep this new cloud workspace empty of imported schedules/queues at first setup.

## Control the VM from your laptop

Install and configure the official OCI CLI locally using a narrowly scoped operator
profile for this instance's inspection and power actions. Keep its credentials out
of the VM and agent workspace; don't grant the instance an IAM policy to manage itself.
Configure SSH and verify the server host-key fingerprint through a trusted channel
before connecting; the launcher requires an already trusted host key.

Copy `.env.example` to a private path outside the checkout, fill in the VM details,
and restrict permissions to 600. Identity-file paths must be absolute (no `~`).

```sh
node tools/oracle/oracle.cjs status --config /private/path/oracle.env
node tools/oracle/oracle.cjs start --config /private/path/oracle.env
node tools/oracle/oracle.cjs status --config /private/path/oracle.env
node tools/oracle/oracle.cjs connect --config /private/path/oracle.env
```

Open `http://127.0.0.1:8766` while the SSH tunnel runs. Select Connected Chrome for
persistent browser sessions. An existing local Pilo server must use another port.
The launcher does not replace the Electron app's server; use the tunneled web UI
or existing CLI with `--server http://127.0.0.1:8766`.

Disconnecting SSH leaves the VM and active work running. To stop it, finish/cancel
tasks, remove upcoming schedules, and close other clients so no new tasks arrive:

```sh
node tools/oracle/oracle.cjs stop --confirm-stop --config /private/path/oracle.env
```

The launcher refuses active, queued, scheduled, learning, or unknown work, including
unreachable/malformed status. This is a manual single-operator preflight, not an
atomic drain: do not submit work concurrently with shutdown. OCI SOFTSTOP can force
power-off after its grace period. Interrupted outward actions require reconciliation,
not automatic retry. Check `status` to observe completion; start waits for neither
SSH nor Pilo readiness. Normal status reads never wake the machine.

## What remains before automatic sleep

Automatic idle shutdown is deliberately not enabled. It needs an application-level
drain gate covering task admission, schedules and queues, plus a trusted lifecycle
controller outside the agent's security boundary. CPU idleness is not task idleness.
For this first version use explicit start/stop, with no model heartbeats. Persistent
disk survives stop; live processes do not. Retained storage/network resources can
still incur charges outside free allowances. Stopping Linux alone does not substitute
for Oracle's stop API when controlling billing.

Before relying on the deployment, verify: private-only listening ports; real Arm
browser operation and approvals; a harmless task completing after tunnel disconnect;
busy-stop refusal; file/profile persistence across start/stop; backups; and account
usage/quotas. No live Oracle deployment has been validated by the local unit tests.
