/**
 * Shared Browser CLI option parsing and gateway request helpers.
 */
import {
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  BROWSER_REQUEST_GATEWAY_METHOD,
  BROWSER_REQUEST_GATEWAY_SCOPES,
} from "../browser-gateway-contract.js";
import { normalizeBrowserTimerDelayMs } from "../browser/timer-delay.js";
import { callGatewayFromCli, type GatewayRpcOpts } from "./core-api.js";

/** Parent Browser CLI options inherited by subcommands. */
export type BrowserParentOpts = GatewayRpcOpts & {
  json?: boolean;
  browserProfile?: string;
};

/** Help text for user-facing tab references accepted by Browser CLI commands. */
export const BROWSER_TAB_REFERENCE_HELP =
  "Tab reference: suggested target id, tab id, label, raw target id, or unique raw prefix";

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

/** Parses a positive integer value for Browser CLI options. */
export function parseBrowserPositiveIntegerValue(value: unknown): number | undefined {
  return parseStrictPositiveInteger(value);
}

/** Parses a non-negative integer value for Browser CLI options. */
export function parseBrowserNonNegativeIntegerValue(value: unknown): number | undefined {
  return parseStrictNonNegativeInteger(value);
}

/** Parses and validates a required positive integer CLI option. */
export function parseBrowserPositiveIntegerOption(raw: string, flag: string): number {
  const parsed = parseBrowserPositiveIntegerValue(raw);
  if (parsed === undefined) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

/** Parses and validates a required non-negative integer CLI option. */
export function parseBrowserNonNegativeIntegerOption(raw: string, flag: string): number {
  const parsed = parseBrowserNonNegativeIntegerValue(raw);
  if (parsed === undefined) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

/** Calls the Browser gateway request method with normalized timeout/query options. */
export async function callBrowserRequest<T>(
  opts: BrowserParentOpts,
  params: BrowserRequestParams,
  extra?: { timeoutMs?: number; progress?: boolean },
): Promise<T> {
  const resolvedTimeoutMs =
    typeof extra?.timeoutMs === "number" && Number.isFinite(extra.timeoutMs)
      ? normalizeBrowserTimerDelayMs(extra.timeoutMs)
      : typeof opts.timeout === "string"
        ? normalizeBrowserTimerDelayMs(parseBrowserPositiveIntegerOption(opts.timeout, "--timeout"))
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

/** Sends a Browser resize action through the shared request helper. */
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
