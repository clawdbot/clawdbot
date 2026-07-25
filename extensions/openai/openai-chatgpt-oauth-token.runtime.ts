import {
  resolveOAuthTokenExpiresAt,
  resolveOAuthTokenLifetimeMs,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { throwIfOAuthLoginAborted } from "./openai-chatgpt-oauth-abort.runtime.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const OAUTH_TOKEN_SSRF_POLICY = {
  allowRfc2544BenchmarkRange: true,
  allowIpv6UniqueLocalRange: true,
  hostnameAllowlist: ["auth.openai.com"],
} satisfies SsrFPolicy;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const OAUTH_TOKEN_RESPONSE_BODY_LIMIT_BYTES = 1 * 1024 * 1024;

type TokenSuccess = { type: "success"; access: string; refresh: string; expires: number };
type TokenFailure = { type: "failed"; message: string; status?: number };
type TokenResult = TokenSuccess | TokenFailure;
type TokenResponseJson = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};
type TokenRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

function formatMissingTokenResponseFields(json: TokenResponseJson): string {
  const missing: string[] = [];
  if (!json.access_token) {
    missing.push("access_token");
  }
  if (!json.refresh_token) {
    missing.push("refresh_token");
  }
  if (resolveOAuthTokenLifetimeMs(json.expires_in) === undefined) {
    missing.push("expires_in");
  }
  return missing.join(", ");
}

function formatTokenRequestError(
  operation: "exchange" | "refresh",
  error: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): string {
  if (signal?.aborted) {
    return "Login cancelled";
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return `OpenAI Codex token ${operation} timed out after ${timeoutMs}ms`;
  }
  return `OpenAI Codex token ${operation} error: ${error instanceof Error ? error.message : String(error)}`;
}

async function postTokenForm(
  body: URLSearchParams,
  options: TokenRequestOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS;
  throwIfOAuthLoginAborted(options.signal);
  const { response, release } = await fetchWithSsrFGuard({
    url: TOKEN_URL,
    // Fake-IP proxies map public hosts into these ranges. The exact-host allowlist
    // keeps redirects and every other hostname fail-closed.
    policy: OAUTH_TOKEN_SSRF_POLICY,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
    timeoutMs,
    signal: options.signal,
    auditContext: "openai-chatgpt-oauth-token",
  });
  try {
    const responseBody = await readResponseWithLimit(
      response,
      OAUTH_TOKEN_RESPONSE_BODY_LIMIT_BYTES,
      {
        onOverflow: ({ size, maxBytes }) =>
          new Error(
            `OpenAI Codex OAuth token response body too large: ${size} bytes (limit: ${maxBytes} bytes)`,
          ),
      },
    );
    return new Response(new Uint8Array(responseBody), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await release();
  }
}

export async function exchangeOpenAIAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string,
  options: TokenRequestOptions = {},
): Promise<TokenResult> {
  const timeoutMs = options.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS;
  let response: Response;
  try {
    response = await postTokenForm(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
      { signal: options.signal, timeoutMs },
    );
  } catch (error) {
    return {
      type: "failed",
      message: formatTokenRequestError("exchange", error, timeoutMs, options.signal),
    };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      type: "failed",
      status: response.status,
      message: `OpenAI Codex token exchange failed (${response.status}): ${text || response.statusText}`,
    };
  }
  const json = (await response.json()) as TokenResponseJson;
  const expires = resolveOAuthTokenExpiresAt(json.expires_in);
  if (!json.access_token || !json.refresh_token || expires === undefined) {
    return {
      type: "failed",
      message: `OpenAI Codex token exchange response missing fields: ${formatMissingTokenResponseFields(json)}`,
    };
  }
  return {
    type: "success",
    access: json.access_token,
    refresh: json.refresh_token,
    expires,
  };
}

export async function refreshOpenAIAccessToken(
  refreshToken: string,
  options: TokenRequestOptions = {},
): Promise<TokenResult> {
  try {
    const timeoutMs = options.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS;
    const response = await postTokenForm(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
      { signal: options.signal, timeoutMs },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        type: "failed",
        status: response.status,
        message: `OpenAI Codex token refresh failed (${response.status}): ${text || response.statusText}`,
      };
    }
    const json = (await response.json()) as TokenResponseJson;
    const expires = resolveOAuthTokenExpiresAt(json.expires_in);
    if (!json.access_token || !json.refresh_token || expires === undefined) {
      return {
        type: "failed",
        message: `OpenAI Codex token refresh response missing fields: ${formatMissingTokenResponseFields(json)}`,
      };
    }
    return {
      type: "success",
      access: json.access_token,
      refresh: json.refresh_token,
      expires,
    };
  } catch (error) {
    return {
      type: "failed",
      message: formatTokenRequestError(
        "refresh",
        error,
        options.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS,
        options.signal,
      ),
    };
  }
}
