export interface HttpPostJsonArgs {
  endpoint: string;
  apiKey: string;
  body: unknown;
  timeoutMs: number;
  headers?: Record<string, string>;
}

export interface HttpPostJsonResult {
  ok: boolean;
  status: number;
  text: string;
  json?: unknown;
  error?: string;
  aborted?: boolean;
}

export async function postJsonWithTimeout(args: HttpPostJsonArgs): Promise<HttpPostJsonResult> {
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? Math.floor(args.timeoutMs) : 10000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(args.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${args.apiKey}`,
        ...(args.headers || {}),
      },
      body: JSON.stringify(args.body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    let json: unknown = undefined;
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      text,
      json,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    const message = error instanceof Error ? error.message : String(error);
    const aborted = (error as { name?: string } | null)?.name === "AbortError" || /aborted/i.test(message);
    return {
      ok: false,
      status: 0,
      text: "",
      error: message,
      aborted,
    };
  }
}
