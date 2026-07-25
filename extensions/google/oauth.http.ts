// Google plugin module implements oauth.http behavior.
import {
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "openclaw/plugin-sdk/fetch-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { DEFAULT_FETCH_TIMEOUT_MS } from "./oauth.shared.js";

const GOOGLE_OAUTH_BODY_MAX_BYTES = 16 * 1024 * 1024;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  // The guard composes its timeout with this top-level signal. Passing only
  // init.signal would be overwritten when timeoutMs creates the effective signal.
  const guardedOptions = { url, init, timeoutMs, signal: init.signal ?? undefined };
  const { response, release } = await fetchWithSsrFGuard(
    shouldUseEnvHttpProxyForUrl(url)
      ? withTrustedEnvProxyGuardedFetchMode(guardedOptions)
      : guardedOptions,
  );
  try {
    // 16 MiB cap. A hostile or broken Google OAuth endpoint (or any
    // accounts.google.com mirror / enterprise proxy) cannot force the
    // runtime to buffer an unbounded body before the caller sees it.
    // Complements #97587, which caps at the call site — this is the
    // shared entry-point cap.
    const body = await readResponseWithLimit(response, GOOGLE_OAUTH_BODY_MAX_BYTES, {
      onOverflow: ({ size, maxBytes }) =>
        new Error(`google HTTP fetch: body exceeds ${maxBytes} bytes (got ${size})`),
    });
    // `readResponseWithLimit` returns a `Buffer` (Node Uint8Array view). The
    // global `Response` constructor accepts `BufferSource` (Uint8Array /
    // ArrayBuffer) as a body; cast through `BodyInit` because `Buffer.buffer`
    // is typed as `ArrayBufferLike` (could be `ArrayBuffer` or
    // `SharedArrayBuffer`), but the helper always returns a regular `Buffer`
    // backed by an `ArrayBuffer` with no shared-memory paths. The same
    // wrap-shape is used by the googlechat google-auth helper at
    // extensions/googlechat/src/google-auth.runtime.ts:454.
    const bodyBytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return new Response(bodyBytes as unknown as BodyInit, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await release();
  }
}
