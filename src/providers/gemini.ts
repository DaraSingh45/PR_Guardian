import type { LlmProvider } from "./index.js";
import { postJson, ProviderError } from "./http.js";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

/** Google Gemini via the Generative Language REST API (free tier available from Google AI Studio). */
export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl = "https://generativelanguage.googleapis.com/v1beta",
  ) {}

  async complete(system: string, user: string): Promise<string> {
    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`;
    const data = (await postJson(
      url,
      // Key goes in a header, not the URL, so it never appears in logs.
      { "x-goog-api-key": this.apiKey },
      {
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.1,
          response_mime_type: "application/json",
        },
      },
    )) as GeminiResponse;

    if (data.promptFeedback?.blockReason) {
      throw new ProviderError(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}`);
    }
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text) {
      throw new ProviderError(
        `Gemini returned no text (finishReason: ${data.candidates?.[0]?.finishReason ?? "unknown"})`,
      );
    }
    return text;
  }
}
