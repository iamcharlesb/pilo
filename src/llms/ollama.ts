import { configuredModel } from "../config/models";
import { BaseLLM, type BaseLLMConfig } from "./base";
import type { LLMResult, RunOptions, StreamCallback } from "../schema/types";

export interface OllamaLLMConfig extends BaseLLMConfig {
  model?: string;
  baseUrl?: string;
  keepAlive?: string;
  system?: string;
  format?: "json" | "" | Record<string, unknown>;
}

/**
 * Ollama local LLM. Connects to a locally running Ollama server.
 * Default base URL: http://localhost:11434
 */
export class OllamaLLM extends BaseLLM {
  modelName: string;
  readonly baseUrl: string;
  private keepAlive: string;
  private system?: string;
  private format?: "json" | "" | Record<string, unknown>;

  constructor(config: OllamaLLMConfig = {}) {
    super(config);
    this.modelName = configuredModel(config.model, "OLLAMA_MODEL");
    this.baseUrl = (config.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/+$/, "");
    this.keepAlive = config.keepAlive ?? "5m";
    this.system = config.system;
    this.format = config.format;
  }

  _llmType(): string {
    return "ollama";
  }

  async generate(prompts: string[], options?: RunOptions): Promise<LLMResult> {
    const generations: LLMResult["generations"] = [];
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    for (const prompt of prompts) {
      const body: Record<string, unknown> = {
        model: this.modelName,
        prompt,
        stream: false,
        options: {
          temperature: options?.temperature ?? this.temperature,
          top_p: options?.topP ?? this.topP,
          num_predict: options?.maxTokens ?? this.maxTokens,
          stop: options?.stop ?? (this.stop.length > 0 ? this.stop : undefined)
        },
        keep_alive: this.keepAlive
      };
      if (this.system) body["system"] = this.system;
      if (this.format) body["format"] = this.format;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), options?.timeout ?? this.timeout);

      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Ollama API error ${response.status}: ${errorBody}`);
      }

      const data = (await response.json()) as {
        response: string;
        done: boolean;
        prompt_eval_count?: number;
        eval_count?: number;
        done_reason?: string;
      };

      const promptTokens = data.prompt_eval_count ?? 0;
      const completionTokens = data.eval_count ?? 0;
      totalPromptTokens += promptTokens;
      totalCompletionTokens += completionTokens;

      generations.push([
        {
          text: data.response,
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

  async stream(prompt: string, callback: StreamCallback, options?: RunOptions): Promise<void> {
    const body: Record<string, unknown> = {
      model: this.modelName,
      prompt,
      stream: true,
      options: {
        temperature: options?.temperature ?? this.temperature,
        top_p: options?.topP ?? this.topP,
        num_predict: options?.maxTokens ?? this.maxTokens
      },
      keep_alive: this.keepAlive
    };
    if (this.system) body["system"] = this.system;
    if (this.format) body["format"] = this.format;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options?.timeout ?? this.timeout);

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
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
              response: string;
              done: boolean;
            };

            if (parsed.response) {
              await callback({
                text: parsed.response,
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
  async listModels(timeoutMs = 10_000): Promise<Array<{ name: string; size?: number; digest?: string }>> {
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
      const data = (await response.json()) as {
        models?: Array<{ name: string; size?: number; digest?: string }>;
      };
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
