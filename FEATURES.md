# Pilo features

## Bot catalog

- Responsive four-column desktop catalog and two-column mobile layout on the existing white background.
- All built-in bots visible by default, with Favorites and Recent collections.
- Search by name or role using the search icon; Escape closes and clears search.
- Dark Create bot button, custom profiles, and dedicated per-bot operating instructions, voice and playbooks.
- Added bots appear below unadded bots and carry a blue check indicator.
- Public-figure portraits where verified source images are available, including Sundar Pichai.
- Wall Street Analyst for public-company and market research; Goldman Sachs Analyst for independent valuation and transaction analysis.

## Huddles

Use **New Huddle** in the sidebar to create a named session. Search the complete bot catalog, select participants, then choose **Create huddle**. The same catalog powers the main bot selector and includes built-in and custom bots. Selected bots are saved automatically when needed; you do not have to add them beforehand.

Ask a question in the huddle to gather each selected bot's perspective, show attributed replies, and produce a shared synthesis. Follow-up questions use the session's conversation history. Sessions remain in the sidebar and reopen without starting model work. Use **Edit huddle** to change the name or participants once its work finishes or is stopped.

Creating a huddle starts no model request. Sending a question may incur provider charges. Discussions and specialist research are read-only; the session does not authorize publication, transactions, or recurring jobs. The server's configured participant and time limits apply; failures and missing replies are reported explicitly. A configured conversational model is required.

## Working with bots

- Separate conversations, saved drafts, queued follow-ups and scoped Stop controls.
- The open bot animates in the main view; sidebar animation is reserved for bots working in background conversations.
- Background runs continue when you return Home; Home clears the selected bot's header, draft view and run controls.
- Readable activity labels for live and restored runs, with expandable step details.
- Browser profiles, local terminal tools, document artifacts, HTML previews, and source-linked research.
- Compact operating instructions, separate voice files, and playbooks loaded when relevant.
- Real screen recording through `/record 10`, the Record screen button and Demo Director: live source preview, optional microphone narration, countdown, timed capture, original-resolution capture with text-detail encoding, playback and downloadable WebM artifacts.

## Agent Gateway & Ollama Support

- **AI-native Agent Gateway** (`fireworks-plus-plus/gateway` / `src/gateway/`): Standalone HTTP and programmatic gateway (`AgentGateway`, `AgentGatewayServer`) with declarative config (`createGatewayFromConfig`) resolving secrets from environment variables.
- **MCP federation & multiplexing**: Aggregates tools, resources, and prompts across in-memory and remote HTTP MCP backends (`HttpMCPTransport`) with optional namespacing and RBAC-filtered discovery.
- **A2A (Agent-to-Agent) discovery & routing**: Exposes gateway and per-agent cards (`/.well-known/agent.json`, `/a2a/agents`), routes tasks across local or remote agents (`/a2a/tasks`, `/a2a/rpc`), and tracks task lifecycle state.
- **Unified LLM routing & failover**: OpenAI-compatible `/v1/models`, `/v1/chat/completions`, and `/v1/completions` endpoints with model aliases, automatic failover chains (including cloud-to-local Ollama fallback), and token accounting.
- **Zero-trust security & observability**: Constant-time API key and HS256 JWT authentication (`CompositeAuthenticator`), RBAC, policy rules, pattern guardrails, sliding-window rate limiting, token/call budgets, secret-redacted audit logs, `x-trace-id` propagation, and `/metrics`.
- **Ollama LLMs & Ollama agents**: Native `ChatOllama` tool calling (`callWithTools`), JSON Schema structured outputs (`generateStructured`), `OllamaLLM` completions, token usage reporting, `/api/tags` model discovery, and one-step `registerOllamaLLM()` / `registerOllamaAgent()` helpers (with optional gateway-federated MCP tools).

## Operating boundaries

Pilo is a local, single-operator tool. Model providers can charge for requests. Runtime approval and permission checks govern actions; notifications do not authorize actions or recurring paid work. Origin checks do not isolate local accounts or authenticate every local process. Named bots are independent AI assistants, with no affiliation or endorsement by the named people or firms. Financial analysis is informational and requires verification, not personalized financial advice.

The screen recorder includes an optional guided Pilo walkthrough with actual catalog and workspace Help clicks, a visible pointer and captions. It preserves drafts, stops automation on operator input, and never submits model work.

Open `/demo` in the local Pilo web interface to play the guided walkthrough without recording. Optional local spoken narration plays with scene actions and is included directly in saved WebM audio, with optional microphone mixing.

Screen recording uses a guided preview → record → download setup with one primary action per stage. Source-resolution encoding preserves UI detail without canvas resizing, and preview displays the captured dimensions before recording.
