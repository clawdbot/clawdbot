// Gateway auth rate-limit serialization.
// Serializes limiter attempts per IP/scope so concurrent failures count correctly.
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import {
  AUTH_RATE_LIMIT_SCOPE_DEFAULT,
  isAuthRateLimitClientExempt,
  normalizeRateLimitClientIp,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";

const pendingAttempts = new KeyedAsyncQueue();

/** Shared queue scope for auth attempts that evaluate shared and device credentials together. */
const AUTH_CREDENTIAL_FALLBACK_SERIALIZATION_SCOPE = "credential-fallback";

function normalizeScope(scope: string | undefined): string {
  return (scope ?? AUTH_RATE_LIMIT_SCOPE_DEFAULT).trim() || AUTH_RATE_LIMIT_SCOPE_DEFAULT;
}

function buildSerializationKey(ip: string | undefined, scope: string | undefined): string {
  return `${normalizeScope(scope)}:${normalizeRateLimitClientIp(ip)}`;
}

/** Runs one rate-limit attempt after prior attempts for the same IP/scope finish. */
export async function withSerializedRateLimitAttempt<T>(params: {
  ip: string | undefined;
  scope: string | undefined;
  run: () => Promise<T>;
}): Promise<T> {
  return await pendingAttempts.enqueue(buildSerializationKey(params.ip, params.scope), params.run);
}

/** Serialize terminal credential fallbacks unless this limiter exempts the identity. */
export async function withSerializedCredentialFallbackAttempt<T>(params: {
  limiter: AuthRateLimiter;
  ip: string | undefined;
  run: () => Promise<T>;
}): Promise<T> {
  if (isAuthRateLimitClientExempt(params.limiter, params.ip)) {
    return await params.run();
  }
  return await withSerializedRateLimitAttempt({
    ip: params.ip,
    scope: AUTH_CREDENTIAL_FALLBACK_SERIALIZATION_SCOPE,
    run: params.run,
  });
}
