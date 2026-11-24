# Agent Gateway & Ollama Support

Fireworks++ includes a native **Agent Gateway** (`src/gateway/`) for AI-native connectivity, security, and observability across **MCP**, **A2A (Agent-to-Agent)**, and **LLM** traffic, including first-class support for **Ollama LLMs and Ollama-backed agents**.

## Architecture Overview

Unlike a traditional HTTP reverse proxy, `AgentGateway` understands stateful and protocol-specific agent traffic:

1. **MCP Federation & Multiplexing (`POST /mcp`)**
   - Aggregates tools, resources, and prompts from multiple upstream MCP servers (in-memory `MCPServer`, `MCPClient`, or remote HTTP JSON-RPC servers via `HttpMCPTransport`).
   - Supports backend namespaces (`math__calculator`) to avoid tool-name collisions.
   - Filters `tools/list`, `resources/list`, and `prompts/list` per caller using RBAC so agents only see capabilities they are permitted to use.
2. **A2A Agent Discovery & Task Routing (`/.well-known/agent.json`, `/a2a/*`)**
   - Publishes Agent Cards for discovery (`GET /.well-known/agent.json`, `GET /a2a/agents`, `GET /a2a/agents/:id/card`).
   - Routes tasks (`POST /a2a/tasks`, `POST /a2a/rpc`) to local `SimpleAgent` / `ToolCallingAgentExecutor` / custom handlers or remote A2A HTTP endpoints, tracking task lifecycle (`submitted` -> `working` -> `completed` / `failed` / `canceled`).
3. **Unified LLM Gateway (`/v1/models`, `/v1/chat/completions`, `/v1/completions`)**
   - Routes chat, tool-calling, and completion traffic across registered `BaseChatModel` and `BaseLLM` backends (OpenAI, Anthropic, Gemini, Perplexity, and Ollama).
   - Supports model aliases and automatic failover chains (`fallbackTargets`, e.g., primary cloud model failing over to local Ollama).
4. **Zero-Trust Security & Governance**
   - **Authentication**: `HS256Authenticator` (JWT), `ApiKeyAuthenticator` (constant-time key check), or `CompositeAuthenticator`.
   - **RBAC**: `RBACAuthorizer` across `mcp_tool`, `mcp_resource`, `mcp_prompt`, `a2a_agent`, and `llm_model`.
   - **Policy & Guardrails**: `PolicyEngine` rules and `GatewayGuardrail` / `createPatternGuardrail` inspection.
   - **Rate Limiting & Budgets**: `SlidingWindowRateLimiter` and `BudgetManager` / `ScopedBudgetManager`.
5. **Observability**
   - Propagates `x-trace-id` across requests, records secret-redacted `AuditEvent` entries, and exposes live latency/error/denial/token metrics at `GET /metrics` and `gateway.getMetrics()`.

## Ollama LLMs and Agents

Both `ChatOllama` and `OllamaLLM` support:
- Native tool calling (`ChatOllama.callWithTools`) via Ollama's `/api/chat` `tools` API, enabling `ToolCallingAgent`, `ToolCallingAgentExecutor`, and `createAgent({ provider: "ollama", ... })`.
- Native structured outputs (`ChatOllama.generateStructured`) via Ollama's JSON Schema `format` option.
- Token usage reporting (`prompt_eval_count` / `eval_count` mapped to `llmOutput.usage`) for budgets, cost tracking, and gateway telemetry.
- Local model discovery and health checks (`listModels()`, `isAvailable()`).

Model versions and URLs are read from environment variables (`OLLAMA_MODEL`, `OLLAMA_BASE_URL`) when not explicitly passed in config.

## Quick Example

```ts
import {
  AgentGateway,
  AgentGatewayServer,
  ApiKeyAuthenticator,
  CalculatorTool,
  MCPServer,
  RBACAuthorizer
} from "fireworks-plus-plus";

const gateway = new AgentGateway({
  name: "local-agent-gateway",
  authenticator: new ApiKeyAuthenticator([
    { id: "dev-client", key: process.env.GATEWAY_API_KEY!, roles: ["developer"] }
  ]),
  authorizer: new RBACAuthorizer({
    roles: [
      {
        name: "developer",
        permissions: [
          { resourceType: "mcp_tool", action: "call", resourceId: "*" },
          { resourceType: "a2a_agent", action: "invoke", resourceId: "*" },
          { resourceType: "llm_model", action: "invoke", resourceId: "*" }
        ]
      }
    ]
  }),
  rateLimit: { maxRequests: 60, windowMs: 60_000 }
});

// 1. Register an MCP backend
gateway.registerMCPBackend({
  id: "math-mcp",
  namespace: "math",
  server: new MCPServer({ tools: [new CalculatorTool()] })
});

// 2. Register an Ollama LLM backend
gateway.registerOllamaLLM({
  id: "ollama-local",
  model: process.env.OLLAMA_MODEL,
  aliases: ["local-default"]
});

// 3. Register an Ollama agent wired to the gateway's federated MCP tools
await gateway.registerOllamaAgent({
  id: "ollama-assistant",
  name: "Ollama Assistant",
  description: "Local Ollama agent with governed MCP tools.",
  model: process.env.OLLAMA_MODEL,
  useGatewayMCP: true,
  gatewayMCPHeaders: { "x-api-key": process.env.GATEWAY_API_KEY }
});

// 4. Start the HTTP gateway server
const server = new AgentGatewayServer({ gateway, port: 4400 });
const { url } = await server.start();
console.log(`Agent Gateway listening at ${url}`);
```

## Declarative Configuration

Use `createGatewayFromConfig()` to construct a gateway from a static JSON/object config. Secrets are referenced by environment variable name (`jwtSecretEnv`, `keyEnv`) and never hardcoded in config files.
