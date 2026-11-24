import type { Authenticator } from "../auth";
import type { BaseChatModel } from "../chat_models/base";
import type {
  AuditLogger,
  AuthorizationProvider,
  BudgetController,
  GovernanceActor,
  PolicyProvider
} from "../governance";
import type { BaseLLM } from "../llms/base";
import type { MCPClient, MCPImplementation, MCPServer } from "../mcp";
import type { FunctionDefinition, Message, RunOptions, ToolCallOptions } from "../schema/types";
import type { SimpleAgent } from "../simple/agent";
import type { ToolCallingAgentExecutor } from "../agents/tool_calling_executor";

export type GatewayProtocol = "mcp" | "a2a" | "llm" | "system";

export type GatewayHeaders = Record<string, string | string[] | undefined>;

export interface GatewayRequestContext {
  traceId: string;
  actor: GovernanceActor;
  protocol: GatewayProtocol;
  route: string;
  headers: GatewayHeaders;
  startedAt: number;
  signal?: AbortSignal;
}

export interface ApiKeyEntry {
  id: string;
  key: string;
  roles: string[];
  attributes?: Record<string, unknown>;
}

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  keyBy?: "actor" | "actor_route" | "global";
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

export interface GatewayGuardrail {
  id: string;
  description?: string;
  protocols?: GatewayProtocol[];
  inspect(input: {
    context: GatewayRequestContext;
    resourceType: string;
    resourceId: string;
    payload: unknown;
  }): { allowed: boolean; reason?: string } | Promise<{ allowed: boolean; reason?: string }>;
}

export interface MCPGatewayBackend {
  id: string;
  description?: string;
  namespace?: string;
  enabled?: boolean;
  tags?: string[];
  server?: MCPServer;
  client?: MCPClient;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface A2ASkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
}

export interface A2AAgentCard {
  id: string;
  name: string;
  description: string;
  version: string;
  url?: string;
  provider?: string;
  model?: string;
  capabilities?: {
    streaming?: boolean;
    tools?: boolean;
    mcp?: boolean;
  };
  inputModalities?: string[];
  outputModalities?: string[];
  skills?: A2ASkill[];
}

export type A2ATaskState = "submitted" | "working" | "completed" | "failed" | "canceled";

export interface A2ATaskMessage {
  role: "user" | "agent";
  text: string;
  metadata?: Record<string, unknown>;
}

export interface A2ATaskRequest {
  id?: string;
  agentId: string;
  input: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface A2ATask {
  id: string;
  agentId: string;
  sessionId?: string;
  state: A2ATaskState;
  createdAt: string;
  updatedAt: string;
  messages: A2ATaskMessage[];
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export type A2ATaskHandler = (
  request: A2ATaskRequest,
  context: GatewayRequestContext
) => Promise<string | { output: string; metadata?: Record<string, unknown> }>;

export interface A2ABackend {
  card: A2AAgentCard;
  enabled?: boolean;
  agent?: SimpleAgent;
  executor?: ToolCallingAgentExecutor;
  handler?: A2ATaskHandler;
  remoteUrl?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface LLMGatewayBackend {
  id: string;
  provider: string;
  model: string;
  aliases?: string[];
  fallbackTargets?: string[];
  enabled?: boolean;
  chatModel?: BaseChatModel;
  llm?: BaseLLM;
  metadata?: Record<string, unknown>;
}

export interface GatewayChatRequest {
  model?: string;
  target?: string;
  messages: Message[];
  tools?: FunctionDefinition[];
  options?: RunOptions & ToolCallOptions;
}

export interface GatewayChatResponse {
  id: string;
  traceId: string;
  target: string;
  provider: string;
  model: string;
  fallbackUsed: boolean;
  message: Message;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  latencyMs: number;
}

export interface GatewayCompletionRequest {
  model?: string;
  target?: string;
  prompt: string;
  options?: RunOptions;
}

export interface GatewayCompletionResponse {
  id: string;
  traceId: string;
  target: string;
  provider: string;
  model: string;
  fallbackUsed: boolean;
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  latencyMs: number;
}

export interface GatewayRouteMetrics {
  requests: number;
  errors: number;
  denied: number;
  rateLimited: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
}

export interface GatewayMetricsSnapshot {
  startedAt: string;
  uptimeMs: number;
  totals: {
    requests: number;
    errors: number;
    denied: number;
    rateLimited: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  byProtocol: Record<GatewayProtocol, GatewayRouteMetrics>;
  byBackend: Record<string, GatewayRouteMetrics>;
}

export interface AgentGatewayConfig {
  name?: string;
  version?: string;
  description?: string;
  serverInfo?: MCPImplementation;
  authenticator?: Authenticator;
  allowAnonymous?: boolean;
  anonymousActor?: GovernanceActor;
  authorizer?: AuthorizationProvider;
  policyEngine?: PolicyProvider;
  budgetManager?: BudgetController;
  auditLogger?: AuditLogger;
  rateLimit?: RateLimitConfig;
  guardrails?: GatewayGuardrail[];
  defaultLLMTarget?: string;
  mcpBackends?: MCPGatewayBackend[];
  a2aBackends?: A2ABackend[];
  llmBackends?: LLMGatewayBackend[];
}

export interface GatewayError extends Error {
  statusCode: number;
  code: string;
  traceId?: string;
}
