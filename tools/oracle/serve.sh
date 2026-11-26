#!/usr/bin/env bash
set -euo pipefail
cd /opt/pilo/node/browser_agent
: "${BROWSER_AGENT_UI_PORT:?Set BROWSER_AGENT_UI_PORT in /etc/pilo/runtime.env}"
# The cloud server remains single-operator and private, even if a provider env file differs.
export BROWSER_AGENT_UI_HOST=127.0.0.1
export BROWSER_AGENT_DATA_DIR=/var/lib/pilo/data
export BROWSER_AGENT_WORKSPACE_ROOT=/var/lib/pilo/workspace
export BROWSER_AGENT_ENV_FILE=/var/lib/pilo/data/.env
export PLAYWRIGHT_BROWSERS_PATH=/var/lib/pilo/browsers
export BROWSER_AGENT_MANAGED_CHROME=1
export BROWSER_AGENT_CHROME_PATH
BROWSER_AGENT_CHROME_PATH="$(node -e 'process.stdout.write(require("playwright").chromium.executablePath())')"
test -x "$BROWSER_AGENT_CHROME_PATH"
exec node build/piloCli.js serve --port "$BROWSER_AGENT_UI_PORT" \
  --data-dir "$BROWSER_AGENT_DATA_DIR" --workspace "$BROWSER_AGENT_WORKSPACE_ROOT"
