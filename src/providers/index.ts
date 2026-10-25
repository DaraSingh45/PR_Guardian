import { GeminiProvider } from "./gemini.js";
import { GroqProvider } from "./groq.js";

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** Send a system + user prompt and return the model's raw text (expected to be JSON). */
  complete(system: string, user: string): Promise<string>;
}

export const DEFAULT_MODELS = {
  gemini: "gemini-3.5-flash-lite",
  groq: "openai/gpt-oss-120b",
} as const;

/**
 * Build the provider. Base URLs can be overridden with PR_GUARDIAN_GEMINI_BASE_URL /
 * PR_GUARDIAN_GROQ_BASE_URL (useful behind a corporate proxy or for local testing).
 */
export function createProvider(
  provider: "gemini" | "groq",
  apiKey: string,
  model?: string,
  env: NodeJS.ProcessEnv = {},
): LlmProvider {
  const chosen = model?.trim() || DEFAULT_MODELS[provider];
  switch (provider) {
    case "gemini":
      return new GeminiProvider(apiKey, chosen, env.PR_GUARDIAN_GEMINI_BASE_URL || undefined);
    case "groq":
      return new GroqProvider(apiKey, chosen, env.PR_GUARDIAN_GROQ_BASE_URL || undefined);
  }
}

export { ProviderError } from "./http.js";
