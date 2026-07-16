/**
 * OpenAI Codex (ChatGPT OAuth) flow
 *
 * NOTE: This module uses Node.js crypto and http for the OAuth callback.
 * It is only intended for CLI use, not browser environments.
 */

import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { parseOAuthAuthorizationInput } from "openclaw/plugin-sdk/provider-oauth-runtime";
import { resolveCodexAuthIdentity } from "./openai-chatgpt-auth-identity.js";
import {
  createOAuthLoginCancelledError,
  throwIfOAuthLoginAborted,
  withOAuthLoginAbort,
} from "./openai-chatgpt-oauth-abort.runtime.js";
import {
  createOpenAIAuthorizationFlow,
  resolveOpenAICallbackHost,
  resolveOpenAIRedirectUri,
} from "./openai-chatgpt-oauth-authorization.runtime.js";
import { oauthErrorHtml, oauthSuccessHtml } from "./openai-chatgpt-oauth-page.runtime.js";
import {
  exchangeOpenAIAuthorizationCode,
  refreshOpenAIAccessToken,
} from "./openai-chatgpt-oauth-token.runtime.js";
import type { OAuthCredentials, OAuthPrompt } from "./openai-chatgpt-oauth-types.runtime.js";

const CALLBACK_PORT = 1455;
const CALLBACK_HOST = resolveOpenAICallbackHost();
const REDIRECT_URI = resolveOpenAIRedirectUri(CALLBACK_HOST);
const MANUAL_PROMPT_FALLBACK_MS = 15_000;

type NodeOAuthRuntime = {
  http: typeof import("node:http");
};

const loadNodeOAuthModules = createLazyRuntimeModule(() =>
  import("node:http").then((http) => ({ http })),
);

function loadNodeOAuthRuntime(): Promise<NodeOAuthRuntime> {
  if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
    return Promise.reject(
      new Error("OpenAI Codex OAuth is only available in Node.js environments"),
    );
  }
  return loadNodeOAuthModules();
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
  onAuth: (info: { url: string; instructions?: string }) => Promise<void> | void;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  originator?: string;
  signal?: AbortSignal;
}): Promise<OAuthCredentials> {
  throwIfOAuthLoginAborted(options.signal);
  const { verifier, redirectUri, state, url } = await createOpenAIAuthorizationFlow(
    options.originator ?? "openclaw",
    REDIRECT_URI,
  );
  const server = await startLocalOAuthServer(state);

  let code: string | undefined;
  try {
    throwIfOAuthLoginAborted(options.signal);
    await options.onAuth({
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

    const tokenResult = await exchangeOpenAIAuthorizationCode(code, verifier, redirectUri, {
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
  const result = await refreshOpenAIAccessToken(refreshToken);
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
