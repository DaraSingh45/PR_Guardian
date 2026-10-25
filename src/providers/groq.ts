import type { LlmProvider } from "./index.js";
import { postJson, ProviderError } from "./http.js";

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
}

/** Groq via its OpenAI-compatible Chat Completions API (free tier available from console.groq.com). */
export class GroqProvider implements LlmProvider {
  readonly name = "groq";
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl = "https://api.groq.com/openai/v1",
  ) {}

  async complete(system: string, user: string): Promise<string> {
    const data = (await postJson(
      `${this.baseUrl}/chat/completions`,
      { Authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
    )) as ChatCompletion;

    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text) {
      throw new ProviderError(
        `Groq returned no text (finish_reason: ${data.choices?.[0]?.finish_reason ?? "unknown"})`,
      );
    }
    return text;
  }
}
