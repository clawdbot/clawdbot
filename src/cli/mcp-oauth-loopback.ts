// Local callback capture for the interactive MCP OAuth CLI flow.
import { waitForLocalOAuthCallback } from "../plugin-sdk/provider-auth-runtime.js";

const MCP_OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const MCP_OAUTH_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

type McpOAuthLoopbackTarget = {
  callbackPath: string;
  hostname: string;
  port: number;
  redirectUri: string;
  state: string;
};

function resolveMcpOAuthLoopbackTarget(authorizationUrl: URL): McpOAuthLoopbackTarget | undefined {
  const state = authorizationUrl.searchParams.get("state")?.trim();
  const redirectUri = authorizationUrl.searchParams.get("redirect_uri")?.trim();
  if (!state || !redirectUri) {
    return undefined;
  }

  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    return undefined;
  }
  const hostname = redirect.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (
    redirect.protocol !== "http:" ||
    redirect.username ||
    redirect.password ||
    !MCP_OAUTH_LOOPBACK_HOSTS.has(hostname)
  ) {
    return undefined;
  }
  const port = redirect.port ? Number(redirect.port) : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return undefined;
  }
  return {
    callbackPath: redirect.pathname || "/",
    hostname,
    port,
    redirectUri: redirect.toString(),
    state,
  };
}

function formatMcpOAuthCallbackError(
  error: unknown,
  target: McpOAuthLoopbackTarget,
  manualFallbackCommand: string,
): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "EADDRINUSE") {
    return new Error(
      `MCP OAuth callback port ${target.port} is already in use. Complete approval in the browser, then run ${manualFallbackCommand}.`,
      { cause: error },
    );
  }
  if (/timeout/i.test(message)) {
    return new Error(
      `Timed out waiting for the MCP OAuth redirect on port ${target.port}. Complete approval in the browser, then run ${manualFallbackCommand}.`,
      { cause: error },
    );
  }
  if (/state mismatch/i.test(message)) {
    return new Error(
      `Rejected the MCP OAuth redirect because its state did not match. Restart login, or complete approval and run ${manualFallbackCommand}.`,
      { cause: error },
    );
  }
  return new Error(
    `MCP OAuth callback failed on port ${target.port}: ${message}. Complete approval in the browser, then run ${manualFallbackCommand}.`,
    { cause: error },
  );
}

/** Capture a loopback OAuth callback, or leave custom redirects on the manual path. */
export async function waitForMcpOAuthAuthorizationCode(params: {
  authorizationUrl: URL;
  manualFallbackCommand: string;
  onReady: () => void;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const target = resolveMcpOAuthLoopbackTarget(params.authorizationUrl);
  if (!target) {
    params.onReady();
    return undefined;
  }

  const controller = new AbortController();
  let markListening: (() => void) | undefined;
  const listening = new Promise<void>((resolve) => {
    markListening = resolve;
  });
  const callback = waitForLocalOAuthCallback({
    expectedState: target.state,
    timeoutMs: params.timeoutMs ?? MCP_OAUTH_CALLBACK_TIMEOUT_MS,
    port: target.port,
    callbackPath: target.callbackPath,
    redirectUri: target.redirectUri,
    hostname: target.hostname,
    successTitle: "MCP OAuth complete",
    corsOriginAllowlist: [params.authorizationUrl.host],
    signal: controller.signal,
    onProgress: () => markListening?.(),
  });

  try {
    const startupError = await Promise.race([
      listening.then(() => undefined),
      callback.then(
        () => undefined,
        (error: unknown) => error,
      ),
    ]);
    // Even a failed listener leaves the authorization URL usable with --code.
    params.onReady();
    if (startupError !== undefined) {
      throw formatMcpOAuthCallbackError(startupError, target, params.manualFallbackCommand);
    }
    try {
      return (await callback).code;
    } catch (error) {
      throw formatMcpOAuthCallbackError(error, target, params.manualFallbackCommand);
    }
  } finally {
    controller.abort();
    await callback.catch(() => undefined);
  }
}
