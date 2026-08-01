// Qa Lab Matrix module implements request behavior.
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";

export type MatrixQaFetchLike = typeof fetch;

// Cap how much of a Matrix homeserver response we buffer so a hostile or
// misbehaving server cannot drive this process OOM with an unbounded body.
// Shared across the QA substrate (also reused for media-upload reads in client.ts).
export const MATRIX_QA_JSON_MAX_BYTES = 16 * 1024 * 1024;

type MatrixQaRequestResult<T> = {
  status: number;
  body: T;
};

export async function requestMatrixJson<T>(params: {
  accessToken?: string;
  baseUrl: string;
  body?: unknown;
  endpoint: string;
  fetchImpl: MatrixQaFetchLike;
  method: "DELETE" | "GET" | "POST" | "PUT";
  okStatuses?: number[];
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
}): Promise<MatrixQaRequestResult<T>> {
  const url = new URL(params.endpoint, params.baseUrl);
  for (const [key, value] of Object.entries(params.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await params.fetchImpl(url, {
    method: params.method,
    headers: {
      accept: "application/json",
      ...(params.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(params.accessToken ? { authorization: `Bearer ${params.accessToken}` } : {}),
    },
    ...(params.body !== undefined ? { body: JSON.stringify(params.body) } : {}),
    signal: AbortSignal.timeout(resolveTimerTimeoutMs(params.timeoutMs, 20_000)),
  });
  // Read under a byte cap *before* the parse try/catch. The overflow error must
  // escape uncaught (fail-closed): swallowing it into `body = {}` would defeat
  // the bound and silently accept an oversized payload. Malformed but
  // in-bounds JSON still falls back to `{}` exactly as before.
  const bytes = await readResponseWithLimit(response, MATRIX_QA_JSON_MAX_BYTES, {
    onOverflow: ({ maxBytes }) => new Error(`Matrix homeserver response exceeds ${maxBytes} bytes`),
  });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    body = {};
  }
  const okStatuses = params.okStatuses ?? [200];
  if (!okStatuses.includes(response.status)) {
    const details =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `${params.method} ${params.endpoint} failed with status ${response.status}`;
    throw new Error(details);
  }
  return {
    status: response.status,
    body: body as T,
  };
}
