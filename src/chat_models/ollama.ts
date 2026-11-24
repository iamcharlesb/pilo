import { configuredModel } from "../config/models";
import { uuidv4 } from "../utils/uuid";
import { BaseChatModel, type BaseChatModelConfig } from "./base";
import type {
  FunctionDefinition,
  LLMResult,
  Message,
  RunOptions,
  StreamCallback,
  StructuredOutputSchema,
  ToolCall,
  ToolCallOptions
} from "../schema/types";

export interface ChatOllamaConfig extends BaseChatModelConfig {
  model?: string;
  baseUrl?: string;
  keepAlive?: string;
  format?: "json" | "" | Record<string, unknown>;
}

export interface OllamaModelInfo {
  name: string;
  model?: string;
  size?: number;
  digest?: string;
  modified_at?: string;
  details?: Record<string, unknown>;
}

interface OllamaWireToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: Record<string, unknown> | string;
  };
}

interface OllamaWireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_name?: string;
  tool_calls?: Array<{
    type?: "function";
    function: {
      name: string;
      arguments: Record<string, unknown>;
    };
  }>;
}

function toOllamaRole(role: string): "system" | "user" | "assistant" | "tool" {
  switch (role) {
    case "system": return "system";
    case "human": return "user";
    case "ai": return "assistant";
    case "tool":
    case "function": return "tool";
    default: return "user";
  }
}

function parseToolCallArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { input: parsed };
  } catch {
    return { input: raw };
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * ChatOllama — chat model for locally running Ollama models.
 * Supports chat completions, streaming, native tool calling, structured outputs,
 * and model discovery via Ollama's HTTP API.
 */
export class ChatOllama extends BaseChatModel {
  modelName: string;
  readonly baseUrl: string;
  private keepAlive: string;
  private format: "json" | "" | Record<string, unknown>;

  constructor(config: ChatOllamaConfig = {}) {
    super(config);
    this.modelName = configuredModel(config.model, "OLLAMA_MODEL");
    this.baseUrl = normalizeBaseUrl(
      config.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434"
    );
    this.keepAlive = config.keepAlive ?? "5m";
    this.format = config.format ?? "";
  }

  _modelType(): string {
    return "chat-ollama";
  }

  private formatMessages(messages: Message[]): OllamaWireMessage[] {
    return messages.map((msg) => {
      const role = toOllamaRole(msg.role);
      const wire: OllamaWireMessage = {
        role,
        content: msg.content
      };

      if (role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
        wire.tool_calls = msg.toolCalls.map((call) => ({
          type: "function",
          function: {
            name: call.name,
            arguments: parseToolCallArguments(call.arguments)
          }
        }));
      }

      if (role === "tool" && msg.name) {
        wire.tool_name = msg.name;
      }

      return wire;
    });
  }

  private formatTools(
    tools: FunctionDefinition[]
  ): Array<{ type: "function"; function: FunctionDefinition }> {
    return tools.map((tool) => ({
      type: "function",
      function: tool
    }));
  }

  private parseAssistantMessage(raw: {
    role?: string;
    content?: string | null;
    tool_calls?: OllamaWireToolCall[];
  }): Message {
    const toolCalls: ToolCall[] = (raw.tool_calls ?? [])
      .filter((tc) => Boolean(tc.function?.name))
      .map((tc, index) => {
        const rawArgs = tc.function?.arguments;
        const serializedArgs =
          typeof rawArgs === "string"
            ? rawArgs
            : JSON.stringify(rawArgs ?? {});
        return {
          id: tc.id ?? `ollama_call_${index}_${uuidv4().slice(0, 8)}`,
          type: "function",
          name: tc.function!.name!,
          arguments: serializedArgs
        };
      });

    return {
      role: "ai",
      content: raw.content ?? "",
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    };
  }

  private buildOptions(options?: RunOptions): Record<string, unknown> {
    return {
      temperature: options?.temperature ?? this.temperature,
      top_p: options?.topP ?? this.topP,
      num_predict: options?.maxTokens ?? this.maxTokens,
      stop: options?.stop ?? (this.stop.length > 0 ? this.stop : undefined)
    };
  }

  private async postChat(
    body: Record<string, unknown>,
    options?: RunOptions
  ): Promise<{
    message: { role: string; content: string; tool_calls?: OllamaWireToolCall[] };
    done: boolean;
    done_reason?: string;
    prompt_eval_count?: number;
    eval_count?: number;
  }> {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    options?.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (options?.signal?.aborted) controller.abort();
    const timeoutId = setTimeout(() => controller.abort(), options?.timeout ?? this.timeout);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
      options?.signal?.removeEventListener("abort", onExternalAbort);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Ollama API error ${response.status}: ${errorBody}`);
    }

    return (await response.json()) as {
      message: { role: string; content: string; tool_calls?: OllamaWireToolCall[] };
      done: boolean;
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
  }

  async generate(messages: Message[][], options?: RunOptions): Promise<LLMResult> {
    const generations: LLMResult["generations"] = [];
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    for (const messageList of messages) {
      const body: Record<string, unknown> = {
        model: this.modelName,
        stream: false,
        messages: this.formatMessages(messageList),
        options: this.buildOptions(options),
        keep_alive: this.keepAlive
      };

      if (this.format) body["format"] = this.format;

      const data = await this.postChat(body, options);
      const assistantMessage = this.parseAssistantMessage(data.message ?? { content: "" });
      const promptTokens = data.prompt_eval_count ?? 0;
      const completionTokens = data.eval_count ?? 0;
      totalPromptTokens += promptTokens;
      totalCompletionTokens += completionTokens;

      generations.push([
        {
          text: assistantMessage.content,
          message: assistantMessage,
          generationInfo: {
            model: this.modelName,
            done: data.done,
            doneReason: data.done_reason,
            promptEvalCount: data.prompt_eval_count,
            evalCount: data.eval_count,
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens
            }
          }
        }
      ]);
    }

    return {
      generations,
      llmOutput: {
        model: this.modelName,
        usage: {
          prompt_tokens: totalPromptTokens,
          completion_tokens: totalCompletionTokens,
          total_tokens: totalPromptTokens + totalCompletionTokens
        }
      }
    };
  }

  override async callWithTools(
    messages: Message[],
    tools: FunctionDefinition[],
    options?: ToolCallOptions
  ): Promise<Message> {
    const body: Record<string, unknown> = {
      model: this.modelName,
      stream: false,
      messages: this.formatMessages(messages),
      options: this.buildOptions(options),
      keep_alive: this.keepAlive
    };

    if (options?.toolChoice !== "none" && tools.length > 0) {
      body["tools"] = this.formatTools(tools);
    }

    if (this.format) body["format"] = this.format;

    const data = await this.postChat(body, options);
    const assistantMessage = this.parseAssistantMessage(data.message ?? { content: "" });
    const promptTokens = data.prompt_eval_count ?? 0;
    const completionTokens = data.eval_count ?? 0;

    return {
      ...assistantMessage,
      metadata: {
        ...(assistantMessage.metadata ?? {}),
        model: this.modelName,
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens
        }
      }
    };
  }

  override async generateStructured<T>(
    messages: Message[],
    schema: StructuredOutputSchema,
    options?: RunOptions
  ): Promise<T> {
    const body: Record<string, unknown> = {
      model: this.modelName,
      stream: false,
      messages: this.formatMessages(messages),
      format: schema.schema,
      options: this.buildOptions(options),
      keep_alive: this.keepAlive
    };

    const data = await this.postChat(body, options);
    const content = data.message?.content ?? "";
    return this.parseJsonText<T>(content);
  }

  async stream(messages: Message[], callback: StreamCallback, options?: RunOptions): Promise<void> {
    const body: Record<string, unknown> = {
      model: this.modelName,
      stream: true,
      messages: this.formatMessages(messages),
      options: this.buildOptions(options),
      keep_alive: this.keepAlive
    };

    if (this.format) body["format"] = this.format;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options?.timeout ?? this.timeout);

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Ollama streaming error ${response.status}: ${errorBody}`);
      }

      reader = response.body?.getReader();
      if (!reader) throw new Error("No response body reader available");

      const decoder = new TextDecoder();
      let isFirst = true;
      let buffer = "";

      while (true) {
        if (controller.signal.aborted) {
          throw controller.signal.reason ?? new Error("Ollama streaming request timed out.");
        }
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const parsed = JSON.parse(line) as {
              message: { content: string };
              done: boolean;
            };

            if (parsed.message?.content) {
              await callback({
                text: parsed.message.content,
                isFirst,
                isFinal: parsed.done,
                metadata: { model: this.modelName }
              });
              isFirst = false;
            }

            if (parsed.done) return;
          } catch {
            // Ignore malformed JSON lines
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
      if (reader) {
        if (controller.signal.aborted) {
          await reader.cancel().catch(() => undefined);
        }
        reader.releaseLock();
      }
    }
  }

  /** List models currently pulled on the configured Ollama server. */
  async listModels(timeoutMs = 10_000): Promise<OllamaModelInfo[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: "GET",
        signal: controller.signal
      });
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Ollama listModels error ${response.status}: ${errorBody}`);
      }
      const data = (await response.json()) as { models?: OllamaModelInfo[] };
      return data.models ?? [];
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Check whether the configured Ollama server is reachable. */
  async isAvailable(timeoutMs = 5_000): Promise<boolean> {
    try {
      await this.listModels(timeoutMs);
      return true;
    } catch {
      return false;
    }
  }
}
