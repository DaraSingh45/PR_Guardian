import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider, DEFAULT_MODELS, ProviderError } from "../src/providers/index.js";
import { postJson } from "../src/providers/http.js";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

afterEach(() => vi.unstubAllGlobals());

describe("GeminiProvider", () => {
  it("sends system instruction, JSON mode and the key in a header", async () => {
    const fetchMock = vi.fn(async () => json({ candidates: [{ content: { parts: [{ text: '{"comments":[]}' }] } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const p = createProvider("gemini", "KEY123");
    expect(p.model).toBe(DEFAULT_MODELS.gemini);
    expect(await p.complete("sys", "user")).toBe('{"comments":[]}');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODELS.gemini}:generateContent`);
    expect(url).not.toContain("KEY123");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("KEY123");
    const body = JSON.parse(init.body as string);
    expect(body.system_instruction.parts[0].text).toBe("sys");
    expect(body.generationConfig.response_mime_type).toBe("application/json");
  });

  it("reports a blocked prompt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ promptFeedback: { blockReason: "SAFETY" } })));
    await expect(createProvider("gemini", "k").complete("s", "u")).rejects.toThrow(/SAFETY/);
  });
});

describe("GroqProvider", () => {
  it("uses the OpenAI-compatible endpoint with JSON mode", async () => {
    const fetchMock = vi.fn(async () => json({ choices: [{ message: { content: '{"summary":"ok"}' } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const p = createProvider("groq", "gsk_test", "llama-3.3-70b-versatile");
    expect(await p.complete("sys", "user")).toBe('{"summary":"ok"}');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gsk_test");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("llama-3.3-70b-versatile");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
  });

  it("honours a base URL override", async () => {
    const fetchMock = vi.fn(async () => json({ choices: [{ message: { content: "{}" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    await createProvider("groq", "k", "", { PR_GUARDIAN_GROQ_BASE_URL: "http://localhost:9999/v1" }).complete("s", "u");
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("http://localhost:9999/v1/chat/completions");
  });
});

describe("postJson retries", () => {
  it("retries 429 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: "rate" }, 429, { "retry-after": "0" }))
      .mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await postJson("http://x", {}, {}, { baseDelayMs: 1 })).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry auth errors", async () => {
    const fetchMock = vi.fn(async () => json({ error: "bad key" }, 401));
    vi.stubGlobal("fetch", fetchMock);
    const err = (await postJson("http://x", {}, {}, { baseDelayMs: 1 }).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after the attempt limit", async () => {
    const fetchMock = vi.fn(async () => json({}, 503));
    vi.stubGlobal("fetch", fetchMock);
    await expect(postJson("http://x", {}, {}, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
