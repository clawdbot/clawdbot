// Memory Host SDK module implements post json behavior.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
// Release harnesses execute source before workspace package dist files exist.
import { parseRetryAfterHeaderSeconds } from "../../../../src/infra/retry-after.js";
import { formatErrorMessage } from "./error-utils.js";
import type { SsrFPolicy } from "./openclaw-runtime-network.js";
import { withRemoteHttpResponse } from "./remote-http.js";
import {
  readMemoryHostResponseTextSnippet,
  readResponseJsonWithLimit,
} from "./response-snippet.js";

// Shared JSON POST helper for guarded remote memory provider calls.

/** Structured facts attached to non-ok remote provider errors. */
export type RemoteProviderErrorFacts = {
  status?: number;
  code?: string;
  errorType?: string;
  retryAfterMs?: number;
};

// OpenAI's documented billing/quota rejections: `error.type` stays the broad
// "insufficient_quota" while `error.code` names the specific cause
// (https://developers.openai.com/api/docs/guides/error-codes). None of these
// can succeed on retry until an operator restores billing or raises limits.
const PROVIDER_QUOTA_EXHAUSTED_CODES: ReadonlySet<string> = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
]);

// Provider error codes are short machine tokens; anything else is prose we
// must not carry into lifecycle state or diagnostics as a "code".
const PROVIDER_ERROR_CODE_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

function asProviderErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && PROVIDER_ERROR_CODE_RE.test(value) ? value : undefined;
}

/** Extract machine error code/type from an OpenAI-compatible error body snippet. */
function readProviderErrorBodyFacts(bodyText: string): { code?: string; errorType?: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return {};
  }
  const root = asOptionalRecord(payload);
  const subject = asOptionalRecord(root?.error) ?? root;
  const code = asProviderErrorCode(subject?.code);
  const errorType = asProviderErrorCode(subject?.type);
  return {
    ...(code !== undefined ? { code } : {}),
    ...(errorType !== undefined ? { errorType } : {}),
  };
}

/** Read structured provider facts from an error or any error in its cause chain. */
export function readRemoteProviderErrorFacts(err: unknown): RemoteProviderErrorFacts {
  // Wrappers (retry failures, memory operation errors) keep the transport
  // error in the cause chain; the first level with a numeric status owns all
  // facts so unrelated wrapper `code` fields cannot mix in.
  let current = asOptionalRecord(err);
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current.status === "number" && Number.isFinite(current.status)) {
      const code = typeof current.code === "string" && current.code ? current.code : undefined;
      const errorType =
        typeof current.errorType === "string" && current.errorType ? current.errorType : undefined;
      const retryAfterMs =
        typeof current.retryAfterMs === "number" && Number.isFinite(current.retryAfterMs)
          ? current.retryAfterMs
          : undefined;
      return {
        status: current.status,
        ...(code !== undefined ? { code } : {}),
        ...(errorType !== undefined ? { errorType } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    }
    current = asOptionalRecord(current.cause);
  }
  return {};
}

/** Whether an error reports exhausted provider quota, which no retry can fix. */
export function isRemoteProviderQuotaError(err: unknown): boolean {
  const facts = readRemoteProviderErrorFacts(err);
  return (
    (facts.code !== undefined && PROVIDER_QUOTA_EXHAUSTED_CODES.has(facts.code)) ||
    (facts.errorType !== undefined && PROVIDER_QUOTA_EXHAUSTED_CODES.has(facts.errorType))
  );
}

/** POST JSON, parse bounded response JSON, and attach provider facts on failure. */
export async function postJson<T>(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  body: unknown;
  errorPrefix: string;
  maxResponseBytes?: number;
  parse: (payload: unknown) => T | Promise<T>;
}): Promise<T> {
  return await withRemoteHttpResponse({
    url: params.url,
    ssrfPolicy: params.ssrfPolicy,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
    init: {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify(params.body),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        const text = await readMemoryHostResponseTextSnippet(res, { signal: params.signal });
        // Structured facts let retry and degradation policy classify the
        // failure without parsing redacted human-facing message text.
        const err: Error & RemoteProviderErrorFacts = Object.assign(
          new Error(`${params.errorPrefix}: ${res.status} ${formatErrorMessage(text)}`),
          { status: res.status },
        );
        Object.assign(err, readProviderErrorBodyFacts(text));
        const retryAfterSeconds = parseRetryAfterHeaderSeconds(res.headers.get("retry-after"));
        if (retryAfterSeconds !== undefined) {
          err.retryAfterMs = Math.round(retryAfterSeconds * 1000);
        }
        throw err;
      }
      const payload = await readResponseJsonWithLimit(res, {
        errorPrefix: params.errorPrefix,
        maxBytes: params.maxResponseBytes,
        signal: params.signal,
      });
      return await params.parse(payload);
    },
  });
}
