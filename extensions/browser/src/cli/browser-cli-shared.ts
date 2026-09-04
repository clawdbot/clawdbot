/**
 * Shared Browser CLI option parsing and gateway request helpers.
 */
import {
  addTimerTimeoutGraceMs,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "openclaw/plugin-sdk/number-runtime";
import {
  BROWSER_REQUEST_GATEWAY_METHOD,
  BROWSER_REQUEST_GATEWAY_SCOPES,
} from "../browser-gateway-contract.js";
import { BROWSER_ACTION_TRANSPORT_SLACK_MS } from "../browser/act-policy.js";
import { normalizeBrowserTimerDelayMs } from "../browser/timer-delay.js";
import {
  callGatewayFromCli,
  danger,
  defaultRuntime,
  runCommandWithRuntime,
  type GatewayRpcOpts,
} from "./core-api.js";

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

/** Adds gateway slack to a Browser action timeout so route work can finish cleanly. */
export function withBrowserActionTimeoutSlack(timeoutMs: number | undefined): number {
  return addTimerTimeoutGraceMs(timeoutMs ?? 20_000, BROWSER_ACTION_TRANSPORT_SLACK_MS) ?? 1;
}

/** Runs a Browser CLI command with the standard runtime error handling. */
export function runBrowserCliCommand(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action, (error) => {
    defaultRuntime.error(danger(String(error)));
    defaultRuntime.exit(1);
  });
}

/** Writes a Browser command result when structured output was requested. */
export function printBrowserJsonResult(parent: BrowserParentOpts, payload: unknown): boolean {
  if (!parent?.json) {
    return false;
  }
  defaultRuntime.writeJson(payload);
  return true;
}

/** Combines the selected Browser profile with optional request query fields. */
export function resolveBrowserProfileQuery(
  profile?: string,
  extra?: BrowserRequestParams["query"],
): BrowserRequestParams["query"] {
  const query = { ...(profile ? { profile } : {}), ...extra };
  return Object.keys(query).length > 0 ? query : undefined;
}

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
  const resolvedTimeout =
    typeof extra?.timeoutMs === "number" && Number.isFinite(extra.timeoutMs)
      ? normalizeBrowserTimerDelayMs(extra.timeoutMs)
      : typeof opts.timeout === "string"
        ? normalizeBrowserTimerDelayMs(parseBrowserPositiveIntegerOption(opts.timeout, "--timeout"))
        : undefined;
  const timeout = resolvedTimeout === undefined ? opts.timeout : String(resolvedTimeout);
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
