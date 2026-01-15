import { extractErrorCode, formatErrorMessage } from "../infra/errors.js";
import { loadConfig } from "../config/config.js";
import { resolveBrowserConfig } from "./config.js";

let cachedConfigToken: string | null | undefined = undefined;

function getBrowserControlToken(): string | null {
  const env = process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN?.trim();
  if (env) return env;

  if (cachedConfigToken !== undefined) return cachedConfigToken;
  try {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser);
    const token = resolved.controlToken?.trim() || "";
    cachedConfigToken = token ? token : null;
  } catch {
    cachedConfigToken = null;
  }
  return cachedConfigToken;
}

function unwrapCause(err: unknown): unknown {
  if (!err || typeof err !== "object") return null;
  const cause = (err as { cause?: unknown }).cause;
  return cause ?? null;
}

function enhanceBrowserFetchError(url: string, err: unknown, timeoutMs: number): Error {
  const cause = unwrapCause(err);
  const code = extractErrorCode(cause) ?? extractErrorCode(err) ?? "";

  const hint =
    "Start (or restart) the Clawdbot gateway (Clawdbot.app menubar, or `clawdbot gateway`) and try again.";

  if (code === "ECONNREFUSED") {
    return new Error(
      `Can't reach the clawd browser control server at ${url} (connection refused). ${hint}`,
    );
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return new Error(
      `Can't reach the clawd browser control server at ${url} (timed out after ${timeoutMs}ms). ${hint}`,
    );
  }

  const msg = formatErrorMessage(err);
  if (msg.toLowerCase().includes("abort")) {
    return new Error(
      `Can't reach the clawd browser control server at ${url} (timed out after ${timeoutMs}ms). ${hint}`,
    );
  }

  return new Error(`Can't reach the clawd browser control server at ${url}. ${hint} (${msg})`);
}

export async function fetchBrowserJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? 5000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    const token = getBrowserControlToken();
    const mergedHeaders = (() => {
      if (!token) return init?.headers;
      const h = new Headers(init?.headers ?? {});
      if (!h.has("Authorization")) {
        h.set("Authorization", `Bearer ${token}`);
      }
      return h;
    })();
    res = await fetch(url, {
      ...init,
      ...(mergedHeaders ? { headers: mergedHeaders } : {}),
      signal: ctrl.signal,
    } as RequestInit);
  } catch (err) {
    throw enhanceBrowserFetchError(url, err, timeoutMs);
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text ? `${res.status}: ${text}` : `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}
