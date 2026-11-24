import { HS256Authenticator, type Authenticator } from "../auth";
import { ChatAnthropic } from "../chat_models/anthropic";
import { ChatGemini } from "../chat_models/gemini";
import { ChatOpenAI } from "../chat_models/openai";
import { ChatPerplexity } from "../chat_models/perplexity";
import { BudgetManager, RBACAuthorizer, type BudgetLimit, type GovernanceRole } from "../governance";
import { AgentGateway } from "./gateway";
import { ApiKeyAuthenticator, CompositeAuthenticator } from "./security";
import type { A2AAgentCard, RateLimitConfig } from "./types";

export interface DeclarativeGatewayLLMConfig {
  id: string;
  provider: "ollama" | "openai" | "anthropic" | "gemini" | "perplexity";
  model?: string;
  baseUrl?: string;
  aliases?: string[];
  fallbackTargets?: string[];
  keepAlive?: string;
}

export interface DeclarativeGatewayMCPConfig {
  id: string;
  url: string;
  namespace?: string;
  description?: string;
  timeoutMs?: number;
}

export interface DeclarativeGatewayA2AConfig {
  card: A2AAgentCard;
  remoteUrl: string;
  timeoutMs?: number;
}

export interface DeclarativeGatewayConfig {
  name?: string;
  version?: string;
  description?: string;
  allowAnonymous?: boolean;
  defaultLLMTarget?: string;
  auth?: {
    /** Environment variable name holding the HS256 JWT secret (never hardcode secrets in config). */
    jwtSecretEnv?: string;
    jwtIssuer?: string;
    jwtAudience?: string;
    apiKeys?: Array<{
      id: string;
      /** Environment variable name holding the API key value. */
      keyEnv: string;
      roles: string[];
    }>;
  };
  rbac?: {
    defaultAllow?: boolean;
    roles: GovernanceRole[];
  };
  rateLimit?: RateLimitConfig;
  budgets?: BudgetLimit[];
  llmBackends?: DeclarativeGatewayLLMConfig[];
  mcpBackends?: DeclarativeGatewayMCPConfig[];
  a2aBackends?: DeclarativeGatewayA2AConfig[];
}

/**
 * Builds an AgentGateway instance from a static/declarative configuration object.
 * Secrets are always resolved from environment variables named in config, never stored inline.
 */
export function createGatewayFromConfig(
  config: DeclarativeGatewayConfig,
  env: NodeJS.ProcessEnv = process.env
): AgentGateway {
  const authenticators: Authenticator[] = [];

  if (config.auth?.jwtSecretEnv) {
    const secret = env[config.auth.jwtSecretEnv]?.trim();
    if (!secret) {
      throw new Error(`Missing JWT secret in environment variable "${config.auth.jwtSecretEnv}".`);
    }
    authenticators.push(
      new HS256Authenticator({
        secret,
        issuer: config.auth.jwtIssuer,
        audience: config.auth.jwtAudience
      })
    );
  }

  if (config.auth?.apiKeys && config.auth.apiKeys.length > 0) {
    const resolvedEntries = config.auth.apiKeys.map((entry) => {
      const value = env[entry.keyEnv]?.trim();
      if (!value) {
        throw new Error(`Missing API key in environment variable "${entry.keyEnv}" for actor "${entry.id}".`);
      }
      return {
        id: entry.id,
        key: value,
        roles: entry.roles
      };
    });
    authenticators.push(new ApiKeyAuthenticator(resolvedEntries));
  }

  const authenticator =
    authenticators.length === 0
      ? undefined
      : authenticators.length === 1
      ? authenticators[0]
      : new CompositeAuthenticator(authenticators);

  const allowAnonymous =
    config.allowAnonymous !== undefined
      ? config.allowAnonymous
      : !config.auth && !authenticator;

  const authorizer = config.rbac
    ? new RBACAuthorizer({
        defaultAllow: config.rbac.defaultAllow ?? false,
        roles: config.rbac.roles
      })
    : undefined;

  const budgetManager =
    config.budgets && config.budgets.length > 0
      ? new BudgetManager({ limits: config.budgets })
      : undefined;

  const gateway = new AgentGateway({
    name: config.name,
    version: config.version,
    description: config.description,
    authenticator,
    allowAnonymous,
    authorizer,
    budgetManager,
    rateLimit: config.rateLimit,
    defaultLLMTarget: config.defaultLLMTarget
  });

  for (const backend of config.llmBackends ?? []) {
    switch (backend.provider) {
      case "ollama":
        gateway.registerOllamaLLM({
          id: backend.id,
          model: backend.model,
          baseUrl: backend.baseUrl,
          keepAlive: backend.keepAlive,
          aliases: backend.aliases,
          fallbackTargets: backend.fallbackTargets
        });
        break;
      case "openai": {
        const chatModel = new ChatOpenAI({ model: backend.model, baseUrl: backend.baseUrl });
        gateway.registerLLMBackend({
          id: backend.id,
          provider: "openai",
          model: chatModel.modelName,
          aliases: backend.aliases,
          fallbackTargets: backend.fallbackTargets,
          chatModel
        });
        break;
      }
      case "anthropic": {
        const chatModel = new ChatAnthropic({ model: backend.model, baseUrl: backend.baseUrl });
        gateway.registerLLMBackend({
          id: backend.id,
          provider: "anthropic",
          model: chatModel.modelName,
          aliases: backend.aliases,
          fallbackTargets: backend.fallbackTargets,
          chatModel
        });
        break;
      }
      case "gemini": {
        const chatModel = new ChatGemini({ model: backend.model, baseUrl: backend.baseUrl });
        gateway.registerLLMBackend({
          id: backend.id,
          provider: "gemini",
          model: chatModel.modelName,
          aliases: backend.aliases,
          fallbackTargets: backend.fallbackTargets,
          chatModel
        });
        break;
      }
      case "perplexity": {
        const chatModel = new ChatPerplexity({ model: backend.model, baseUrl: backend.baseUrl });
        gateway.registerLLMBackend({
          id: backend.id,
          provider: "perplexity",
          model: chatModel.modelName,
          aliases: backend.aliases,
          fallbackTargets: backend.fallbackTargets,
          chatModel
        });
        break;
      }
    }
  }

  for (const mcp of config.mcpBackends ?? []) {
    gateway.registerMCPBackend({
      id: mcp.id,
      url: mcp.url,
      namespace: mcp.namespace,
      description: mcp.description,
      timeoutMs: mcp.timeoutMs
    });
  }

  for (const a2a of config.a2aBackends ?? []) {
    gateway.registerAgent({
      card: a2a.card,
      remoteUrl: a2a.remoteUrl,
      timeoutMs: a2a.timeoutMs
    });
  }

  return gateway;
}
