/**
 * OpenAI Codex (ChatGPT OAuth) flow
 *
 * NOTE: This module uses Node.js crypto and http for the OAuth callback.
 * It is only intended for CLI use, not browser environments.
 */

import {
  parseOAuthAuthorizationInput,
  resolveOAuthTokenExpiresAt,
  resolveOAuthTokenLifetimeMs,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveCodexAuthIdentity } from "./openai-chatgpt-auth-identity.js";
import {
  createOAuthLoginCancelledError,
  throwIfOAuthLoginAborted,
  withOAuthLoginAbort,
} from "./openai-chatgpt-oauth-abort.runtime.js";
import { oauthErrorHtml, oauthSuccessHtml } from "./openai-chatgpt-oauth-page.runtime.js";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthPrompt,
  OAuthProviderInterface,
} from "./openai-chatgpt-oauth-types.runtime.js";
import { generatePKCE } from "./openai-chatgpt-pkce.runtime.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const DEFAULT_CALLBACK_HOST = "localhost";
const LOOPBACK_CALLBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const CALLBACK_HOST = resolveCallbackHost();
const REDIRECT_URI = resolveRedirectUri(CALLBACK_HOST);
const MANUAL_PROMPT_FALLBACK_MS = 15_000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const SCOPE = "openid profile email offline_access";

type TokenSuccess = { type: "success"; access: string; refresh: string; expires: number };
type TokenFailure = { type: "failed"; message: string; status?: number };
type TokenResult = TokenSuccess | TokenFailure;
type TokenResponseJson = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};
type NodeOAuthRuntime = {
  randomBytes: typeof import("node:crypto").randomBytes;
  http: typeof import("node:http");
};
type TokenRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

let nodeOAuthRuntimePromise: Promise<NodeOAuthRuntime> | null = null;

function loadNodeOAuthRuntime(): Promise<NodeOAuthRuntime> {
  if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
    return Promise.reject(
      new Error("OpenAI Codex OAuth is only available in Node.js environments"),
    );
  }
  nodeOAuthRuntimePromise ??= Promise.all([import("node:crypto"), import("node:http")]).then(
    ([cryptoModule, httpModule]) => ({
      randomBytes: cryptoModule.randomBytes,
      http: httpModule,
    }),
  );
  return nodeOAuthRuntimePromise;
}

function resolveCallbackHost(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.OPENCLAW_OAUTH_CALLBACK_HOST?.trim() || DEFAULT_CALLBACK_HOST;
  if (!LOOPBACK_CALLBACK_HOSTS.has(host)) {
    throw new Error("OpenAI Codex OAuth callback host must be localhost, 127.0.0.1, or ::1");
  }
  return host;
}

function resolveRedirectUri(host: string = CALLBACK_HOST): string {
  const hostForUrl = host === "::1" ? "[::1]" : host;
  const url = new URL(`http://${hostForUrl}:${CALLBACK_PORT}`);
  url.pathname = CALLBACK_PATH;
  return url.toString();
}

function createState(randomBytes: typeof import("node:crypto").randomBytes): string {
  return randomBytes(16).toString("hex");
}

function waitForManualPromptFallback(signal?: AbortSignal): Promise<null> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createOAuthLoginCancelledError());
      return;
    }

    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(createOAuthLoginCancelledError());
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, MANUAL_PROMPT_FALLBACK_MS);

    signal?.addEventListener("abort", abort, { once: true });
    timeout.unref?.();
  });
}

async function promptForAuthorizationCode(
  onPrompt: (prompt: OAuthPrompt) => Promise<string>,
  state: string,
): Promise<string | undefined> {
  const input = await onPrompt({
    message: "Paste the authorization code (or full redirect URL):",
  });
  const parsed = parseOAuthAuthorizationInput(input);
  if (parsed.state && parsed.state !== state) {
    throw new Error("State mismatch");
  }
  return parsed.code;
}

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
    const responseBody = await response.arrayBuffer();
    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await release();
  }
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string = REDIRECT_URI,
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

async function refreshAccessToken(
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

async function createAuthorizationFlow(
  originator = "openclaw",
): Promise<{ verifier: string; redirectUri: string; state: string; url: string }> {
  const [{ verifier, challenge }, runtime] = await Promise.all([
    generatePKCE(),
    loadNodeOAuthRuntime(),
  ]);
  const state = createState(runtime.randomBytes);

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  const redirectUri = REDIRECT_URI;
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", originator);

  return { verifier, redirectUri, state, url: url.toString() };
}

type OAuthServerInfo = {
  close: () => void;
  cancelWait: () => void;
  waitForCode: () => Promise<{ code: string } | null>;
};

async function startLocalOAuthServer(state: string): Promise<OAuthServerInfo> {
  const { http } = await loadNodeOAuthRuntime();
  let settleWait: ((value: { code: string } | null) => void) | undefined;
  const waitForCodePromise = new Promise<{ code: string } | null>((resolve) => {
    let settled = false;
    settleWait = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
  });

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(oauthErrorHtml("Callback route not found."));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(oauthErrorHtml("State mismatch."));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(oauthErrorHtml("Missing authorization code."));
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(oauthSuccessHtml("OpenAI authentication completed. You can close this window."));
      settleWait?.({ code });
    } catch {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(oauthErrorHtml("Internal error while processing OAuth callback."));
    }
  });

  return new Promise((resolve) => {
    server
      .listen(CALLBACK_PORT, CALLBACK_HOST, () => {
        resolve({
          close: () => server.close(),
          cancelWait: () => {
            settleWait?.(null);
          },
          waitForCode: () => waitForCodePromise,
        });
      })
      .on("error", () => {
        settleWait?.(null);
        resolve({
          close: () => {
            try {
              server.close();
            } catch {
              // ignore
            }
          },
          cancelWait: () => {},
          waitForCode: async () => null,
        });
      });
  });
}

function getAccountId(accessToken: string): string | null {
  const accountId = resolveCodexAuthIdentity({ accessToken }).accountId;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

/**
 * Login with OpenAI Codex OAuth
 *
 * @param options.onAuth - Called with URL and instructions when auth starts
 * @param options.onPrompt - Called to prompt user for manual code paste (fallback if no onManualCodeInput)
 * @param options.onProgress - Optional progress messages
 * @param options.onManualCodeInput - Optional promise that resolves with user-pasted code.
 *                                    Races with browser callback - whichever completes first wins.
 *                                    Useful for showing paste input immediately alongside browser flow.
 * @param options.originator - OAuth originator parameter (defaults to "openclaw")
 */
export async function loginOpenAICodex(options: {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  originator?: string;
  signal?: AbortSignal;
}): Promise<OAuthCredentials> {
  throwIfOAuthLoginAborted(options.signal);
  const { verifier, redirectUri, state, url } = await createAuthorizationFlow(options.originator);
  const server = await startLocalOAuthServer(state);

  let code: string | undefined;
  try {
    throwIfOAuthLoginAborted(options.signal);
    options.onAuth({
      url,
      instructions: "A browser window should open. Complete login to finish.",
    });
    throwIfOAuthLoginAborted(options.signal);

    if (options.onManualCodeInput) {
      // Race between browser callback and manual input
      let manualCode: string | undefined;
      let manualError: Error | undefined;
      const manualPromise = options
        .onManualCodeInput()
        .then((input) => {
          manualCode = input;
          server.cancelWait();
        })
        .catch((err: unknown) => {
          manualError = err instanceof Error ? err : new Error(String(err));
          server.cancelWait();
        });

      const result = await withOAuthLoginAbort(
        server.waitForCode(),
        options.signal,
        server.cancelWait,
      );

      // If manual input was cancelled, throw that error
      if (manualError) {
        throw manualError;
      }

      if (result?.code) {
        // Browser callback won
        code = result.code;
      } else if (manualCode) {
        // Manual input won (or callback timed out and user had entered code)
        const parsed = parseOAuthAuthorizationInput(manualCode);
        if (parsed.state && parsed.state !== state) {
          throw new Error("State mismatch");
        }
        code = parsed.code;
      }

      // If still no code, wait for manual promise to complete and try that
      if (!code) {
        await withOAuthLoginAbort(manualPromise, options.signal, server.cancelWait);
        if (manualError) {
          throw toLintErrorObject(manualError, "Non-Error thrown");
        }
        if (manualCode) {
          const parsed = parseOAuthAuthorizationInput(manualCode);
          if (parsed.state && parsed.state !== state) {
            throw new Error("State mismatch");
          }
          code = parsed.code;
        }
      }
    } else {
      const callbackPromise = server.waitForCode();
      const result = await withOAuthLoginAbort(
        Promise.race([callbackPromise, waitForManualPromptFallback(options.signal)]),
        options.signal,
        server.cancelWait,
      );
      if (result?.code) {
        code = result.code;
      } else {
        const promptCodePromise = promptForAuthorizationCode(options.onPrompt, state).then(
          (promptCode) => {
            server.cancelWait();
            return promptCode;
          },
        );
        code = await withOAuthLoginAbort(
          Promise.race([callbackPromise.then((callback) => callback?.code), promptCodePromise]),
          options.signal,
          server.cancelWait,
        );
      }
    }

    // Fallback to onPrompt if still no code
    if (!code) {
      code = await withOAuthLoginAbort(
        promptForAuthorizationCode(options.onPrompt, state),
        options.signal,
        server.cancelWait,
      );
    }

    if (!code) {
      throw new Error("Missing authorization code");
    }

    const tokenResult = await exchangeAuthorizationCode(code, verifier, redirectUri, {
      signal: options.signal,
    });
    if (tokenResult.type !== "success") {
      throw new Error(tokenResult.message);
    }

    const accountId = getAccountId(tokenResult.access);
    if (!accountId) {
      throw new Error("Failed to extract accountId from token");
    }

    return {
      access: tokenResult.access,
      refresh: tokenResult.refresh,
      expires: tokenResult.expires,
      accountId,
    };
  } finally {
    server.close();
  }
}

/**
 * Refresh OpenAI Codex OAuth token
 */
export async function refreshOpenAICodexToken(refreshToken: string): Promise<OAuthCredentials> {
  const result = await refreshAccessToken(refreshToken);
  if (result.type !== "success") {
    throw new Error(result.message);
  }

  const accountId = getAccountId(result.access);
  if (!accountId) {
    throw new Error("Failed to extract accountId from token");
  }

  return {
    access: result.access,
    refresh: result.refresh,
    expires: result.expires,
    accountId,
  };
}

export const openaiCodexOAuthProvider: OAuthProviderInterface = {
  id: "openai",
  name: "ChatGPT Plus/Pro (Codex Subscription)",
  usesCallbackServer: true,

  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    return loginOpenAICodex({
      onAuth: callbacks.onAuth,
      onPrompt: callbacks.onPrompt,
      onProgress: callbacks.onProgress,
      onManualCodeInput: callbacks.onManualCodeInput,
      signal: callbacks.signal,
    });
  },

  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    return refreshOpenAICodexToken(credentials.refresh);
  },

  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access;
  },
};

export const testing = {
  callbackHost: CALLBACK_HOST,
  createAuthorizationFlow,
  exchangeAuthorizationCode,
  loginOpenAICodex,
  refreshAccessToken,
  resolveCallbackHost,
  resolveRedirectUri,
};

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
