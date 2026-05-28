/**
 * Anthropic OAuth flow (Claude Pro/Max)
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

import type { Server } from "node:http";
import {
  buildOAuthRequestSignal,
  createOAuthLoginCancelledError,
  throwIfOAuthLoginAborted,
  withOAuthLoginAbort,
} from "./abort.js";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.js";
import { generateOAuthState, generatePKCE } from "./pkce.js";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthPrompt,
  OAuthProviderInterface,
} from "./types.js";

type CallbackServerInfo = {
  server: Server;
  redirectUri: string;
  cancelWait: () => void;
  waitForCode: () => Promise<{ code: string; state: string } | null>;
};

type NodeApis = {
  createServer: typeof import("node:http").createServer;
};

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_HOST = process.env.OPENCLAW_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
async function getNodeApis(): Promise<NodeApis> {
  if (nodeApis) {
    return nodeApis;
  }
  if (!nodeApisPromise) {
    if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
      throw new Error("Anthropic OAuth is only available in Node.js environments");
    }
    nodeApisPromise = import("node:http").then((httpModule) => ({
      createServer: httpModule.createServer,
    }));
  }
  nodeApis = await nodeApisPromise;
  return nodeApis;
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) {
    return {};
  }

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // not a URL
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
}

function formatErrorDetails(error: unknown): string {
  if (error instanceof Error) {
    const details: string[] = [`${error.name}: ${error.message}`];
    const errorWithCode = error as Error & {
      code?: string;
      errno?: number | string;
      cause?: unknown;
    };
    if (errorWithCode.code) {
      details.push(`code=${errorWithCode.code}`);
    }
    if (errorWithCode.errno !== undefined) {
      details.push(`errno=${String(errorWithCode.errno)}`);
    }
    if (error.cause !== undefined) {
      details.push(`cause=${formatErrorDetails(error.cause)}`);
    }
    if (error.stack) {
      details.push(`stack=${error.stack}`);
    }
    return details.join("; ");
  }
  return String(error);
}

function formatTokenResponseParseContext(responseBody: string): string {
  return `bodyBytes=${Buffer.byteLength(responseBody, "utf8")}`;
}

async function startCallbackServer(expectedState: string): Promise<CallbackServerInfo> {
  const { createServer } = await getNodeApis();

  return new Promise((resolve, reject) => {
    let settleWait: ((value: { code: string; state: string } | null) => void) | undefined;
    const waitForCodePromise = new Promise<{ code: string; state: string } | null>(
      (resolveWait) => {
        let settled = false;
        settleWait = (value) => {
          if (settled) {
            return;
          }
          settled = true;
          resolveWait(value);
        };
      },
    );

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || "", "http://localhost");
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthErrorHtml("Callback route not found."));
          return;
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthErrorHtml("Anthropic authentication did not complete.", `Error: ${error}`));
          return;
        }

        if (!code || !state) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthErrorHtml("Missing code or state parameter."));
          return;
        }

        if (state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthErrorHtml("State mismatch."));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(oauthSuccessHtml("Anthropic authentication completed. You can close this window."));
        settleWait?.({ code, state });
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal error");
      }
    });

    server.on("error", (err) => {
      reject(err);
    });

    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      resolve({
        server,
        redirectUri: REDIRECT_URI,
        cancelWait: () => {
          settleWait?.(null);
        },
        waitForCode: () => waitForCodePromise,
      });
    });
  });
}

async function postJson(
  url: string,
  body: Record<string, string | number>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  throwIfOAuthLoginAborted(options.signal);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: buildOAuthRequestSignal({ signal: options.signal, timeoutMs }),
  });

  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`,
    );
  }

  return responseBody;
}

async function exchangeAuthorizationCode(
  code: string,
  state: string,
  verifier: string,
  redirectUri: string,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  let responseBody: string;
  try {
    responseBody = await postJson(
      TOKEN_URL,
      {
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        state,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      { signal },
    );
  } catch (error) {
    if (signal?.aborted) {
      throw createOAuthLoginCancelledError();
    }
    throw new Error(
      `Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
      { cause: error },
    );
  }

  let tokenData: { access_token: string; refresh_token: string; expires_in: number };
  try {
    tokenData = JSON.parse(responseBody) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
  } catch (error) {
    throw new Error(
      `Token exchange returned invalid JSON. url=${TOKEN_URL}; ${formatTokenResponseParseContext(responseBody)}; details=${formatErrorDetails(error)}`,
      { cause: error },
    );
  }

  return {
    refresh: tokenData.refresh_token,
    access: tokenData.access_token,
    expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
  };
}

/**
 * Login with Anthropic OAuth (authorization code + PKCE)
 */
export async function loginAnthropic(options: {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  signal?: AbortSignal;
}): Promise<OAuthCredentials> {
  throwIfOAuthLoginAborted(options.signal);
  const { verifier, challenge } = await generatePKCE();
  const expectedState = generateOAuthState();
  const server = await startCallbackServer(expectedState);

  let code: string | undefined;
  let state: string | undefined;
  let redirectUriForExchange = REDIRECT_URI;

  try {
    throwIfOAuthLoginAborted(options.signal);
    const authParams = new URLSearchParams({
      code: "true",
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: expectedState,
    });

    options.onAuth({
      url: `${AUTHORIZE_URL}?${authParams.toString()}`,
      instructions:
        "Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
    });
    throwIfOAuthLoginAborted(options.signal);

    if (options.onManualCodeInput) {
      let manualInput: string | undefined;
      let manualError: Error | undefined;
      const manualPromise = options
        .onManualCodeInput()
        .then((input) => {
          manualInput = input;
          server.cancelWait();
        })
        .catch((err) => {
          manualError = err instanceof Error ? err : new Error(String(err));
          server.cancelWait();
        });

      const result = await withOAuthLoginAbort(
        server.waitForCode(),
        options.signal,
        server.cancelWait,
      );

      if (manualError) {
        throw manualError;
      }

      if (result?.code) {
        code = result.code;
        state = result.state;
        redirectUriForExchange = REDIRECT_URI;
      } else if (manualInput) {
        const parsed = parseAuthorizationInput(manualInput);
        if (parsed.state && parsed.state !== expectedState) {
          throw new Error("OAuth state mismatch");
        }
        code = parsed.code;
        state = parsed.state ?? expectedState;
      }

      if (!code) {
        await withOAuthLoginAbort(manualPromise, options.signal, server.cancelWait);
        if (manualError) {
          throw manualError;
        }
        if (manualInput) {
          const parsed = parseAuthorizationInput(manualInput);
          if (parsed.state && parsed.state !== expectedState) {
            throw new Error("OAuth state mismatch");
          }
          code = parsed.code;
          state = parsed.state ?? expectedState;
        }
      }
    } else {
      const result = await withOAuthLoginAbort(
        server.waitForCode(),
        options.signal,
        server.cancelWait,
      );
      if (result?.code) {
        code = result.code;
        state = result.state;
        redirectUriForExchange = REDIRECT_URI;
      }
    }

    if (!code) {
      const input = await withOAuthLoginAbort(
        options.onPrompt({
          message: "Paste the authorization code or full redirect URL:",
          placeholder: REDIRECT_URI,
        }),
        options.signal,
        server.cancelWait,
      );
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== expectedState) {
        throw new Error("OAuth state mismatch");
      }
      code = parsed.code;
      state = parsed.state ?? expectedState;
    }

    if (!code) {
      throw new Error("Missing authorization code");
    }

    if (!state) {
      throw new Error("Missing OAuth state");
    }

    options.onProgress?.("Exchanging authorization code for tokens...");
    return exchangeAuthorizationCode(code, state, verifier, redirectUriForExchange, options.signal);
  } finally {
    server.server.close();
  }
}

/**
 * Refresh Anthropic OAuth token
 */
export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials> {
  let responseBody: string;
  try {
    responseBody = await postJson(TOKEN_URL, {
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    });
  } catch (error) {
    throw new Error(
      `Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`,
      { cause: error },
    );
  }

  let data: { access_token: string; refresh_token: string; expires_in: number; scope?: string };
  try {
    data = JSON.parse(responseBody) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope?: string;
    };
  } catch (error) {
    throw new Error(
      `Anthropic token refresh returned invalid JSON. url=${TOKEN_URL}; ${formatTokenResponseParseContext(responseBody)}; details=${formatErrorDetails(error)}`,
      { cause: error },
    );
  }

  return {
    refresh: data.refresh_token,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

export const anthropicOAuthProvider: OAuthProviderInterface = {
  id: "anthropic",
  name: "Anthropic (Claude Pro/Max)",
  usesCallbackServer: true,

  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    return loginAnthropic({
      onAuth: callbacks.onAuth,
      onPrompt: callbacks.onPrompt,
      onProgress: callbacks.onProgress,
      onManualCodeInput: callbacks.onManualCodeInput,
      signal: callbacks.signal,
    });
  },

  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    return refreshAnthropicToken(credentials.refresh);
  },

  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access;
  },
};
