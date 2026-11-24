# Contributing to Pilo

Contributions to reliability, Agent Gateway protocols (MCP/A2A), local Ollama support, coding workflows, documentation, and security are welcome.

## Local Development Setup

```bash
git clone --recurse-submodules https://github.com/iamcharlesb/pilo.git
cd pilo
npm ci
npm --prefix node/browser_agent ci
```

## Running Tests & Checks

Before opening a pull request, run both test suites (each includes an automated secret scan):

```bash
# Pilo Node.js runtime & Agent Gateway
npm test
npm run lint

# Pilo Desktop & Bot runtime (submodule)
npm --prefix node/browser_agent test
```

## Guidelines

- **Never commit secrets**: Model versions, provider credentials, pricing, and operational limits belong in `.env` or deployment environment variables.
- **No implicit paid work**: Notifications, health checks, and discovery endpoints must never silently start a model call, browser action, or paid recurring job.
- **Keep changes scoped**: Preserve unrelated work in the parent repository and `node/browser_agent` submodule.
- **Add tests**: Include unit or integration tests for new gateway rules, provider adapters, tools, or bug fixes.
