export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST JSON with retries on rate limits (429) and server errors (5xx).
 * Honours Retry-After when the provider sends it; otherwise backs off exponentially.
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: { attempts?: number; baseDelayMs?: number; timeoutMs?: number } = {},
): Promise<unknown> {
  const attempts = opts.attempts ?? 4;
  const baseDelay = opts.baseDelayMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  let lastError: ProviderError | undefined;

  for (let i = 0; i < attempts; i++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastError = new ProviderError(`Network error: ${(err as Error).message}`, undefined, true);
      await sleep(baseDelay * 2 ** i);
      continue;
    }

    if (res.ok) return res.json();

    const text = await res.text().catch(() => "");
    const retryable = res.status === 429 || res.status >= 500;
    lastError = new ProviderError(
      `HTTP ${res.status}: ${text.slice(0, 500)}`,
      res.status,
      retryable,
    );
    if (!retryable) throw lastError;

    const retryAfter = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelay * 2 ** i;
    await sleep(Math.min(wait, 60_000));
  }
  throw lastError ?? new ProviderError("Request failed");
}
