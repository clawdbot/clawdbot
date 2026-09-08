// Slack plugin module implements auth-error behavior.
import { ErrorCode as SlackErrorCode } from "@slack/web-api";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatSlackError } from "./errors.js";

/**
 * Slack error codes that indicate the configured token itself is invalid,
 * expired, or revoked (a configuration problem the workspace owner must fix
 * by regenerating the token) as opposed to a transient network/connectivity
 * problem or a scope/permissions gap.
 *
 * Slack's Web API returns HTTP 200 for these — the failure only shows up in
 * the JSON body (`{ "ok": false, "error": "not_authed" }`), and the
 * `@slack/web-api` SDK client re-throws that body as a `WebAPIPlatformError`.
 * Anything catching that error generically (by network/timeout handling
 * alone, or via the general-purpose `formatSlackError`) will misreport an
 * auth failure as connectivity trouble instead of a config problem.
 */
export const SLACK_AUTH_TOKEN_ERROR_CODES = [
  "not_authed",
  "invalid_auth",
  "token_revoked",
  "account_inactive",
] as const;

export type SlackAuthTokenErrorCode = (typeof SLACK_AUTH_TOKEN_ERROR_CODES)[number];

const SLACK_AUTH_TOKEN_ERROR_CODE_SET: ReadonlySet<string> = new Set(SLACK_AUTH_TOKEN_ERROR_CODES);

/**
 * Extracts Slack's `error` code from a failed API call, regardless of
 * whether it arrived as a thrown `WebAPIPlatformError` (the normal
 * `@slack/web-api` behavior for an `{ ok: false }` body), a raw `{ ok, error }`
 * result object, or a formatted error message (`"An API error occurred: <code>"`,
 * or `formatSlackError`'s `"slack error: <code>"` detail). Returns undefined
 * when the error doesn't look like a Slack API error at all (e.g. a timeout,
 * DNS failure, or other network-transport error).
 */
export function extractSlackErrorCode(error: unknown): string | undefined {
  if (isRecord(error)) {
    // Thrown WebAPIPlatformError (or WebAPIHTTPError body) shape.
    if (isRecord(error.data) && typeof error.data.error === "string" && error.data.error.trim()) {
      return error.data.error.trim();
    }
    // Raw Slack Web API result: { ok: false, error: "not_authed" }.
    if (error.ok === false && typeof error.error === "string" && error.error.trim()) {
      return error.error.trim();
    }
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const apiErrorMatch = /An API error occurred:\s*([a-z0-9_]+)/i.exec(message);
  if (apiErrorMatch?.[1]) {
    return apiErrorMatch[1].toLowerCase();
  }
  // formatSlackError() joins details as "...; slack error: <code>; ...".
  const detailMatch = /slack error:\s*([a-z0-9_]+)/i.exec(message);
  return detailMatch?.[1]?.toLowerCase();
}

/** True when `error` is a thrown `@slack/web-api` platform-level API error (an HTTP-200 body failure), not a transport/network error. */
export function isSlackPlatformError(error: unknown): boolean {
  if (isRecord(error) && error.code === SlackErrorCode.PlatformError) {
    return true;
  }
  return extractSlackErrorCode(error) !== undefined;
}

/** True when the Slack error code indicates the token itself is invalid/expired/revoked and must be regenerated — not a network or scope problem. */
export function isSlackAuthTokenErrorCode(
  code: string | undefined,
): code is SlackAuthTokenErrorCode {
  return Boolean(code && SLACK_AUTH_TOKEN_ERROR_CODE_SET.has(code.toLowerCase()));
}

/** Dedicated error type for "the Slack token is invalid/expired/revoked" — distinct from network/connectivity failures so callers can branch on it. Never carries the token itself. */
export class SlackAuthConfigError extends Error {
  readonly code: SlackAuthTokenErrorCode;

  constructor(code: SlackAuthTokenErrorCode, cause?: unknown) {
    super(formatSlackAuthErrorMessage(code));
    this.name = "SlackAuthConfigError";
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** Clear, actionable remediation message for a known Slack auth-token error code. Never includes the token value. */
export function formatSlackAuthErrorMessage(code: SlackAuthTokenErrorCode): string {
  return (
    `Slack authentication failed (${code}): the configured Slack token is invalid, expired, or revoked. ` +
    "This is a configuration problem, not a connectivity issue — retrying will not help. " +
    "Regenerate the token through the existing Slack OAuth/token setup flow and update it in your " +
    "configuration (SLACK_USER_TOKEN, or channels.slack.botToken/appToken), then restart the connection."
  );
}

/**
 * Maps a caught Slack API error to a {@link SlackAuthConfigError} when it is
 * one of the known token-invalid codes, so callers get a clear, actionable
 * error instead of a generic API failure. Returns undefined for anything
 * else (network errors, rate limits, scope errors, etc.) so those keep
 * their original, distinguishable error handling (e.g. `formatSlackError`).
 */
export function toSlackAuthConfigError(error: unknown): SlackAuthConfigError | undefined {
  const code = extractSlackErrorCode(error);
  if (isSlackAuthTokenErrorCode(code)) {
    return new SlackAuthConfigError(code, error);
  }
  return undefined;
}

/**
 * Formats an error for a probe/diagnostic result, upgrading a known
 * invalid-token code to the clear remediation message while leaving every
 * other error (network, rate limit, scope, etc.) on the existing
 * `formatSlackError` behavior.
 */
export function formatSlackErrorWithAuthRemediation(error: unknown): string {
  const code = extractSlackErrorCode(error);
  if (isSlackAuthTokenErrorCode(code)) {
    return formatSlackAuthErrorMessage(code);
  }
  return formatSlackError(error);
}

/**
 * Wraps a Slack WebClient (or any of its namespaced method groups, e.g.
 * `client.chat`) so that any rejected API call is re-thrown as a
 * {@link SlackAuthConfigError} when it's a known invalid-token error,
 * instead of the SDK's generic "An API error occurred: ..." message.
 * Network/timeout errors and non-auth API errors (rate limits, missing
 * scopes, etc.) pass through unchanged.
 *
 * Applied once at the boundary where Slack actions are invoked (see
 * `actions.ts`'s `getClient`) so every read/write/reaction/etc. call gets
 * consistent, actionable error messages regardless of which token
 * (bot or user) is in use.
 */
export function wrapSlackClientAuthErrors<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (result instanceof Promise) {
            return result.catch((err: unknown) => {
              throw toSlackAuthConfigError(err) ?? err;
            });
          }
          return result;
        };
      }
      if (value !== null && typeof value === "object") {
        return wrapSlackClientAuthErrors(value);
      }
      return value;
    },
  });
}
