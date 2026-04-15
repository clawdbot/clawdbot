import type { BrowserActRequest } from "../browser/client-actions-core.js";

export type BrowserClusterHealth = {
  ok: boolean;
  pool?: {
    maxInstances?: number;
    activeSessions?: number;
    availableSlots?: number;
  };
  nodeOptions?: string | null;
};

const DEFAULT_BROWSER_CLUSTER_URL = "http://127.0.0.1:3100";

function resolveBaseUrl(): string {
  return (process.env.BROWSER_CLUSTER_URL ?? DEFAULT_BROWSER_CLUSTER_URL).trim().replace(/\/$/, "");
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  return JSON.parse(text) as unknown;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${resolveBaseUrl()}${path}`, init);
  const payload = await parseJson(response);
  if (!response.ok) {
    const error =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : `browser-cluster request failed (${response.status})`;
    throw new Error(error);
  }
  return payload;
}

export async function browserClusterHealth(): Promise<BrowserClusterHealth> {
  return (await request("/browser/health")) as BrowserClusterHealth;
}

export function shouldUseBrowserCluster(): boolean {
  return (process.env.OPENCLAW_BROWSER_TRANSPORT ?? "internal").trim().toLowerCase() === "browser-cluster";
}

export function resolveBrowserClusterSessionId(profile?: string): string {
  const trimmed = profile?.trim();
  return trimmed && trimmed.length > 0 ? `profile:${trimmed}` : "profile:default";
}

export async function openBrowserClusterSession(params: { sessionId: string; url?: string }) {
  return (await request("/browser/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: params.sessionId, url: params.url }),
  })) as {
    ok: boolean;
    sessionId: string;
    proxy?: string;
    page?: { url: string; title: string };
  };
}

function selectorOnlyActionFromAct(body: Record<string, unknown>):
  | { action: "click"; params: Record<string, unknown> }
  | { action: "fill_form"; params: Record<string, unknown> }
  | { action: "screenshot"; params: Record<string, unknown> }
  | { action: "scrape_data"; params: Record<string, unknown> }
  | null {
  const request = body.request;
  if (!request || typeof request !== "object") {
    return null;
  }
  const act = request as BrowserActRequest;
  switch (act.kind) {
    case "click":
      if (!act.selector) {
        return null;
      }
      return { action: "click", params: { selector: act.selector } };
    case "type":
      if (!act.selector) {
        return null;
      }
      return {
        action: "fill_form",
        params: { fields: [{ selector: act.selector, value: act.text }] },
      };
    case "fill": {
      const fields = act.fields
        .map((field) => {
          const selector = typeof (field as { selector?: unknown }).selector === "string"
            ? ((field as { selector?: string }).selector ?? "").trim()
            : "";
          if (!selector) {
            return null;
          }
          const value = (field as { value?: unknown }).value;
          return { selector, value: value == null ? "" : String(value) };
        })
        .filter((value): value is { selector: string; value: string } => Boolean(value));
      if (fields.length === 0) {
        return null;
      }
      return { action: "fill_form", params: { fields } };
    }
    default:
      return null;
  }
}

export function canProxyBrowserClusterPath(path: string, method: string, body: unknown): boolean {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "POST" && path === "/tabs/open") {
    return true;
  }
  if (normalizedMethod === "POST" && path === "/screenshot") {
    return true;
  }
  if (normalizedMethod === "POST" && path === "/act") {
    return Boolean(body && typeof body === "object" && selectorOnlyActionFromAct(body as Record<string, unknown>));
  }
  return false;
}

export async function proxyBrowserCluster(params: {
  method: string;
  path: string;
  body?: unknown;
  profile?: string;
}): Promise<unknown> {
  const sessionId = resolveBrowserClusterSessionId(params.profile);

  if (params.method.toUpperCase() === "POST" && params.path === "/tabs/open") {
    const body = params.body && typeof params.body === "object" ? (params.body as Record<string, unknown>) : {};
    const url = typeof body.url === "string" ? body.url : undefined;
    const opened = await openBrowserClusterSession({ sessionId, url });
    return {
      targetId: opened.sessionId,
      title: opened.page?.title ?? "",
      url: opened.page?.url ?? url ?? "about:blank",
      type: "page",
    };
  }

  await openBrowserClusterSession({ sessionId });

  if (params.method.toUpperCase() === "POST" && params.path === "/screenshot") {
    const result = (await request("/browser/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, action: "screenshot", params: {} }),
    })) as { ok: boolean; result: { mimeType: string; data: string } };
    return { ok: true, mimeType: result.result.mimeType, data: result.result.data };
  }

  if (params.method.toUpperCase() === "POST" && params.path === "/act") {
    const translated = selectorOnlyActionFromAct((params.body ?? {}) as Record<string, unknown>);
    if (!translated) {
      throw new Error("browser-cluster cannot proxy this browser action yet");
    }
    const result = await request("/browser/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, action: translated.action, params: translated.params }),
    });
    return { ok: true, targetId: sessionId, result };
  }

  throw new Error(`Unsupported browser-cluster proxy path: ${params.method} ${params.path}`);
}
