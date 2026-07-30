// OpenRouter OAuth support exchanges PKCE browser login codes for API keys.
import { createServer } from "node:http";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ProviderAuthContext, ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildApiKeyCredential,
  generatePkceVerifierChallenge,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import { generateOAuthState } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  readProviderJsonResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { applyOpenrouterConfig, OPENROUTER_DEFAULT_MODEL_REF } from "./onboard.js";

const PROVIDER_ID = "openrouter";
const OPENROUTER_OAUTH_METHOD_ID = "oauth";
const OPENROUTER_OAUTH_CHOICE_ID = "openrouter-oauth";
const OPENROUTER_OAUTH_AUTHORIZE_URL = "https://openrouter.ai/auth";
const OPENROUTER_OAUTH_TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys";
const OPENROUTER_OAUTH_CALLBACK_HOST = "localhost";
const OPENROUTER_OAUTH_CALLBACK_PORT = 3000;
const OPENROUTER_OAUTH_CALLBACK_PATH = "/openrouter-oauth/callback";
const OPENROUTER_OAUTH_REDIRECT_URI = `http://${OPENROUTER_OAUTH_CALLBACK_HOST}:${OPENROUTER_OAUTH_CALLBACK_PORT}${OPENROUTER_OAUTH_CALLBACK_PATH}`;
const OPENROUTER_OAUTH_CODE_CHALLENGE_METHOD = "S256";

const OPENROUTER_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const OPENROUTER_OAUTH_FETCH_TIMEOUT_MS = 30 * 1000;
const OPENROUTER_OAUTH_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const OPENROUTER_OAUTH_PROFILE_ID = "openrouter:default";

type OpenRouterOAuthCallbackResult = {
  code: string;
  state: string;
};

type OpenRouterOAuthKeyResult = {
  key: string;
  userId?: string;
};

type OpenRouterOAuthLoginOptions = {
  createPkce?: () => { verifier: string; challenge: string };
  createState?: () => string;
  fetchImpl?: typeof fetch;
  waitForCallback?: typeof waitForOpenRouterOAuthCallback;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function extractOpenRouterError(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = readString(value.message) ?? readString(value.error_description);
  if (direct) {
    return direct;
  }
  const error = value.error;
  if (typeof error === "string") {
    return error.trim() || undefined;
  }
  if (isRecord(error)) {
    return readString(error.message) ?? readString(error.code);
  }
  return undefined;
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.ok) {
    return await readProviderJsonResponse(response, "OpenRouter OAuth key exchange");
  }
  const text = await readResponseTextLimited(
    response,
    OPENROUTER_OAUTH_ERROR_BODY_LIMIT_BYTES,
  ).catch(() => "");
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseOpenRouterKeyResponse(value: unknown): OpenRouterOAuthKeyResult {
  if (!isRecord(value)) {
    throw new Error("OpenRouter OAuth key exchange returned an unexpected response.");
  }
  const key = readString(value.key);
  if (!key) {
    throw new Error("OpenRouter OAuth key exchange returned no API key.");
  }
  const userId = readString(value.user_id) ?? readString(value.userId);
  return {
    key,
    ...(userId ? { userId } : {}),
  };
}

function buildOpenRouterOAuthRedirectUri(params: { state: string }): string {
  const url = new URL(OPENROUTER_OAUTH_REDIRECT_URI);
  url.searchParams.set("state", params.state);
  return url.toString();
}

function buildOpenRouterOAuthAuthorizeUrl(params: {
  codeChallenge: string;
  state: string;
}): string {
  const url = new URL(OPENROUTER_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("callback_url", buildOpenRouterOAuthRedirectUri({ state: params.state }));
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", OPENROUTER_OAUTH_CODE_CHALLENGE_METHOD);
  return url.toString();
}

function requireOpenRouterOAuthState(state: string | undefined, expectedState: string): string {
  if (!state) {
    throw new Error("Missing OpenRouter OAuth state. Paste the full redirect URL.");
  }
  if (state !== expectedState) {
    throw new Error("OpenRouter OAuth state mismatch. Please retry login.");
  }
  return state;
}

function parseOpenRouterOAuthCallbackInput(
  input: string,
  expectedState: string,
): OpenRouterOAuthCallbackResult {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("No input provided.");
  }

  const parseParams = (params: URLSearchParams): OpenRouterOAuthCallbackResult => {
    const state = requireOpenRouterOAuthState(readString(params.get("state")), expectedState);
    const error = readString(params.get("error"));
    if (error) {
      const description = readString(params.get("error_description"));
      throw new Error(
        `OpenRouter OAuth error: ${description ? `${error}: ${description}` : error}`,
      );
    }
    const code = readString(params.get("code"));
    if (!code) {
      throw new Error("Missing 'code' parameter in redirect URL.");
    }
    return { code, state };
  };

  try {
    const url = new URL(trimmed);
    return parseParams(url.searchParams);
  } catch (err) {
    if (err instanceof TypeError) {
      if (trimmed.includes("code=") || trimmed.includes("error=")) {
        return parseParams(new URLSearchParams(trimmed));
      }
      throw new Error("Paste the full OpenRouter redirect URL, not just the code.", {
        cause: err,
      });
    }
    throw err;
  }
}

async function exchangeOpenRouterOAuthCode(params: {
  code: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<OpenRouterOAuthKeyResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(OPENROUTER_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      code: params.code,
      code_verifier: params.codeVerifier,
      code_challenge_method: OPENROUTER_OAUTH_CODE_CHALLENGE_METHOD,
    }),
    signal: params.signal
      ? AbortSignal.any([params.signal, AbortSignal.timeout(OPENROUTER_OAUTH_FETCH_TIMEOUT_MS)])
      : AbortSignal.timeout(OPENROUTER_OAUTH_FETCH_TIMEOUT_MS),
  });
  const body = await readResponseBody(response);
  if (!response.ok) {
    const message = extractOpenRouterError(body);
    throw new Error(
      `OpenRouter OAuth key exchange failed (${response.status})${message ? `: ${message}` : ""}`,
    );
  }
  return parseOpenRouterKeyResponse(body);
}

async function waitForOpenRouterOAuthCallback(params: {
  expectedState: string;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<OpenRouterOAuthCallbackResult> {
  const timeoutMs = params.timeoutMs ?? OPENROUTER_OAUTH_TIMEOUT_MS;
  return new Promise<OpenRouterOAuthCallbackResult>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error("OpenRouter OAuth callback timeout"));
    }, timeoutMs);
    const server = createServer((req, res) => {
      try {
        const requestUrl = new URL(
          req.url ?? "/",
          `http://${OPENROUTER_OAUTH_CALLBACK_HOST}:${OPENROUTER_OAUTH_CALLBACK_PORT}`,
        );
        if (requestUrl.pathname !== OPENROUTER_OAUTH_CALLBACK_PATH) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain");
          res.end("Not found");
          return;
        }
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          res.setHeader("Content-Type", "text/plain");
          res.end("Method not allowed");
          return;
        }

        const state = readString(requestUrl.searchParams.get("state"));
        try {
          requireOpenRouterOAuthState(state, params.expectedState);
        } catch (err) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end("Invalid OAuth state");
          finish(err instanceof Error ? err : new Error("OpenRouter OAuth state mismatch"));
          return;
        }

        const error = readString(requestUrl.searchParams.get("error"));
        if (error) {
          const description = readString(requestUrl.searchParams.get("error_description"));
          const detail = description ? `${error}: ${description}` : error;
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end(`OpenRouter authentication failed: ${detail}`);
          finish(new Error(`OpenRouter OAuth error: ${detail}`));
          return;
        }

        const code = readString(requestUrl.searchParams.get("code"));
        if (!code) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end("Missing OAuth code");
          finish(new Error("Missing OpenRouter OAuth code"));
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          "<!doctype html><html><head><meta charset='utf-8'/></head>" +
            "<body><h2>OpenRouter OAuth complete</h2>" +
            "<p>You can close this window and return to OpenClaw.</p></body></html>",
        );
        finish(undefined, { code, state: params.expectedState });
      } catch (err) {
        finish(err instanceof Error ? err : new Error("OpenRouter OAuth callback failed"));
      }
    });

    const finish = (err?: Error, result?: OpenRouterOAuthCallbackResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      params.signal?.removeEventListener("abort", onAbort);
      try {
        server.close();
      } catch {
        // Best-effort cleanup after callback completion or timeout.
      }
      if (err) {
        reject(err);
        return;
      }
      if (result) {
        resolve(result);
      }
    };

    const onAbort = () => finish(new Error("OpenRouter OAuth cancelled"));
    params.signal?.addEventListener("abort", onAbort, { once: true });
    if (params.signal?.aborted) {
      onAbort();
      return;
    }

    server.once("error", (err) => {
      finish(err instanceof Error ? err : new Error("OpenRouter OAuth callback server error"));
    });
    server.listen(OPENROUTER_OAUTH_CALLBACK_PORT, OPENROUTER_OAUTH_CALLBACK_HOST, () => {
      params.onProgress?.(
        `Waiting for OpenRouter OAuth callback on ${OPENROUTER_OAUTH_REDIRECT_URI}...`,
      );
    });
  });
}

async function promptForOpenRouterRedirect(
  ctx: ProviderAuthContext,
  expectedState: string,
): Promise<string> {
  const input = await ctx.prompter.text({
    message: "Paste the OpenRouter redirect URL",
    placeholder: `${OPENROUTER_OAUTH_REDIRECT_URI}?state=...&code=...`,
    validate: (value: string) => (value.trim().length > 0 ? undefined : "Required"),
  });
  return parseOpenRouterOAuthCallbackInput(input, expectedState).code;
}

async function resolveOpenRouterOAuthCode(
  ctx: ProviderAuthContext,
  params: {
    authorizeUrl: string;
    state: string;
    waitForCallback: typeof waitForOpenRouterOAuthCallback;
    onProgress: (message: string) => void;
  },
): Promise<string> {
  await ctx.prompter.note(
    ctx.isRemote
      ? [
          "Open this URL in your LOCAL browser.",
          "After signing in, paste the redirect URL back here.",
          "",
          `Redirect URI: ${OPENROUTER_OAUTH_REDIRECT_URI}`,
        ].join("\n")
      : [
          "Browser will open for OpenRouter authentication.",
          "If the callback does not auto-complete, paste the redirect URL.",
          "",
          `Redirect URI: ${OPENROUTER_OAUTH_REDIRECT_URI}`,
        ].join("\n"),
    "OpenRouter OAuth",
  );

  if (ctx.isRemote) {
    ctx.runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${params.authorizeUrl}\n`);
    await ctx.openUrl(params.authorizeUrl);
    await ctx.prompter.note(
      `Open this URL in your LOCAL browser:\n\n${params.authorizeUrl}`,
      "OpenRouter OAuth",
    );
    return await promptForOpenRouterRedirect(ctx, params.state);
  }

  const callbackPromise = params
    .waitForCallback({
      expectedState: params.state,
      onProgress: params.onProgress,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    .catch(async (error: unknown) => {
      if (ctx.signal?.aborted) {
        throw error;
      }
      params.onProgress("OAuth callback not detected; waiting for redirect URL...");
      return { code: await promptForOpenRouterRedirect(ctx, params.state), state: params.state };
    });
  void callbackPromise.catch(() => undefined);

  try {
    await ctx.openUrl(params.authorizeUrl);
    ctx.runtime.log(`Open: ${params.authorizeUrl}`);
  } catch {
    ctx.runtime.log(`Open manually: ${params.authorizeUrl}`);
  }

  return (await callbackPromise).code;
}

async function loginOpenRouterOAuth(
  ctx: ProviderAuthContext,
  options: OpenRouterOAuthLoginOptions = {},
): Promise<ProviderAuthResult> {
  const progress = ctx.prompter.progress("Starting OpenRouter OAuth...");
  try {
    const pkce = options.createPkce?.() ?? generatePkceVerifierChallenge();
    const state = options.createState?.() ?? generateOAuthState();
    const authorizeUrl = buildOpenRouterOAuthAuthorizeUrl({
      codeChallenge: pkce.challenge,
      state,
    });
    const code = await resolveOpenRouterOAuthCode(ctx, {
      authorizeUrl,
      state,
      waitForCallback: options.waitForCallback ?? waitForOpenRouterOAuthCallback,
      onProgress: (message) => progress.update(message),
    });
    progress.update("Exchanging OpenRouter OAuth code...");
    const token = await exchangeOpenRouterOAuthCode({
      code,
      codeVerifier: pkce.verifier,
      fetchImpl: options.fetchImpl,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    progress.stop("OpenRouter OAuth complete");

    const metadata = {
      authFlow: "oauth-pkce",
      ...(token.userId ? { userId: token.userId } : {}),
    };
    const credential = {
      ...buildApiKeyCredential(PROVIDER_ID, token.key, metadata),
      displayName: token.userId ? `OpenRouter ${token.userId}` : "OpenRouter OAuth",
    };

    return {
      profiles: [{ profileId: OPENROUTER_OAUTH_PROFILE_ID, credential }],
      configPatch: applyOpenrouterConfig(ctx.config),
      defaultModel: OPENROUTER_DEFAULT_MODEL_REF,
      notes: [
        "OpenRouter OAuth issued an OpenRouter API key and stored it in the default OpenRouter auth profile.",
        "Re-run OpenRouter OAuth to rotate that key or use the API-key setup path for a key you manage manually.",
      ],
    };
  } catch (err) {
    progress.stop("OpenRouter OAuth failed");
    throw new Error(`OpenRouter OAuth failed: ${formatErrorMessage(err)}`, { cause: err });
  }
}

export function createOpenRouterOAuthAuthMethod(
  options: OpenRouterOAuthLoginOptions = {},
): ProviderAuthMethod {
  return {
    id: OPENROUTER_OAUTH_METHOD_ID,
    label: "OpenRouter OAuth",
    hint: "Browser sign-in",
    kind: "oauth",
    wizard: {
      choiceId: OPENROUTER_OAUTH_CHOICE_ID,
      choiceLabel: "OpenRouter OAuth",
      choiceHint: "Browser sign-in",
      groupId: PROVIDER_ID,
      groupLabel: "OpenRouter",
      groupHint: "OAuth or API key",
      methodId: OPENROUTER_OAUTH_METHOD_ID,
      onboardingScopes: ["text-inference", "music-generation"],
      onboardingFeatured: true,
    },
    run: async (ctx) => await loginOpenRouterOAuth(ctx, options),
  };
}
