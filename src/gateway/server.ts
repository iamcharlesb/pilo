import http, { type IncomingMessage, type Server, type ServerResponse } from "http";
import type { FunctionDefinition, Message } from "../schema/types";
import type { MCPJsonRpcNotification, MCPJsonRpcRequest } from "../mcp/types";
import type { AgentGateway } from "./gateway";
import type { GatewayError, GatewayHeaders } from "./types";

export interface AgentGatewayServerConfig {
  gateway: AgentGateway;
  host?: string;
  port?: number;
  corsOrigin?: string;
  maxBodyBytes?: number;
}

function applyCors(response: ServerResponse, corsOrigin?: string): void {
  if (!corsOrigin) return;
  response.setHeader("Access-Control-Allow-Origin", corsOrigin);
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Key, X-Trace-Id");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  traceId?: string
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  if (traceId) {
    response.setHeader("x-trace-id", traceId);
  }
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw Object.assign(new Error(`Request body exceeds limit of ${maxBytes} bytes.`), {
        statusCode: 413,
        code: "PAYLOAD_TOO_LARGE"
      });
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw Object.assign(new Error("Invalid JSON request body."), {
      statusCode: 400,
      code: "INVALID_JSON"
    });
  }
}

function normalizeOpenAIMessages(raw: unknown): Message[] {
  if (!Array.isArray(raw)) {
    throw Object.assign(new Error("messages must be an array."), {
      statusCode: 400,
      code: "INVALID_REQUEST"
    });
  }

  return raw.map((item) => {
    const msg = (item ?? {}) as Record<string, unknown>;
    const roleRaw = String(msg["role"] ?? "user");
    const role: Message["role"] =
      roleRaw === "system"
        ? "system"
        : roleRaw === "assistant" || roleRaw === "ai"
        ? "ai"
        : roleRaw === "tool"
        ? "tool"
        : roleRaw === "function"
        ? "function"
        : "human";
    const rawToolCalls = Array.isArray(msg["tool_calls"]) ? msg["tool_calls"] : undefined;
    const toolCalls = rawToolCalls
      ?.map((entry) => {
        const tc = (entry ?? {}) as Record<string, unknown>;
        const fn = (tc["function"] ?? tc) as Record<string, unknown>;
        const name = typeof fn["name"] === "string" ? fn["name"] : "";
        if (!name) return undefined;
        const rawArgs = fn["arguments"];
        return {
          id: typeof tc["id"] === "string" ? tc["id"] : undefined,
          type: "function" as const,
          name,
          arguments: typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {})
        };
      })
      .filter((tc): tc is NonNullable<typeof tc> => Boolean(tc));

    return {
      role,
      content: typeof msg["content"] === "string" ? msg["content"] : msg["content"] == null ? "" : String(msg["content"]),
      name: typeof msg["name"] === "string" ? msg["name"] : undefined,
      toolCallId: typeof msg["tool_call_id"] === "string" ? msg["tool_call_id"] : undefined,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined
    };
  });
}

function normalizeOpenAITools(raw: unknown): FunctionDefinition[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw
    .map((entry) => {
      const obj = entry as Record<string, unknown>;
      const fn = (obj["function"] ?? obj) as Record<string, unknown>;
      return {
        name: String(fn["name"] ?? ""),
        description: String(fn["description"] ?? ""),
        parameters:
          fn["parameters"] && typeof fn["parameters"] === "object"
            ? (fn["parameters"] as Record<string, unknown>)
            : { type: "object", properties: {} }
      };
    })
    .filter((tool) => Boolean(tool.name));
}

/**
 * AgentGatewayServer — HTTP/JSON-RPC server exposing an AgentGateway over the network.
 *
 * Endpoints:
 * - GET  /health
 * - GET  /.well-known/agent.json
 * - GET  /gateway/status
 * - GET  /metrics
 * - POST /mcp
 * - GET  /a2a/agents
 * - GET  /a2a/agents/:id/card
 * - POST /a2a/tasks
 * - GET  /a2a/tasks/:id
 * - POST /a2a/tasks/:id/cancel
 * - POST /a2a/rpc
 * - GET  /v1/models
 * - POST /v1/chat/completions
 * - POST /v1/completions
 */
export class AgentGatewayServer {
  private gateway: AgentGateway;
  private host: string;
  private port: number;
  private corsOrigin?: string;
  private maxBodyBytes: number;
  private server?: Server;

  constructor(config: AgentGatewayServerConfig) {
    this.gateway = config.gateway;
    this.host = config.host ?? "127.0.0.1";
    this.port = config.port ?? 4400;
    this.corsOrigin = config.corsOrigin;
    this.maxBodyBytes = config.maxBodyBytes ?? 1_048_576;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    applyCors(response, this.corsOrigin);

    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

    const headers: GatewayHeaders = request.headers;
    const method = (request.method ?? "GET").toUpperCase();

    try {
      const hostHeader = Array.isArray(headers.host) ? headers.host[0] : headers.host;
      let baseUrl: string;
      let url: URL;
      try {
        baseUrl = `http://${hostHeader ?? `${this.host}:${this.port}`}`;
        url = new URL(request.url ?? "/", baseUrl);
      } catch {
        throw Object.assign(new Error("Invalid request URL or Host header."), {
          statusCode: 400,
          code: "INVALID_URL"
        });
      }
      const pathname = url.pathname;

      // Reject cross-origin mutating requests unless explicitly permitted by corsOrigin,
      // and require application/json on POST routes so text/plain simple-CORS POSTs cannot trigger execution.
      if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
        const originHeader = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
        if (originHeader) {
          const allowed =
            this.corsOrigin === "*" ||
            (this.corsOrigin ? originHeader === this.corsOrigin : false) ||
            originHeader === baseUrl;
          if (!allowed) {
            throw Object.assign(new Error(`Cross-origin ${method} request from "${originHeader}" is forbidden.`), {
              statusCode: 403,
              code: "CROSS_ORIGIN_FORBIDDEN"
            });
          }
        }
        const contentTypeHeader = Array.isArray(headers["content-type"])
          ? headers["content-type"][0]
          : headers["content-type"];
        if (method === "POST" && contentTypeHeader && !contentTypeHeader.toLowerCase().includes("application/json")) {
          throw Object.assign(new Error("POST requests must use Content-Type: application/json."), {
            statusCode: 415,
            code: "UNSUPPORTED_MEDIA_TYPE"
          });
        }
      }
      if (method === "GET" && pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          name: this.gateway.name,
          version: this.gateway.version
        });
        return;
      }

      if (method === "GET" && pathname === "/.well-known/agent.json") {
        sendJson(response, 200, this.gateway.getGatewayCard(baseUrl));
        return;
      }

      if (method === "GET" && pathname === "/gateway/status") {
        sendJson(response, 200, this.gateway.getStatus());
        return;
      }

      if (method === "GET" && pathname === "/metrics") {
        sendJson(response, 200, this.gateway.getMetrics());
        return;
      }

      // ---- MCP JSON-RPC 2.0 ----
      if (method === "POST" && pathname === "/mcp") {
        const body = (await readJsonBody(request, this.maxBodyBytes)) as
          | MCPJsonRpcRequest
          | MCPJsonRpcNotification;
        const result = await this.gateway.handleMCPRequest(body, headers);
        if (!result) {
          response.statusCode = 204;
          response.end();
          return;
        }
        sendJson(response, 200, result);
        return;
      }

      // ---- A2A Discovery & Tasks ----
      if (method === "GET" && pathname === "/a2a/agents") {
        const agents = await this.gateway.listAgents(headers);
        sendJson(response, 200, { agents });
        return;
      }

      const cardMatch = /^\/a2a\/agents\/([^/]+)\/card$/.exec(pathname);
      if (method === "GET" && cardMatch) {
        const card = await this.gateway.getAgentCard(decodeURIComponent(cardMatch[1]), headers);
        sendJson(response, 200, card);
        return;
      }

      if (method === "POST" && pathname === "/a2a/tasks") {
        const body = (await readJsonBody(request, this.maxBodyBytes)) as Record<string, unknown>;
        const task = await this.gateway.sendTask(
          {
            id: typeof body["id"] === "string" ? body["id"] : undefined,
            agentId: String(body["agentId"] ?? ""),
            input: String(body["input"] ?? ""),
            sessionId: typeof body["sessionId"] === "string" ? body["sessionId"] : undefined,
            metadata:
              body["metadata"] && typeof body["metadata"] === "object"
                ? (body["metadata"] as Record<string, unknown>)
                : undefined
          },
          headers
        );
        sendJson(response, 200, { task });
        return;
      }

      const taskCancelMatch = /^\/a2a\/tasks\/([^/]+)\/cancel$/.exec(pathname);
      if (method === "POST" && taskCancelMatch) {
        const task = await this.gateway.cancelTask(decodeURIComponent(taskCancelMatch[1]), headers);
        sendJson(response, 200, { task });
        return;
      }

      const taskGetMatch = /^\/a2a\/tasks\/([^/]+)$/.exec(pathname);
      if (method === "GET" && taskGetMatch) {
        const task = await this.gateway.getTask(decodeURIComponent(taskGetMatch[1]), headers);
        sendJson(response, 200, { task });
        return;
      }

      if (method === "POST" && pathname === "/a2a/rpc") {
        const body = (await readJsonBody(request, this.maxBodyBytes)) as {
          jsonrpc: "2.0";
          id: string | number;
          method: string;
          params?: Record<string, unknown>;
        };
        const result = await this.gateway.handleA2AJsonRpc(body, headers);
        sendJson(response, 200, result);
        return;
      }

      // ---- OpenAI-Compatible LLM Gateway Endpoints ----
      if (method === "GET" && pathname === "/v1/models") {
        const data = await this.gateway.listModels(headers);
        sendJson(response, 200, { object: "list", data });
        return;
      }

      if (method === "POST" && pathname === "/v1/chat/completions") {
        const body = (await readJsonBody(request, this.maxBodyBytes)) as Record<string, unknown>;
        const result = await this.gateway.routeChat(
          {
            model: typeof body["model"] === "string" ? body["model"] : undefined,
            target: typeof body["target"] === "string" ? body["target"] : undefined,
            messages: normalizeOpenAIMessages(body["messages"]),
            tools: normalizeOpenAITools(body["tools"]),
            options: {
              temperature: typeof body["temperature"] === "number" ? body["temperature"] : undefined,
              maxTokens: typeof body["max_tokens"] === "number" ? body["max_tokens"] : undefined,
              topP: typeof body["top_p"] === "number" ? body["top_p"] : undefined
            }
          },
          headers
        );

        sendJson(
          response,
          200,
          {
            id: result.id,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: result.model,
            gateway: {
              traceId: result.traceId,
              target: result.target,
              provider: result.provider,
              fallbackUsed: result.fallbackUsed,
              latencyMs: result.latencyMs
            },
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: result.message.content,
                  tool_calls: result.message.toolCalls?.map((call) => ({
                    id: call.id,
                    type: "function",
                    function: {
                      name: call.name,
                      arguments: call.arguments
                    }
                  }))
                },
                finish_reason: result.message.toolCalls?.length ? "tool_calls" : "stop"
              }
            ],
            usage: {
              prompt_tokens: result.usage.promptTokens,
              completion_tokens: result.usage.completionTokens,
              total_tokens: result.usage.totalTokens
            }
          },
          result.traceId
        );
        return;
      }

      if (method === "POST" && pathname === "/v1/completions") {
        const body = (await readJsonBody(request, this.maxBodyBytes)) as Record<string, unknown>;
        const result = await this.gateway.routeCompletion(
          {
            model: typeof body["model"] === "string" ? body["model"] : undefined,
            target: typeof body["target"] === "string" ? body["target"] : undefined,
            prompt: String(body["prompt"] ?? ""),
            options: {
              temperature: typeof body["temperature"] === "number" ? body["temperature"] : undefined,
              maxTokens: typeof body["max_tokens"] === "number" ? body["max_tokens"] : undefined,
              topP: typeof body["top_p"] === "number" ? body["top_p"] : undefined
            }
          },
          headers
        );

        sendJson(
          response,
          200,
          {
            id: result.id,
            object: "text_completion",
            created: Math.floor(Date.now() / 1000),
            model: result.model,
            gateway: {
              traceId: result.traceId,
              target: result.target,
              provider: result.provider,
              fallbackUsed: result.fallbackUsed,
              latencyMs: result.latencyMs
            },
            choices: [
              {
                index: 0,
                text: result.text,
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: result.usage.promptTokens,
              completion_tokens: result.usage.completionTokens,
              total_tokens: result.usage.totalTokens
            }
          },
          result.traceId
        );
        return;
      }

      sendJson(response, 404, { error: "Not found", code: "NOT_FOUND" });
    } catch (error) {
      const gwError = error as Partial<GatewayError>;
      const statusCode = typeof gwError.statusCode === "number" ? gwError.statusCode : 500;
      const code = gwError.code ?? "INTERNAL_ERROR";
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, statusCode, { error: message, code, traceId: gwError.traceId }, gwError.traceId);
    }
  }

  async start(): Promise<{ url: string; port: number; host: string }> {
    if (this.server) {
      const address = this.server.address();
      const port = typeof address === "object" && address ? address.port : this.port;
      return { url: `http://${this.host}:${port}`, port, host: this.host };
    }

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, this.host, () => resolve());
    });

    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : this.port;
    return {
      url: `http://${this.host}:${port}`,
      port,
      host: this.host
    };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    this.server = undefined;
  }
}
