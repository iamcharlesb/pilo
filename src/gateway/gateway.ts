import { ChatOllama, type ChatOllamaConfig } from "../chat_models/ollama";
import { InMemoryAuditLogger } from "../governance/audit";
import type {
  AuditLogger,
  AuthorizationProvider,
  BudgetController,
  GovernanceActor,
  PolicyProvider,
  ScopedBudgetController
} from "../governance/base";
import { OllamaLLM, type OllamaLLMConfig } from "../llms/ollama";
import { InMemoryMCPTransport, MCPClient } from "../mcp/client";
import type {
  MCPInitializeResult,
  MCPJsonRpcError,
  MCPJsonRpcNotification,
  MCPJsonRpcRequest,
  MCPJsonRpcResponse,
  MCPPromptDefinition,
  MCPPromptResult,
  MCPResource,
  MCPResourceContent,
  MCPToolCallResult,
  MCPToolDefinition
} from "../mcp/types";
import { MCP_PROTOCOL_VERSION } from "../mcp/types";
import { createAgent, type CreateAgentConfig, type SimpleAgent } from "../simple/agent";
import { uuidv4 } from "../utils/uuid";
import { HttpMCPTransport } from "./mcp_transport";
import { createGatewayError, SlidingWindowRateLimiter } from "./security";
import type {
  A2AAgentCard,
  A2ABackend,
  A2ATask,
  A2ATaskRequest,
  AgentGatewayConfig,
  GatewayChatRequest,
  GatewayChatResponse,
  GatewayCompletionRequest,
  GatewayCompletionResponse,
  GatewayGuardrail,
  GatewayHeaders,
  GatewayMetricsSnapshot,
  GatewayProtocol,
  GatewayRequestContext,
  GatewayRouteMetrics,
  LLMGatewayBackend,
  MCPGatewayBackend
} from "./types";

interface NormalizedMCPBackend {
  config: MCPGatewayBackend;
  client: MCPClient;
  initialized: boolean;
}

interface MutableRouteMetrics {
  requests: number;
  errors: number;
  denied: number;
  rateLimited: number;
  totalLatencyMs: number;
}

function createEmptyRouteMetrics(): MutableRouteMetrics {
  return {
    requests: 0,
    errors: 0,
    denied: 0,
    rateLimited: 0,
    totalLatencyMs: 0
  };
}

function finalizeRouteMetrics(m: MutableRouteMetrics): GatewayRouteMetrics {
  return {
    requests: m.requests,
    errors: m.errors,
    denied: m.denied,
    rateLimited: m.rateLimited,
    totalLatencyMs: m.totalLatencyMs,
    avgLatencyMs: m.requests > 0 ? Math.round((m.totalLatencyMs / m.requests) * 100) / 100 : 0
  };
}

function getHeaderValue(headers: GatewayHeaders, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

function extractTokenUsage(source: unknown): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  if (!source || typeof source !== "object") {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
  const usage = source as Record<string, unknown>;
  const promptTokens =
    Number(
      usage["prompt_tokens"] ??
        usage["input_tokens"] ??
        usage["promptTokens"] ??
        usage["inputTokens"] ??
        0
    ) || 0;
  const completionTokens =
    Number(
      usage["completion_tokens"] ??
        usage["output_tokens"] ??
        usage["completionTokens"] ??
        usage["outputTokens"] ??
        0
    ) || 0;
  const totalTokens =
    Number(usage["total_tokens"] ?? usage["totalTokens"] ?? promptTokens + completionTokens) ||
    promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

export interface RegisterOllamaLLMOptions extends ChatOllamaConfig {
  id?: string;
  aliases?: string[];
  fallbackTargets?: string[];
  system?: string;
  includeCompletionLLM?: boolean;
  llmConfig?: OllamaLLMConfig;
}

export interface RegisterOllamaAgentOptions extends Omit<CreateAgentConfig, "provider"> {
  id: string;
  name: string;
  description: string;
  version?: string;
  skills?: A2AAgentCard["skills"];
  /** When true, automatically mounts this gateway's federated MCP tools onto the Ollama agent. */
  useGatewayMCP?: boolean;
  /** Optional headers passed when the Ollama agent invokes federated MCP tools through the gateway. */
  gatewayMCPHeaders?: GatewayHeaders;
}

/**
 * AgentGateway — AI-native protocol gateway for Fireworks++.
 *
 * Provides a unified, zero-trust control plane for:
 * - MCP federation & multiplexing (tools, resources, prompts across multiple backends)
 * - A2A (Agent-to-Agent) discovery, Agent Cards, and task routing
 * - LLM provider routing with model aliases, fallback chains, and Ollama support
 * - Security (JWT / API key auth, RBAC, policy rules, guardrails, rate limiting, budgets)
 * - Observability (trace IDs, redacted audit logs, live latency & token metrics)
 */
export class AgentGateway {
  readonly name: string;
  readonly version: string;
  readonly description: string;

  private serverInfo: { name: string; version: string };
  private authenticator?: AgentGatewayConfig["authenticator"];
  private allowAnonymous: boolean;
  private anonymousActor: GovernanceActor;
  private authorizer?: AuthorizationProvider;
  private policyEngine?: PolicyProvider;
  private budgetManager?: BudgetController;
  private auditLogger: AuditLogger;
  private rateLimiter?: SlidingWindowRateLimiter;
  private guardrails: GatewayGuardrail[];
  private defaultLLMTarget?: string;

  private mcpBackends = new Map<string, NormalizedMCPBackend>();
  private a2aBackends = new Map<string, A2ABackend>();
  private llmBackends = new Map<string, LLMGatewayBackend>();
  private llmAliases = new Map<string, string>();
  private tasks = new Map<string, A2ATask>();
  private taskAbortControllers = new Map<string, AbortController>();

  private startedAt = Date.now();
  private byProtocol: Record<GatewayProtocol, MutableRouteMetrics> = {
    mcp: createEmptyRouteMetrics(),
    a2a: createEmptyRouteMetrics(),
    llm: createEmptyRouteMetrics(),
    system: createEmptyRouteMetrics()
  };
  private byBackend = new Map<string, MutableRouteMetrics>();
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;

  constructor(config: AgentGatewayConfig = {}) {
    this.name = config.name ?? "pilo-agent-gateway";
    this.version = config.version ?? "0.1.0";
    this.description =
      config.description ??
      "AI-native Agent Gateway for MCP federation, A2A agent routing, and LLM orchestration.";
    this.serverInfo = config.serverInfo ?? {
      name: this.name,
      version: this.version
    };
    this.authenticator = config.authenticator;
    this.allowAnonymous = config.allowAnonymous ?? !config.authenticator;
    this.anonymousActor = config.anonymousActor ?? {
      id: "anonymous",
      roles: ["anonymous"]
    };
    this.authorizer = config.authorizer;
    this.policyEngine = config.policyEngine;
    this.budgetManager = config.budgetManager;
    this.auditLogger = config.auditLogger ?? new InMemoryAuditLogger();
    this.rateLimiter = config.rateLimit ? new SlidingWindowRateLimiter(config.rateLimit) : undefined;
    this.guardrails = [...(config.guardrails ?? [])];
    this.defaultLLMTarget = config.defaultLLMTarget;

    for (const backend of config.mcpBackends ?? []) {
      this.registerMCPBackend(backend);
    }
    for (const backend of config.a2aBackends ?? []) {
      this.registerAgent(backend);
    }
    for (const backend of config.llmBackends ?? []) {
      this.registerLLMBackend(backend);
    }
  }

  // ============================================================
  // Backend Registration
  // ============================================================

  registerMCPBackend(backend: MCPGatewayBackend): this {
    let client: MCPClient;
    if (backend.client) {
      client = backend.client;
    } else if (backend.server) {
      const server = backend.server;
      client = new MCPClient({
        transport: new InMemoryMCPTransport((msg) => server.handleMessage(msg))
      });
    } else if (backend.url) {
      client = new MCPClient({
        transport: new HttpMCPTransport({
          url: backend.url,
          headers: backend.headers,
          timeoutMs: backend.timeoutMs
        })
      });
    } else {
      throw new Error(
        `MCP backend "${backend.id}" must provide one of: server, client, or url.`
      );
    }

    this.mcpBackends.set(backend.id, {
      config: { ...backend, enabled: backend.enabled ?? true },
      client,
      initialized: false
    });
    return this;
  }

  unregisterMCPBackend(id: string): boolean {
    return this.mcpBackends.delete(id);
  }

  registerAgent(backend: A2ABackend): this {
    if (!backend.agent && !backend.executor && !backend.handler && !backend.remoteUrl) {
      throw new Error(
        `A2A agent "${backend.card.id}" must provide one of: agent, executor, handler, or remoteUrl.`
      );
    }
    this.a2aBackends.set(backend.card.id, {
      ...backend,
      enabled: backend.enabled ?? true
    });
    return this;
  }

  unregisterAgent(id: string): boolean {
    return this.a2aBackends.delete(id);
  }

  registerLLMBackend(backend: LLMGatewayBackend): this {
    if (!backend.chatModel && !backend.llm) {
      throw new Error(
        `LLM backend "${backend.id}" must provide at least one of: chatModel or llm.`
      );
    }
    const normalized: LLMGatewayBackend = {
      ...backend,
      enabled: backend.enabled ?? true
    };
    this.llmBackends.set(backend.id, normalized);
    this.llmAliases.set(backend.id, backend.id);
    if (backend.model) {
      if (!this.llmAliases.has(backend.model)) {
        this.llmAliases.set(backend.model, backend.id);
      }
      this.llmAliases.set(`${backend.provider}/${backend.model}`, backend.id);
    }
    for (const alias of backend.aliases ?? []) {
      this.llmAliases.set(alias, backend.id);
    }
    if (!this.defaultLLMTarget) {
      this.defaultLLMTarget = backend.id;
    }
    return this;
  }

  unregisterLLMBackend(id: string): boolean {
    const existed = this.llmBackends.delete(id);
    if (existed) {
      for (const [alias, target] of this.llmAliases.entries()) {
        if (target === id) {
          this.llmAliases.delete(alias);
        }
      }
      if (this.defaultLLMTarget === id) {
        this.defaultLLMTarget = this.llmBackends.keys().next().value;
      }
    }
    return existed;
  }

  /**
   * Convenience helper to register an Ollama model (both ChatOllama and OllamaLLM)
   * on the gateway for unified LLM routing, tool calling, and fallback chains.
   */
  registerOllamaLLM(options: RegisterOllamaLLMOptions = {}): {
    id: string;
    chatModel: ChatOllama;
    llm?: OllamaLLM;
  } {
    const chatModel = new ChatOllama(options);
    const llm =
      options.includeCompletionLLM === false
        ? undefined
        : new OllamaLLM({
            model: chatModel.modelName,
            baseUrl: chatModel.baseUrl,
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            topP: options.topP,
            stop: options.stop,
            timeout: options.timeout,
            keepAlive: options.keepAlive,
            system: options.system,
            format: options.format,
            ...(options.llmConfig ?? {})
          });

    const id = options.id ?? `ollama/${chatModel.modelName}`;
    const aliases = new Set<string>([
      `ollama:${chatModel.modelName}`,
      ...(options.aliases ?? [])
    ]);

    this.registerLLMBackend({
      id,
      provider: "ollama",
      model: chatModel.modelName,
      aliases: Array.from(aliases),
      fallbackTargets: options.fallbackTargets,
      chatModel,
      llm,
      metadata: {
        baseUrl: chatModel.baseUrl,
        local: true
      }
    });

    return { id, chatModel, llm };
  }

  /**
   * Convenience helper to create and register an Ollama-backed agent as an A2A target.
   * Optionally mounts this gateway's federated MCP tools onto the agent via `useGatewayMCP: true`.
   */
  async registerOllamaAgent(options: RegisterOllamaAgentOptions): Promise<{
    card: A2AAgentCard;
    agent: SimpleAgent;
  }> {
    const {
      id,
      name,
      description,
      version = "0.1.0",
      skills,
      useGatewayMCP = false,
      gatewayMCPHeaders,
      ...agentConfig
    } = options;

    const chatModel = agentConfig.chatModel ?? new ChatOllama({
      model: agentConfig.model,
      baseUrl: agentConfig.baseUrl,
      temperature: agentConfig.temperature,
      maxTokens: agentConfig.maxTokens,
      topP: agentConfig.topP,
      stop: agentConfig.stop,
      timeout: agentConfig.timeout
    });

    const agent = createAgent({
      ...agentConfig,
      provider: "ollama",
      chatModel
    });

    if (useGatewayMCP) {
      await agent.useMCP(this.createMCPClient(gatewayMCPHeaders));
    }

    const card: A2AAgentCard = {
      id,
      name,
      description,
      version,
      provider: "ollama",
      model: chatModel.modelName,
      capabilities: {
        streaming: false,
        tools: true,
        mcp: useGatewayMCP
      },
      inputModalities: ["text"],
      outputModalities: ["text"],
      skills: skills ?? [
        {
          id: `${id}-default`,
          name,
          description
        }
      ]
    };

    this.registerAgent({
      card,
      agent
    });

    return { card, agent };
  }

  // ============================================================
  // Security, Governance & Telemetry Pipeline
  // ============================================================

  private getBackendMetrics(backendKey: string): MutableRouteMetrics {
    let entry = this.byBackend.get(backendKey);
    if (!entry) {
      entry = createEmptyRouteMetrics();
      this.byBackend.set(backendKey, entry);
    }
    return entry;
  }

  private recordMetric(
    protocol: GatewayProtocol,
    backendKey: string | undefined,
    latencyMs: number,
    outcome: "ok" | "error" | "denied" | "rate_limited"
  ): void {
    const protoMetrics = this.byProtocol[protocol];
    protoMetrics.requests += 1;
    protoMetrics.totalLatencyMs += latencyMs;
    if (outcome === "error") protoMetrics.errors += 1;
    if (outcome === "denied") protoMetrics.denied += 1;
    if (outcome === "rate_limited") protoMetrics.rateLimited += 1;

    if (backendKey) {
      const bm = this.getBackendMetrics(backendKey);
      bm.requests += 1;
      bm.totalLatencyMs += latencyMs;
      if (outcome === "error") bm.errors += 1;
      if (outcome === "denied") bm.denied += 1;
      if (outcome === "rate_limited") bm.rateLimited += 1;
    }
  }

  private async authenticate(
    headers: GatewayHeaders,
    protocol: GatewayProtocol,
    route: string
  ): Promise<GatewayRequestContext> {
    const traceId = getHeaderValue(headers, "x-trace-id")?.trim() || uuidv4();
    const startedAt = Date.now();

    if (!this.authenticator) {
      if (!this.allowAnonymous) {
        throw createGatewayError("Authentication is required.", 401, "UNAUTHORIZED", traceId);
      }
      return {
        traceId,
        actor: this.anonymousActor,
        protocol,
        route,
        headers,
        startedAt
      };
    }

    let session;
    try {
      session = await this.authenticator.authenticate(headers);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.auditLogger.record({
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        type: "gateway.auth",
        status: "warning",
        resourceType: protocol,
        resourceId: route,
        message: `Authentication failed: ${message}`,
        details: { traceId }
      });
      throw createGatewayError(message, 401, "UNAUTHORIZED", traceId);
    }

    if (!session) {
      if (this.allowAnonymous) {
        return {
          traceId,
          actor: this.anonymousActor,
          protocol,
          route,
          headers,
          startedAt
        };
      }
      await this.auditLogger.record({
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        type: "gateway.auth",
        status: "warning",
        resourceType: protocol,
        resourceId: route,
        message: "Missing authentication credentials.",
        details: { traceId }
      });
      throw createGatewayError("Unauthorized", 401, "UNAUTHORIZED", traceId);
    }

    return {
      traceId,
      actor: session.actor,
      protocol,
      route,
      headers,
      startedAt
    };
  }

  private async isAuthorized(
    actor: GovernanceActor,
    resourceType: string,
    resourceId: string,
    action: string
  ): Promise<{ allowed: boolean; reason?: string }> {
    if (!this.authorizer) {
      return { allowed: true };
    }
    return this.authorizer.authorize({
      actor,
      resourceType,
      resourceId,
      action
    });
  }

  private async enforceControls(
    context: GatewayRequestContext,
    resourceType: string,
    resourceId: string,
    action: string,
    payload: unknown,
    backendKey?: string
  ): Promise<void> {
    if (this.rateLimiter) {
      const limitDecision = this.rateLimiter.check(context.actor.id, `${context.protocol}:${context.route}`);
      if (!limitDecision.allowed) {
        this.recordMetric(context.protocol, backendKey, Date.now() - context.startedAt, "rate_limited");
        await this.auditLogger.record({
          id: uuidv4(),
          timestamp: new Date().toISOString(),
          type: "gateway.rate_limit",
          status: "warning",
          actorId: context.actor.id,
          resourceType,
          resourceId,
          message: `Rate limit exceeded (${limitDecision.limit} reqs/window).`,
          details: { traceId: context.traceId, resetAt: limitDecision.resetAt }
        });
        throw createGatewayError(
          `Rate limit exceeded. Try again after ${new Date(limitDecision.resetAt).toISOString()}.`,
          429,
          "RATE_LIMITED",
          context.traceId
        );
      }
    }

    const authz = await this.isAuthorized(context.actor, resourceType, resourceId, action);
    if (!authz.allowed) {
      this.recordMetric(context.protocol, backendKey, Date.now() - context.startedAt, "denied");
      await this.auditLogger.record({
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        type: "gateway.rbac.deny",
        status: "warning",
        actorId: context.actor.id,
        resourceType,
        resourceId,
        message: authz.reason ?? `Forbidden: ${action} ${resourceType}:${resourceId}`,
        details: { traceId: context.traceId, action }
      });
      throw createGatewayError(
        authz.reason ?? `Forbidden: cannot ${action} ${resourceType}:${resourceId}`,
        403,
        "FORBIDDEN",
        context.traceId
      );
    }

    if (this.policyEngine) {
      const policyDecision = await this.policyEngine.evaluate({
        actor: context.actor,
        resourceType,
        resourceId,
        action,
        inputs: typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : { payload },
        metadata: { traceId: context.traceId, protocol: context.protocol, route: context.route }
      });
      if (!policyDecision.allowed) {
        this.recordMetric(context.protocol, backendKey, Date.now() - context.startedAt, "denied");
        await this.auditLogger.record({
          id: uuidv4(),
          timestamp: new Date().toISOString(),
          type: "gateway.policy.deny",
          status: "warning",
          actorId: context.actor.id,
          resourceType,
          resourceId,
          message: policyDecision.reason ?? "Blocked by gateway policy.",
          details: { traceId: context.traceId, matchedRuleIds: policyDecision.matchedRuleIds }
        });
        throw createGatewayError(
          policyDecision.reason ?? "Blocked by gateway policy.",
          403,
          "POLICY_DENIED",
          context.traceId
        );
      }
    }

    for (const guardrail of this.guardrails) {
      if (guardrail.protocols && !guardrail.protocols.includes(context.protocol)) {
        continue;
      }
      const decision = await guardrail.inspect({
        context,
        resourceType,
        resourceId,
        payload
      });
      if (!decision.allowed) {
        this.recordMetric(context.protocol, backendKey, Date.now() - context.startedAt, "denied");
        await this.auditLogger.record({
          id: uuidv4(),
          timestamp: new Date().toISOString(),
          type: "gateway.guardrail.deny",
          status: "warning",
          actorId: context.actor.id,
          resourceType,
          resourceId,
          message: decision.reason ?? `Blocked by guardrail "${guardrail.id}".`,
          details: { traceId: context.traceId, guardrailId: guardrail.id }
        });
        throw createGatewayError(
          decision.reason ?? `Blocked by guardrail "${guardrail.id}".`,
          403,
          "GUARDRAIL_BLOCKED",
          context.traceId
        );
      }
    }
  }

  private resolveBudgetScope(actor: GovernanceActor): string | undefined {
    if (typeof actor.attributes?.team === "string") {
      return actor.attributes.team;
    }
    if (Array.isArray(actor.attributes?.teams) && typeof actor.attributes.teams[0] === "string") {
      return actor.attributes.teams[0];
    }
    return undefined;
  }

  private assertBudgetAvailable(actor: GovernanceActor, name: string, traceId: string): void {
    if (!this.budgetManager) {
      return;
    }
    const scoped = this.budgetManager as ScopedBudgetController & {
      getScopedUsage?: (scope: string, name: string) => { remaining: number } | undefined;
    };
    const scope = this.resolveBudgetScope(actor);
    const usage =
      scope && typeof scoped.getScopedUsage === "function"
        ? scoped.getScopedUsage(scope, name)
        : this.budgetManager.getUsage(name);

    if (usage && usage.remaining <= 0) {
      throw createGatewayError(
        `Budget "${name}" is already exhausted (remaining: ${usage.remaining}).`,
        429,
        "BUDGET_EXCEEDED",
        traceId
      );
    }
  }

  private consumeBudget(actor: GovernanceActor, name: string, amount: number, traceId: string): void {
    if (!this.budgetManager || amount <= 0) {
      return;
    }
    const scoped = this.budgetManager as ScopedBudgetController;
    const scope = this.resolveBudgetScope(actor);

    const decision =
      scope && typeof scoped.consumeScoped === "function"
        ? scoped.consumeScoped(scope, name, amount)
        : this.budgetManager.consume(name, amount);

    if (!decision.allowed) {
      // Exhaust any remaining allowance still recorded in the budget manager so subsequent
      // over-budget calls cannot keep invoking paid backends.
      const scopedWithUsage = this.budgetManager as ScopedBudgetController & {
        getScopedUsage?: (scope: string, name: string) => { remaining: number } | undefined;
      };
      const currentUsage =
        scope && typeof scopedWithUsage.getScopedUsage === "function"
          ? scopedWithUsage.getScopedUsage(scope, name)
          : this.budgetManager.getUsage(name);
      if (currentUsage && currentUsage.remaining > 0) {
        if (scope && typeof scoped.consumeScoped === "function") {
          scoped.consumeScoped(scope, name, currentUsage.remaining);
        } else {
          this.budgetManager.consume(name, currentUsage.remaining);
        }
      }
      throw createGatewayError(
        decision.reason ?? `Budget "${name}" exceeded.`,
        429,
        "BUDGET_EXCEEDED",
        traceId
      );
    }
  }

  // ============================================================
  // MCP Gateway (Federation & Multiplexing)
  // ============================================================

  private async ensureMCPInitialized(entry: NormalizedMCPBackend): Promise<void> {
    if (entry.initialized) return;
    await entry.client.initialize();
    entry.initialized = true;
  }

  private qualifyName(backend: MCPGatewayBackend, name: string): string {
    return backend.namespace ? `${backend.namespace}__${name}` : name;
  }

  private qualifyUri(backend: MCPGatewayBackend, uri: string): string {
    return backend.namespace ? `${backend.namespace}://${uri.replace(/^[a-z0-9+.-]+:\/\//i, "")}` : uri;
  }

  private async resolveToolTarget(
    exposedName: string
  ): Promise<{ entry: NormalizedMCPBackend; rawName: string } | undefined> {
    for (const entry of this.mcpBackends.values()) {
      if (entry.config.enabled === false) continue;
      await this.ensureMCPInitialized(entry);

      if (entry.config.namespace) {
        const prefix = `${entry.config.namespace}__`;
        if (exposedName.startsWith(prefix)) {
          return { entry, rawName: exposedName.slice(prefix.length) };
        }
        continue;
      }

      const tools = await entry.client.listTools();
      if (tools.some((tool) => tool.name === exposedName)) {
        return { entry, rawName: exposedName };
      }
    }
    return undefined;
  }

  /**
   * Handle a single MCP JSON-RPC 2.0 request or notification through the gateway.
   */
  async handleMCPRequest(
    message: MCPJsonRpcRequest | MCPJsonRpcNotification,
    headers: GatewayHeaders = {}
  ): Promise<MCPJsonRpcResponse | MCPJsonRpcError | undefined> {
    if (!("id" in message)) {
      return undefined;
    }

    const context = await this.authenticate(headers, "mcp", message.method).catch((error) => {
      const status = (error as { statusCode?: number }).statusCode ?? 401;
      return { error, status };
    });

    if ("error" in context) {
      const err = context.error instanceof Error ? context.error.message : String(context.error);
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32001, message: err }
      };
    }

    try {
      switch (message.method) {
        case "initialize": {
          const result: MCPInitializeResult = {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: true },
              resources: { listChanged: true, subscribe: false },
              prompts: { listChanged: true }
            },
            serverInfo: this.serverInfo
          };
          this.recordMetric("mcp", undefined, Date.now() - context.startedAt, "ok");
          return { jsonrpc: "2.0", id: message.id, result: result as unknown as Record<string, unknown> };
        }

        case "ping": {
          this.recordMetric("mcp", undefined, Date.now() - context.startedAt, "ok");
          return { jsonrpc: "2.0", id: message.id, result: {} };
        }

        case "tools/list": {
          const aggregated: MCPToolDefinition[] = [];
          for (const entry of this.mcpBackends.values()) {
            if (entry.config.enabled === false) continue;
            await this.ensureMCPInitialized(entry);
            const tools = await entry.client.listTools();
            for (const tool of tools) {
              const exposedName = this.qualifyName(entry.config, tool.name);
              const authz = await this.isAuthorized(context.actor, "mcp_tool", exposedName, "call");
              if (!authz.allowed) continue;
              aggregated.push({
                ...tool,
                name: exposedName,
                description: entry.config.namespace
                  ? `[${entry.config.namespace}] ${tool.description}`
                  : tool.description
              });
            }
          }
          this.recordMetric("mcp", undefined, Date.now() - context.startedAt, "ok");
          return { jsonrpc: "2.0", id: message.id, result: { tools: aggregated } };
        }

        case "tools/call": {
          const params = message.params ?? {};
          const toolName = String(params["name"] ?? "");
          const args = (params["arguments"] ?? {}) as Record<string, unknown>;
          const target = await this.resolveToolTarget(toolName);
          if (!target) {
            this.recordMetric("mcp", undefined, Date.now() - context.startedAt, "error");
            return {
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32602, message: `Unknown MCP tool: ${toolName}` }
            };
          }

          const backendKey = `mcp:${target.entry.config.id}`;
          await this.enforceControls(context, "mcp_tool", toolName, "call", args, backendKey);
          this.consumeBudget(context.actor, "mcp_tool_calls", 1, context.traceId);

          const callResult: MCPToolCallResult = await target.entry.client.callTool(target.rawName, args);
          const latencyMs = Date.now() - context.startedAt;
          this.recordMetric("mcp", backendKey, latencyMs, callResult.isError ? "error" : "ok");
          await this.auditLogger.record({
            id: uuidv4(),
            timestamp: new Date().toISOString(),
            type: "gateway.mcp.tool_call",
            status: callResult.isError ? "error" : "success",
            actorId: context.actor.id,
            resourceType: "mcp_tool",
            resourceId: toolName,
            message: `MCP tool "${toolName}" executed via backend "${target.entry.config.id}".`,
            details: {
              traceId: context.traceId,
              backendId: target.entry.config.id,
              rawToolName: target.rawName,
              latencyMs,
              isError: Boolean(callResult.isError)
            }
          });
          return {
            jsonrpc: "2.0",
            id: message.id,
            result: callResult as unknown as Record<string, unknown>
          };
        }

        case "resources/list": {
          const resources: MCPResource[] = [];
          for (const entry of this.mcpBackends.values()) {
            if (entry.config.enabled === false) continue;
            await this.ensureMCPInitialized(entry);
            try {
              const items = await entry.client.listResources();
              for (const item of items) {
                const exposedUri = this.qualifyUri(entry.config, item.uri);
                const authz = await this.isAuthorized(context.actor, "mcp_resource", exposedUri, "read");
                if (!authz.allowed) continue;
                resources.push({ ...item, uri: exposedUri });
              }
            } catch {
              // Backend may not expose resources.
            }
          }
          this.recordMetric("mcp", undefined, Date.now() - context.startedAt, "ok");
          return { jsonrpc: "2.0", id: message.id, result: { resources } };
        }

        case "resources/read": {
          const uri = String(message.params?.["uri"] ?? "");
          for (const entry of this.mcpBackends.values()) {
            if (entry.config.enabled === false) continue;
            await this.ensureMCPInitialized(entry);
            let items: MCPResource[] = [];
            try {
              items = await entry.client.listResources();
            } catch {
              continue;
            }
            const match = items.find((item) => this.qualifyUri(entry.config, item.uri) === uri);
            if (!match) continue;

            const backendKey = `mcp:${entry.config.id}`;
            await this.enforceControls(context, "mcp_resource", uri, "read", { uri }, backendKey);
            const contents: MCPResourceContent[] = await entry.client.readResource(match.uri);
            this.recordMetric("mcp", backendKey, Date.now() - context.startedAt, "ok");
            return { jsonrpc: "2.0", id: message.id, result: { contents } };
          }
          return {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32002, message: `Resource not found: ${uri}` }
          };
        }

        case "prompts/list": {
          const prompts: MCPPromptDefinition[] = [];
          for (const entry of this.mcpBackends.values()) {
            if (entry.config.enabled === false) continue;
            await this.ensureMCPInitialized(entry);
            try {
              const items = await entry.client.listPrompts();
              for (const item of items) {
                const exposedName = this.qualifyName(entry.config, item.name);
                const authz = await this.isAuthorized(context.actor, "mcp_prompt", exposedName, "get");
                if (!authz.allowed) continue;
                prompts.push({ ...item, name: exposedName });
              }
            } catch {
              // Backend may not expose prompts.
            }
          }
          this.recordMetric("mcp", undefined, Date.now() - context.startedAt, "ok");
          return { jsonrpc: "2.0", id: message.id, result: { prompts } };
        }

        case "prompts/get": {
          const promptName = String(message.params?.["name"] ?? "");
          const promptArgs = (message.params?.["arguments"] ?? {}) as Record<string, unknown>;
          for (const entry of this.mcpBackends.values()) {
            if (entry.config.enabled === false) continue;
            await this.ensureMCPInitialized(entry);
            let items: MCPPromptDefinition[] = [];
            try {
              items = await entry.client.listPrompts();
            } catch {
              continue;
            }
            const match = items.find((item) => this.qualifyName(entry.config, item.name) === promptName);
            if (!match) continue;

            const backendKey = `mcp:${entry.config.id}`;
            await this.enforceControls(context, "mcp_prompt", promptName, "get", promptArgs, backendKey);
            const result: MCPPromptResult = await entry.client.getPrompt(match.name, promptArgs);
            this.recordMetric("mcp", backendKey, Date.now() - context.startedAt, "ok");
            return {
              jsonrpc: "2.0",
              id: message.id,
              result: result as unknown as Record<string, unknown>
            };
          }
          return {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32602, message: `Unknown prompt: ${promptName}` }
          };
        }

        default:
          return {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `Method not found: ${message.method}` }
          };
      }
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      const statusCode = (error as { statusCode?: number }).statusCode;
      const rpcCode = statusCode === 401 ? -32001 : statusCode === 403 ? -32003 : statusCode === 429 ? -32029 : -32603;
      if (!statusCode) {
        this.recordMetric("mcp", undefined, Date.now() - context.startedAt, "error");
      }
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: rpcCode, message: errMessage }
      };
    }
  }

  /**
   * Create an in-process MCPClient connected to this gateway's federated MCP layer.
   * Useful for mounting governed, federated tools onto any local agent (including Ollama agents).
   */
  createMCPClient(headers: GatewayHeaders = {}): MCPClient {
    return new MCPClient({
      transport: new InMemoryMCPTransport((msg) => this.handleMCPRequest(msg, headers))
    });
  }

  // ============================================================
  // A2A (Agent-to-Agent) Discovery & Task Routing
  // ============================================================

  getGatewayCard(baseUrl?: string): A2AAgentCard {
    const skills = Array.from(this.a2aBackends.values())
      .filter((backend) => backend.enabled !== false)
      .map((backend) => ({
        id: backend.card.id,
        name: backend.card.name,
        description: backend.card.description
      }));

    return {
      id: this.name,
      name: this.name,
      description: this.description,
      version: this.version,
      url: baseUrl,
      capabilities: {
        streaming: false,
        tools: this.mcpBackends.size > 0,
        mcp: this.mcpBackends.size > 0
      },
      inputModalities: ["text"],
      outputModalities: ["text"],
      skills
    };
  }

  async listAgents(headers: GatewayHeaders = {}): Promise<A2AAgentCard[]> {
    const context = await this.authenticate(headers, "a2a", "agents/list");
    const cards: A2AAgentCard[] = [];
    for (const backend of this.a2aBackends.values()) {
      if (backend.enabled === false) continue;
      const authz = await this.isAuthorized(context.actor, "a2a_agent", backend.card.id, "invoke");
      if (!authz.allowed) continue;
      cards.push(backend.card);
    }
    this.recordMetric("a2a", undefined, Date.now() - context.startedAt, "ok");
    return cards;
  }

  async getAgentCard(agentId: string, headers: GatewayHeaders = {}): Promise<A2AAgentCard> {
    const context = await this.authenticate(headers, "a2a", `agents/${agentId}`);
    const backend = this.a2aBackends.get(agentId);
    if (!backend || backend.enabled === false) {
      throw createGatewayError(`Unknown agent "${agentId}".`, 404, "AGENT_NOT_FOUND", context.traceId);
    }
    const authz = await this.isAuthorized(context.actor, "a2a_agent", agentId, "invoke");
    if (!authz.allowed) {
      throw createGatewayError(
        authz.reason ?? `Forbidden: cannot access agent "${agentId}".`,
        403,
        "FORBIDDEN",
        context.traceId
      );
    }
    this.recordMetric("a2a", undefined, Date.now() - context.startedAt, "ok");
    return backend.card;
  }

  async sendTask(request: A2ATaskRequest, headers: GatewayHeaders = {}): Promise<A2ATask> {
    const context = await this.authenticate(headers, "a2a", `tasks/send:${request.agentId}`);
    const backend = this.a2aBackends.get(request.agentId);
    if (!backend || backend.enabled === false) {
      this.recordMetric("a2a", undefined, Date.now() - context.startedAt, "error");
      throw createGatewayError(
        `Unknown agent "${request.agentId}".`,
        404,
        "AGENT_NOT_FOUND",
        context.traceId
      );
    }

    const backendKey = `a2a:${request.agentId}`;
    await this.enforceControls(
      context,
      "a2a_agent",
      request.agentId,
      "invoke",
      { input: request.input, metadata: request.metadata },
      backendKey
    );
    this.consumeBudget(context.actor, "a2a_tasks", 1, context.traceId);

    const nowIso = new Date().toISOString();
    const task: A2ATask = {
      id: request.id ?? uuidv4(),
      agentId: request.agentId,
      sessionId: request.sessionId,
      state: "working",
      createdAt: nowIso,
      updatedAt: nowIso,
      messages: [{ role: "user", text: request.input, metadata: request.metadata }],
      metadata: { traceId: context.traceId, actorId: context.actor.id, ...(request.metadata ?? {}) }
    };
    const taskAbortController = new AbortController();
    const taskContext: GatewayRequestContext = {
      ...context,
      signal: taskAbortController.signal
    };
    this.tasks.set(task.id, task);
    this.taskAbortControllers.set(task.id, taskAbortController);

    const runBackend = async (): Promise<{ outputText: string; extraMetadata?: Record<string, unknown> }> => {
      let outputText = "";
      let extraMetadata: Record<string, unknown> | undefined;

      if (backend.agent) {
        const result = await backend.agent.ask(request.input, {
          threadId: request.sessionId,
          signal: taskAbortController.signal
        });
        outputText = result.text;
      } else if (backend.executor) {
        const result = await backend.executor.call(
          { input: request.input },
          [],
          { signal: taskAbortController.signal }
        );
        outputText = String(result["output"] ?? result["text"] ?? "");
      } else if (backend.handler) {
        const result = await backend.handler(request, taskContext);
        if (typeof result === "string") {
          outputText = result;
        } else {
          outputText = result.output;
          extraMetadata = result.metadata;
        }
      } else if (backend.remoteUrl) {
        const controller = new AbortController();
        const onTaskAbort = () => controller.abort();
        taskAbortController.signal.addEventListener("abort", onTaskAbort, { once: true });
        if (taskAbortController.signal.aborted) controller.abort();
        const timeoutId = setTimeout(() => controller.abort(), backend.timeoutMs ?? 60_000);
        try {
          const response = await fetch(backend.remoteUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-trace-id": context.traceId,
              ...(backend.headers ?? {})
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: task.id,
              method: "tasks/send",
              params: {
                id: task.id,
                agentId: request.agentId,
                input: request.input,
                sessionId: request.sessionId,
                metadata: request.metadata
              }
            }),
            signal: controller.signal
          });
          if (!response.ok) {
            throw new Error(`Remote A2A agent returned HTTP ${response.status}: ${await response.text()}`);
          }
          const remoteData = (await response.json()) as {
            result?: { output?: string; task?: { output?: string } };
            output?: string;
            error?: { message?: string };
          };
          if (remoteData.error) {
            throw new Error(remoteData.error.message ?? "Remote A2A agent error");
          }
          outputText =
            remoteData.result?.output ??
            remoteData.result?.task?.output ??
            remoteData.output ??
            "";
        } finally {
          clearTimeout(timeoutId);
          taskAbortController.signal.removeEventListener("abort", onTaskAbort);
        }
      }

      return { outputText, extraMetadata };
    };

    try {
      const abortPromise = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error("Task canceled."), { canceled: true }));
        if (taskAbortController.signal.aborted) {
          onAbort();
        } else {
          taskAbortController.signal.addEventListener("abort", onAbort, { once: true });
        }
      });

      const { outputText, extraMetadata } = await Promise.race([runBackend(), abortPromise]);

      if (task.state !== "canceled" && !taskAbortController.signal.aborted) {
        task.state = "completed";
        task.output = outputText;
        task.messages.push({ role: "agent", text: outputText, metadata: extraMetadata });
        task.updatedAt = new Date().toISOString();
      }

      const latencyMs = Date.now() - context.startedAt;
      this.recordMetric("a2a", backendKey, latencyMs, "ok");
      await this.auditLogger.record({
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        type: "gateway.a2a.task",
        status: "success",
        actorId: context.actor.id,
        resourceType: "a2a_agent",
        resourceId: request.agentId,
        message: `A2A task "${task.id}" completed by agent "${request.agentId}".`,
        details: { traceId: context.traceId, taskId: task.id, latencyMs }
      });

      return task;
    } catch (error) {
      if (task.state === "canceled" || taskAbortController.signal.aborted || (error as { canceled?: boolean })?.canceled) {
        task.state = "canceled";
        task.updatedAt = new Date().toISOString();
        return task;
      }

      const errMessage = error instanceof Error ? error.message : String(error);
      task.state = "failed";
      task.error = errMessage;
      task.updatedAt = new Date().toISOString();

      const latencyMs = Date.now() - context.startedAt;
      this.recordMetric("a2a", backendKey, latencyMs, "error");
      await this.auditLogger.record({
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        type: "gateway.a2a.task",
        status: "error",
        actorId: context.actor.id,
        resourceType: "a2a_agent",
        resourceId: request.agentId,
        message: `A2A task "${task.id}" failed: ${errMessage}`,
        details: { traceId: context.traceId, taskId: task.id, latencyMs }
      });

      throw createGatewayError(errMessage, 502, "A2A_EXECUTION_FAILED", context.traceId);
    } finally {
      this.taskAbortControllers.delete(task.id);
    }
  }

  async getTask(taskId: string, headers: GatewayHeaders = {}): Promise<A2ATask> {
    const context = await this.authenticate(headers, "a2a", `tasks/get:${taskId}`);
    const task = this.tasks.get(taskId);
    if (!task) {
      throw createGatewayError(`Task "${taskId}" not found.`, 404, "TASK_NOT_FOUND", context.traceId);
    }
    const authz = await this.isAuthorized(context.actor, "a2a_agent", task.agentId, "invoke");
    if (!authz.allowed) {
      throw createGatewayError(
        authz.reason ?? `Forbidden: cannot inspect task "${taskId}".`,
        403,
        "FORBIDDEN",
        context.traceId
      );
    }
    return task;
  }

  async cancelTask(taskId: string, headers: GatewayHeaders = {}): Promise<A2ATask> {
    const task = await this.getTask(taskId, headers);
    if (task.state === "submitted" || task.state === "working") {
      task.state = "canceled";
      task.updatedAt = new Date().toISOString();
      const controller = this.taskAbortControllers.get(taskId);
      if (controller && !controller.signal.aborted) {
        controller.abort();
      }
      this.taskAbortControllers.delete(taskId);
    }
    return task;
  }

  async handleA2AJsonRpc(
    message: { jsonrpc: "2.0"; id: string | number; method: string; params?: Record<string, unknown> },
    headers: GatewayHeaders = {}
  ): Promise<MCPJsonRpcResponse | MCPJsonRpcError> {
    try {
      switch (message.method) {
        case "agents/list": {
          const agents = await this.listAgents(headers);
          return { jsonrpc: "2.0", id: message.id, result: { agents } };
        }
        case "tasks/send": {
          const params = message.params ?? {};
          const task = await this.sendTask(
            {
              id: typeof params["id"] === "string" ? params["id"] : undefined,
              agentId: String(params["agentId"] ?? ""),
              input: String(params["input"] ?? ""),
              sessionId: typeof params["sessionId"] === "string" ? params["sessionId"] : undefined,
              metadata:
                params["metadata"] && typeof params["metadata"] === "object"
                  ? (params["metadata"] as Record<string, unknown>)
                  : undefined
            },
            headers
          );
          return { jsonrpc: "2.0", id: message.id, result: { task, output: task.output ?? "" } };
        }
        case "tasks/get": {
          const task = await this.getTask(String(message.params?.["id"] ?? ""), headers);
          return { jsonrpc: "2.0", id: message.id, result: { task } };
        }
        case "tasks/cancel": {
          const task = await this.cancelTask(String(message.params?.["id"] ?? ""), headers);
          return { jsonrpc: "2.0", id: message.id, result: { task } };
        }
        default:
          return {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `Unknown A2A method: ${message.method}` }
          };
      }
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      const statusCode = (error as { statusCode?: number }).statusCode;
      const rpcCode = statusCode === 401 ? -32001 : statusCode === 403 ? -32003 : statusCode === 429 ? -32029 : -32603;
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: rpcCode, message: errMessage }
      };
    }
  }

  // ============================================================
  // LLM Provider Gateway (Unified Routing + Fallbacks + Ollama)
  // ============================================================

  private resolveLLMBackend(requested?: string): LLMGatewayBackend | undefined {
    const key = requested?.trim() || this.defaultLLMTarget;
    if (!key) return undefined;
    const mappedId = this.llmAliases.get(key) ?? key;
    const backend = this.llmBackends.get(mappedId);
    if (!backend || backend.enabled === false) {
      return undefined;
    }
    return backend;
  }

  async listModels(headers: GatewayHeaders = {}): Promise<
    Array<{
      id: string;
      object: "model";
      provider: string;
      model: string;
      aliases: string[];
      capabilities: { chat: boolean; completion: boolean };
    }>
  > {
    const context = await this.authenticate(headers, "llm", "models/list");
    const models: Array<{
      id: string;
      object: "model";
      provider: string;
      model: string;
      aliases: string[];
      capabilities: { chat: boolean; completion: boolean };
    }> = [];

    for (const backend of this.llmBackends.values()) {
      if (backend.enabled === false) continue;
      const authz = await this.isAuthorized(context.actor, "llm_model", backend.id, "invoke");
      if (!authz.allowed) continue;
      models.push({
        id: backend.id,
        object: "model",
        provider: backend.provider,
        model: backend.model,
        aliases: backend.aliases ?? [],
        capabilities: {
          chat: Boolean(backend.chatModel),
          completion: Boolean(backend.llm || backend.chatModel)
        }
      });
    }

    this.recordMetric("llm", undefined, Date.now() - context.startedAt, "ok");
    return models;
  }

  async routeChat(
    request: GatewayChatRequest,
    headers: GatewayHeaders = {}
  ): Promise<GatewayChatResponse> {
    const requestedTarget = request.target ?? request.model ?? this.defaultLLMTarget ?? "default";
    const context = await this.authenticate(headers, "llm", `chat:${requestedTarget}`);
    const primary = this.resolveLLMBackend(request.target ?? request.model);

    if (!primary) {
      this.recordMetric("llm", undefined, Date.now() - context.startedAt, "error");
      throw createGatewayError(
        `Unknown LLM target "${requestedTarget}".`,
        404,
        "MODEL_NOT_FOUND",
        context.traceId
      );
    }

    const candidates: LLMGatewayBackend[] = [primary];
    for (const fallbackId of primary.fallbackTargets ?? []) {
      const candidate = this.resolveLLMBackend(fallbackId);
      if (candidate && !candidates.some((item) => item.id === candidate.id)) {
        candidates.push(candidate);
      }
    }

    let lastError: unknown;
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      const backendKey = `llm:${candidate.id}`;
      await this.enforceControls(
        context,
        "llm_model",
        candidate.id,
        "invoke",
        { model: candidate.model, messages: request.messages },
        backendKey
      );

      if (!candidate.chatModel) {
        lastError = new Error(`LLM backend "${candidate.id}" does not support chat completions.`);
        continue;
      }

      this.assertBudgetAvailable(context.actor, "total_tokens", context.traceId);

      try {
        let replyMessage;
        let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

        if (request.tools && request.tools.length > 0) {
          replyMessage = await candidate.chatModel.callWithTools(
            request.messages,
            request.tools,
            request.options
          );
          usage = extractTokenUsage(replyMessage.metadata?.usage);
        } else {
          const result = await candidate.chatModel.generate([request.messages], request.options);
          const first = result.generations[0]?.[0];
          replyMessage = first?.message ?? { role: "ai" as const, content: first?.text ?? "" };
          usage = extractTokenUsage(result.llmOutput?.usage ?? first?.generationInfo?.usage);
        }

        this.totalPromptTokens += usage.promptTokens;
        this.totalCompletionTokens += usage.completionTokens;
        this.consumeBudget(context.actor, "total_tokens", usage.totalTokens, context.traceId);

        const latencyMs = Date.now() - context.startedAt;
        this.recordMetric("llm", backendKey, latencyMs, "ok");

        await this.auditLogger.record({
          id: uuidv4(),
          timestamp: new Date().toISOString(),
          type: "gateway.llm.chat",
          status: "success",
          actorId: context.actor.id,
          resourceType: "llm_model",
          resourceId: candidate.id,
          message: `Routed chat request to "${candidate.id}" (${candidate.provider}/${candidate.model}).`,
          details: {
            traceId: context.traceId,
            provider: candidate.provider,
            model: candidate.model,
            fallbackUsed: index > 0,
            usage,
            latencyMs
          }
        });

        return {
          id: `gwchat_${uuidv4().slice(0, 12)}`,
          traceId: context.traceId,
          target: candidate.id,
          provider: candidate.provider,
          model: candidate.model,
          fallbackUsed: index > 0,
          message: replyMessage,
          usage,
          latencyMs
        };
      } catch (error) {
        // Do not swallow budget/auth/policy denials into fallbacks.
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
          throw error;
        }
        lastError = error;
        this.recordMetric("llm", backendKey, Date.now() - context.startedAt, "error");
        await this.auditLogger.record({
          id: uuidv4(),
          timestamp: new Date().toISOString(),
          type: "gateway.llm.failover",
          status: "warning",
          actorId: context.actor.id,
          resourceType: "llm_model",
          resourceId: candidate.id,
          message: `LLM backend "${candidate.id}" failed: ${error instanceof Error ? error.message : String(error)}`,
          details: {
            traceId: context.traceId,
            hasFallback: index + 1 < candidates.length
          }
        });
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw createGatewayError(
      `All LLM backends failed for "${requestedTarget}": ${message}`,
      502,
      "LLM_BACKEND_FAILED",
      context.traceId
    );
  }

  async routeCompletion(
    request: GatewayCompletionRequest,
    headers: GatewayHeaders = {}
  ): Promise<GatewayCompletionResponse> {
    const requestedTarget = request.target ?? request.model ?? this.defaultLLMTarget ?? "default";
    const context = await this.authenticate(headers, "llm", `completion:${requestedTarget}`);
    const primary = this.resolveLLMBackend(request.target ?? request.model);

    if (!primary) {
      this.recordMetric("llm", undefined, Date.now() - context.startedAt, "error");
      throw createGatewayError(
        `Unknown LLM target "${requestedTarget}".`,
        404,
        "MODEL_NOT_FOUND",
        context.traceId
      );
    }

    const candidates: LLMGatewayBackend[] = [primary];
    for (const fallbackId of primary.fallbackTargets ?? []) {
      const candidate = this.resolveLLMBackend(fallbackId);
      if (candidate && !candidates.some((item) => item.id === candidate.id)) {
        candidates.push(candidate);
      }
    }

    let lastError: unknown;
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      const backendKey = `llm:${candidate.id}`;
      await this.enforceControls(
        context,
        "llm_model",
        candidate.id,
        "invoke",
        { model: candidate.model, prompt: request.prompt },
        backendKey
      );

      this.assertBudgetAvailable(context.actor, "total_tokens", context.traceId);

      try {
        let text = "";
        let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

        if (candidate.llm) {
          const result = await candidate.llm.generate([request.prompt], request.options);
          const first = result.generations[0]?.[0];
          text = first?.text ?? "";
          usage = extractTokenUsage(result.llmOutput?.usage ?? first?.generationInfo?.usage);
        } else if (candidate.chatModel) {
          const result = await candidate.chatModel.generate(
            [[{ role: "human", content: request.prompt }]],
            request.options
          );
          const first = result.generations[0]?.[0];
          text = first?.message?.content ?? first?.text ?? "";
          usage = extractTokenUsage(result.llmOutput?.usage ?? first?.generationInfo?.usage);
        }

        this.totalPromptTokens += usage.promptTokens;
        this.totalCompletionTokens += usage.completionTokens;
        this.consumeBudget(context.actor, "total_tokens", usage.totalTokens, context.traceId);

        const latencyMs = Date.now() - context.startedAt;
        this.recordMetric("llm", backendKey, latencyMs, "ok");

        await this.auditLogger.record({
          id: uuidv4(),
          timestamp: new Date().toISOString(),
          type: "gateway.llm.completion",
          status: "success",
          actorId: context.actor.id,
          resourceType: "llm_model",
          resourceId: candidate.id,
          message: `Routed completion request to "${candidate.id}" (${candidate.provider}/${candidate.model}).`,
          details: {
            traceId: context.traceId,
            provider: candidate.provider,
            model: candidate.model,
            fallbackUsed: index > 0,
            usage,
            latencyMs
          }
        });

        return {
          id: `gwcmpl_${uuidv4().slice(0, 12)}`,
          traceId: context.traceId,
          target: candidate.id,
          provider: candidate.provider,
          model: candidate.model,
          fallbackUsed: index > 0,
          text,
          usage,
          latencyMs
        };
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
          throw error;
        }
        lastError = error;
        this.recordMetric("llm", backendKey, Date.now() - context.startedAt, "error");
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw createGatewayError(
      `All LLM backends failed for "${requestedTarget}": ${message}`,
      502,
      "LLM_BACKEND_FAILED",
      context.traceId
    );
  }

  // ============================================================
  // Observability & Status (Read-Only, Never Starts Paid Work)
  // ============================================================

  getAuditLogger(): AuditLogger {
    return this.auditLogger;
  }

  getMetrics(): GatewayMetricsSnapshot {
    const protocols: GatewayProtocol[] = ["mcp", "a2a", "llm", "system"];
    const byProtocol = {} as Record<GatewayProtocol, GatewayRouteMetrics>;
    let requests = 0;
    let errors = 0;
    let denied = 0;
    let rateLimited = 0;

    for (const protocol of protocols) {
      const m = this.byProtocol[protocol];
      byProtocol[protocol] = finalizeRouteMetrics(m);
      requests += m.requests;
      errors += m.errors;
      denied += m.denied;
      rateLimited += m.rateLimited;
    }

    const byBackend: Record<string, GatewayRouteMetrics> = {};
    for (const [key, value] of this.byBackend.entries()) {
      byBackend[key] = finalizeRouteMetrics(value);
    }

    return {
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeMs: Date.now() - this.startedAt,
      totals: {
        requests,
        errors,
        denied,
        rateLimited,
        promptTokens: this.totalPromptTokens,
        completionTokens: this.totalCompletionTokens,
        totalTokens: this.totalPromptTokens + this.totalCompletionTokens
      },
      byProtocol,
      byBackend
    };
  }

  getStatus() {
    return {
      ok: true,
      name: this.name,
      version: this.version,
      authEnabled: Boolean(this.authenticator),
      allowAnonymous: this.allowAnonymous,
      backends: {
        mcp: Array.from(this.mcpBackends.values()).map((entry) => ({
          id: entry.config.id,
          namespace: entry.config.namespace,
          enabled: entry.config.enabled !== false
        })),
        a2a: Array.from(this.a2aBackends.values()).map((entry) => ({
          id: entry.card.id,
          name: entry.card.name,
          provider: entry.card.provider,
          model: entry.card.model,
          enabled: entry.enabled !== false
        })),
        llm: Array.from(this.llmBackends.values()).map((entry) => ({
          id: entry.id,
          provider: entry.provider,
          model: entry.model,
          aliases: entry.aliases ?? [],
          fallbackTargets: entry.fallbackTargets ?? [],
          enabled: entry.enabled !== false
        }))
      }
    };
  }
}
