import crypto from "crypto";
import type { AuthSession, Authenticator } from "../auth";
import type {
  ApiKeyEntry,
  GatewayError,
  GatewayGuardrail,
  GatewayHeaders,
  GatewayProtocol,
  RateLimitConfig,
  RateLimitDecision
} from "./types";

function getHeader(headers: GatewayHeaders, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

function timingSafeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createGatewayError(
  message: string,
  statusCode: number,
  code: string,
  traceId?: string
): GatewayError {
  return Object.assign(new Error(message), {
    statusCode,
    code,
    traceId
  });
}

/**
 * Authenticates callers using static API keys passed in `x-api-key` or `Authorization: Bearer <key>`.
 * Keys are compared in constant time and never returned in sessions or error messages.
 */
export class ApiKeyAuthenticator implements Authenticator {
  private entries: ApiKeyEntry[];

  constructor(entries: ApiKeyEntry[]) {
    this.entries = entries.filter((entry) => Boolean(entry.key));
  }

  async authenticate(headers: GatewayHeaders): Promise<AuthSession | undefined> {
    const apiKeyHeader = getHeader(headers, "x-api-key")?.trim();
    const authHeader = getHeader(headers, "authorization")?.trim();
    const bearerKey = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : undefined;

    const candidate = apiKeyHeader || bearerKey;
    if (!candidate) {
      return undefined;
    }

    for (const entry of this.entries) {
      if (timingSafeEquals(candidate, entry.key)) {
        return {
          actor: {
            id: entry.id,
            roles: [...entry.roles],
            attributes: { ...(entry.attributes ?? {}), authMethod: "api-key" }
          },
          claims: {
            sub: entry.id,
            roles: [...entry.roles]
          }
        };
      }
    }

    throw createGatewayError("Invalid API key.", 401, "INVALID_API_KEY");
  }
}

/**
 * Tries multiple authenticators in sequence (e.g. JWT + API key).
 * Returns the first valid session; throws only if credentials were provided and all authenticators rejected them.
 */
export class CompositeAuthenticator implements Authenticator {
  constructor(private authenticators: Authenticator[]) {}

  async authenticate(headers: GatewayHeaders): Promise<AuthSession | undefined> {
    let lastError: unknown;
    for (const authenticator of this.authenticators) {
      try {
        const session = await authenticator.authenticate(headers);
        if (session) {
          return session;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }
    return undefined;
  }
}

/**
 * In-memory sliding-window rate limiter for gateway traffic.
 */
export class SlidingWindowRateLimiter {
  private windows = new Map<string, number[]>();
  private maxRequests: number;
  private windowMs: number;
  private keyBy: NonNullable<RateLimitConfig["keyBy"]>;

  constructor(config: RateLimitConfig) {
    this.maxRequests = Math.max(1, config.maxRequests);
    this.windowMs = Math.max(1, config.windowMs);
    this.keyBy = config.keyBy ?? "actor";
  }

  check(actorId: string, route: string, now = Date.now()): RateLimitDecision {
    const bucketKey =
      this.keyBy === "global"
        ? "global"
        : this.keyBy === "actor_route"
        ? `${actorId}:${route}`
        : actorId;

    const cutoff = now - this.windowMs;
    const timestamps = (this.windows.get(bucketKey) ?? []).filter((ts) => ts > cutoff);

    if (timestamps.length >= this.maxRequests) {
      const oldest = timestamps[0] ?? now;
      this.windows.set(bucketKey, timestamps);
      return {
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        resetAt: oldest + this.windowMs
      };
    }

    timestamps.push(now);
    this.windows.set(bucketKey, timestamps);
    return {
      allowed: true,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - timestamps.length),
      resetAt: timestamps[0] + this.windowMs
    };
  }

  reset(): void {
    this.windows.clear();
  }
}

/**
 * Convenience factory for regex/pattern-based prompt or tool-argument guardrails.
 */
export function createPatternGuardrail(config: {
  id: string;
  description?: string;
  patterns: RegExp[];
  protocols?: GatewayProtocol[];
}): GatewayGuardrail {
  return {
    id: config.id,
    description: config.description,
    protocols: config.protocols,
    inspect({ payload }) {
      const serialized = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
      for (const pattern of config.patterns) {
        pattern.lastIndex = 0;
        if (pattern.test(serialized)) {
          return {
            allowed: false,
            reason:
              config.description ??
              `Blocked by gateway guardrail "${config.id}".`
          };
        }
      }
      return { allowed: true };
    }
  };
}
