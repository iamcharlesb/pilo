import type {
  MCPJsonRpcError,
  MCPJsonRpcNotification,
  MCPJsonRpcRequest,
  MCPJsonRpcResponse,
  MCPTransport
} from "../mcp/types";

export interface HttpMCPTransportConfig {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * HTTP JSON-RPC 2.0 transport for connecting MCPClient or AgentGateway
 * to a remote MCP server or another AgentGateway instance.
 */
export class HttpMCPTransport implements MCPTransport {
  private url: string;
  private headers: Record<string, string>;
  private timeoutMs: number;

  constructor(config: HttpMCPTransportConfig) {
    this.url = config.url;
    this.headers = { ...(config.headers ?? {}) };
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async request(message: MCPJsonRpcRequest): Promise<MCPJsonRpcResponse | MCPJsonRpcError> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.headers
        },
        body: JSON.stringify(message),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text();
        return {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32000,
            message: `Remote MCP HTTP error ${response.status}: ${body}`
          }
        };
      }

      return (await response.json()) as MCPJsonRpcResponse | MCPJsonRpcError;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async notify(message: MCPJsonRpcNotification): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.headers
        },
        body: JSON.stringify(message),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
