// Gateway auth rate-limit serialization.
// Serializes limiter attempts per IP/scope so concurrent failures count correctly.
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { AUTH_RATE_LIMIT_SCOPE_DEFAULT, normalizeRateLimitClientIp } from "./auth-rate-limit.js";

const pendingAttempts = new KeyedAsyncQueue();

function normalizeScope(scope: string | undefined): string {
  return (scope ?? AUTH_RATE_LIMIT_SCOPE_DEFAULT).trim() || AUTH_RATE_LIMIT_SCOPE_DEFAULT;
}

function buildSerializationKey(ip: string | undefined, scope: string | undefined): string {
  return `${normalizeScope(scope)}:${normalizeRateLimitClientIp(ip)}`;
}

/** Runs one attempt after prior work for the same stable key finishes. */
export async function withSerializedKeyedAttempt<T>(params: {
  key: string;
  run: () => Promise<T>;
}): Promise<T> {
  return await pendingAttempts.enqueue(params.key, params.run);
}

/** Runs one rate-limit attempt after prior attempts for the same IP/scope finish. */
export async function withSerializedRateLimitAttempt<T>(params: {
  ip: string | undefined;
  scope: string | undefined;
  run: () => Promise<T>;
}): Promise<T> {
  return await withSerializedKeyedAttempt({
    key: buildSerializationKey(params.ip, params.scope),
    run: params.run,
  });
}
