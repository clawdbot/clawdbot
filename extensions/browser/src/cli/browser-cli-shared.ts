import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  BROWSER_REQUEST_GATEWAY_METHOD,
  BROWSER_REQUEST_GATEWAY_SCOPES,
} from "../browser-gateway-contract.js";
import { callGatewayFromCli, type GatewayRpcOpts } from "./core-api.js";

export type BrowserParentOpts = GatewayRpcOpts & {
  json?: boolean;
  browserProfile?: string;
};

type BrowserRequestParams = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

function normalizeQuery(query: BrowserRequestParams["query"]): Record<string, string> | undefined {
  if (!query) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }
    out[key] = String(value);
  }
  return Object.keys(out).length ? out : undefined;
}

export async function callBrowserRequest<T>(
  opts: BrowserParentOpts,
  params: BrowserRequestParams,
  extra?: { timeoutMs?: number; progress?: boolean },
): Promise<T> {
  const resolvedTimeoutMs =
    typeof extra?.timeoutMs === "number" && Number.isFinite(extra.timeoutMs)
      ? Math.max(1, Math.floor(extra.timeoutMs))
      : typeof opts.timeout === "string"
        ? Number.parseInt(opts.timeout, 10)
        : undefined;
  const resolvedTimeout =
    typeof resolvedTimeoutMs === "number" && Number.isFinite(resolvedTimeoutMs)
      ? resolvedTimeoutMs
      : undefined;
  const timeout = typeof resolvedTimeout === "number" ? String(resolvedTimeout) : opts.timeout;
  const payload = await callGatewayFromCli(
    BROWSER_REQUEST_GATEWAY_METHOD,
    { ...opts, timeout },
    {
      method: params.method,
      path: params.path,
      query: normalizeQuery(params.query),
      body: params.body,
      timeoutMs: resolvedTimeout,
    },
    { progress: extra?.progress, scopes: [...BROWSER_REQUEST_GATEWAY_SCOPES] },
  );
  if (payload === undefined) {
    throw new Error("Unexpected browser.request response");
  }
  return payload as T;
}

export async function callBrowserResize(
  opts: BrowserParentOpts,
  params: { profile?: string; width: number; height: number; targetId?: string },
  extra?: { timeoutMs?: number },
): Promise<unknown> {
  return callBrowserRequest(
    opts,
    {
      method: "POST",
      path: "/act",
      query: params.profile ? { profile: params.profile } : undefined,
      body: {
        kind: "resize",
        width: params.width,
        height: params.height,
        targetId: normalizeOptionalString(params.targetId),
      },
    },
    extra,
  );
}
