// Provider auth runtime helpers implement OAuth loopback, token exchange, and auth persistence.
import crypto from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureAuthProfileStore } from "../agents/auth-profiles/store.js";
import { resolveApiKeyForProvider as resolveModelApiKeyForProvider } from "../agents/model-auth.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";

export { resolveEnvApiKey } from "../agents/model-auth-env.js";
export {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "../agents/api-key-rotation.js";
export { NON_ENV_SECRETREF_MARKER } from "../agents/model-auth-markers.js";
export {
  requireApiKey,
  resolveAwsSdkEnvVarName,
  type ResolvedProviderAuth,
} from "../agents/model-auth-runtime-shared.js";
export type { ProviderPreparedRuntimeAuth } from "../plugins/types.js";
export type { ResolvedProviderRuntimeAuth } from "../plugins/runtime/model-auth-types.js";

/**
 * OAuth authorization code and state captured by the local callback listener.
 */
export type OAuthCallbackResult = {
  /** Authorization code returned by the OAuth provider callback. */
  code: string;
  /** State value returned by the callback and validated against the expected state. */
  state: string;
};

/**
 * Non-secret auth profile metadata used by provider discovery helpers.
 */
export type ProviderAuthProfileMetadata = {
  profileId?: string;
  accountId?: string;
};

export function resolveProviderAuthProfileMetadata(params: {
  provider: string;
  cfg?: OpenClawConfig;
  profileId?: string;
  agentDir?: string;
}): ProviderAuthProfileMetadata {
  const store = ensureAuthProfileStore(params.agentDir, {
    config: params.cfg,
    readOnly: true,
  });
  const normalizedProvider = normalizeProviderId(params.provider);
  const entry = params.profileId
    ? ([params.profileId, store.profiles[params.profileId]] as const)
    : Object.entries(store.profiles).find(
        ([, profile]) => normalizeProviderId(profile.provider) === normalizedProvider,
      );
  const [profileId, profile] = entry ?? [];
  if (!profile) {
    return {};
  }
  return {
    profileId,
    ...(profile.type === "oauth" && profile.accountId ? { accountId: profile.accountId } : {}),
  };
}

// IdP-host allowlist for CORS echo on the loopback OAuth callback. Plugins
// pass the hosts that may legitimately issue preflights against the redirect
// URI; everything else gets a 204 with no `Access-Control-Allow-*` headers,
// which is safe for normal browser navigation but blocks cross-origin script
// reads. The empty allowlist (default) leaves the legacy permissive SDK
// behavior in place for existing callers.
export function buildOAuthCallbackOriginResolver(
  /** HTTPS IdP hosts allowed to receive a CORS echo from the loopback callback. */
  allowedHosts: readonly string[] | undefined,
): (originHeader: string | string[] | undefined) => string | undefined {
  if (!allowedHosts || allowedHosts.length === 0) {
    return () => undefined;
  }
  const normalized = new Set(
    allowedHosts.map((host) => host.trim().toLowerCase()).filter((host) => host.length > 0),
  );
  if (normalized.size === 0) {
    return () => undefined;
  }
  return (originHeader) => {
    const value = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (!value) {
      return undefined;
    }
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:") {
        return undefined;
      }
      return normalized.has(parsed.host.toLowerCase()) ? parsed.origin : undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * Generates a high-entropy OAuth state token for local callback validation.
 */
export function generateOAuthState(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Parses a pasted OAuth redirect URL into callback code/state fields.
 */
export function parseOAuthCallbackInput(
  /** Full redirect URL pasted by the operator after manual OAuth completion. */
  input: string,
  messages: {
    /** Override for URLs that omit the state query parameter. */
    missingState?: string;
    /** Override for values that are not parseable redirect URLs. */
    invalidInput?: string;
  } = {},
): OAuthCallbackResult | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { error: "No input provided" };
  }

  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code) {
      return { error: "Missing 'code' parameter in URL" };
    }
    if (!state) {
      return { error: messages.missingState ?? "Missing 'state' parameter in URL" };
    }
    return { code, state };
  } catch {
    return { error: messages.invalidInput ?? "Paste the full redirect URL, not just the code." };
  }
}

/**
 * Starts a temporary loopback HTTP listener and waits for a validated OAuth callback.
 */
export async function waitForLocalOAuthCallback(params: {
  /** State token that the callback must echo before the listener resolves. */
  expectedState: string;
  /** Maximum wait time before the listener rejects. */
  timeoutMs: number;
  /** Loopback port to bind for the temporary callback server. */
  port: number;
  /** URL path accepted as the OAuth callback endpoint. */
  callbackPath: string;
  /** Redirect URI shown in progress messages and provider setup flows. */
  redirectUri: string;
  /** HTML success heading rendered after a valid callback. */
  successTitle: string;
  /** Optional progress message emitted once the listener starts. */
  progressMessage?: string;
  /** Loopback hostname to bind; defaults to localhost. */
  hostname?: string;
  /** Progress callback invoked after the server begins listening. */
  onProgress?: (message: string) => void;
  /** Stops and closes the callback listener when the owning login is cancelled. */
  signal?: AbortSignal;
  /**
   * IdP hosts allowed to receive CORS echo on loopback callback preflights.
   */
  corsOriginAllowlist?: readonly string[];
}): Promise<OAuthCallbackResult> {
  const hostname = params.hostname ?? "localhost";
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  const escapedSuccessTitle = escapeHtmlText(params.successTitle);
  const resolveOAuthCallbackOrigin = buildOAuthCallbackOriginResolver(params.corsOriginAllowlist);
  const hasCorsOriginAllowlist =
    params.corsOriginAllowlist?.some((host) => host.trim().length > 0) ?? false;

  return new Promise<OAuthCallbackResult>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    const server = createServer((req, res) => {
      try {
        applyOAuthCallbackCorsHeaders(
          req,
          res,
          hasCorsOriginAllowlist ? resolveOAuthCallbackOrigin : undefined,
        );
        const requestUrl = new URL(req.url ?? "/", `http://${hostname}:${params.port}`);
        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }
        if (requestUrl.pathname !== params.callbackPath) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain");
          res.end("Not found");
          return;
        }
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET, OPTIONS");
          res.setHeader("Content-Type", "text/plain");
          res.end("Method not allowed");
          return;
        }

        const error = requestUrl.searchParams.get("error");
        const code = requestUrl.searchParams.get("code")?.trim();
        const state = requestUrl.searchParams.get("state")?.trim();

        if (error) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end(`Authentication failed: ${error}`);
          finish(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code || !state) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end("Missing code or state");
          finish(new Error("Missing OAuth code or state"));
          return;
        }

        if (state !== params.expectedState) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end("Invalid state");
          finish(new Error("OAuth state mismatch"));
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          "<!doctype html><html><head><meta charset='utf-8'/></head>" +
            `<body><h2>${escapedSuccessTitle}</h2>` +
            "<p>You can close this window and return to OpenClaw.</p></body></html>",
        );

        finish(undefined, { code, state });
      } catch (err) {
        finish(err instanceof Error ? err : new Error("OAuth callback failed"));
      }
    });

    const finish = (err?: Error, result?: OAuthCallbackResult) => {
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
        // ignore close errors
      }
      if (err) {
        reject(err);
      } else if (result) {
        resolve(result);
      }
    };

    const onAbort = () => finish(new Error("OAuth callback cancelled"));
    params.signal?.addEventListener("abort", onAbort, { once: true });
    if (params.signal?.aborted) {
      onAbort();
      return;
    }

    server.once("error", (err) => {
      finish(err instanceof Error ? err : new Error("OAuth callback server error"));
    });

    server.listen(params.port, hostname, () => {
      params.onProgress?.(
        params.progressMessage ?? `Waiting for OAuth callback on ${params.redirectUri}...`,
      );
    });

    timeout = setTimeout(() => {
      finish(new Error("OAuth callback timeout"));
    }, timeoutMs);
  });
}

function applyOAuthCallbackCorsHeaders(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  resolveOrigin?: (originHeader: string | string[] | undefined) => string | undefined,
): void {
  const origin =
    resolveOrigin === undefined
      ? typeof req.headers.origin === "string" && isHttpOrigin(req.headers.origin)
        ? req.headers.origin
        : undefined
      : resolveOrigin(req.headers.origin);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  }
  if (resolveOrigin !== undefined && !origin) {
    // With an allowlist present, untrusted origins receive a bare 204 preflight
    // response so browser navigation still works but scripts cannot read it.
    return;
  }

  const requestedHeaders = req.headers["access-control-request-headers"];
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    typeof requestedHeaders === "string" && requestedHeaders.trim().length > 0
      ? requestedHeaders
      : "content-type",
  );
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Max-Age", "600");
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type ResolveApiKeyForProvider = typeof import("../agents/model-auth.js").resolveApiKeyForProvider;
type GetRuntimeAuthForModel =
  typeof import("../plugins/runtime/runtime-model-auth.runtime.js").getRuntimeAuthForModel;
type RuntimeModelAuthModule = typeof import("../plugins/runtime/runtime-model-auth.runtime.js");
const RUNTIME_MODEL_AUTH_CANDIDATES = [
  "./runtime-model-auth.runtime",
  "../plugins/runtime/runtime-model-auth.runtime",
] as const;
const RUNTIME_MODEL_AUTH_EXTENSIONS = [".js", ".ts", ".mjs", ".mts", ".cjs", ".cts"] as const;

function resolveRuntimeModelAuthModuleHref(): string {
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  for (const relativeBase of RUNTIME_MODEL_AUTH_CANDIDATES) {
    for (const ext of RUNTIME_MODEL_AUTH_EXTENSIONS) {
      const candidate = path.resolve(baseDir, `${relativeBase}${ext}`);
      if (fs.existsSync(candidate)) {
        return pathToFileURL(candidate).href;
      }
    }
  }
  throw new Error(`Unable to resolve runtime model auth module from ${import.meta.url}`);
}

async function loadRuntimeModelAuthModule(): Promise<RuntimeModelAuthModule> {
  return (await import(resolveRuntimeModelAuthModuleHref())) as RuntimeModelAuthModule;
}

/**
 * Resolves provider API-key auth through the runtime auth module when available.
 */
export async function resolveApiKeyForProvider(
  /** Provider auth lookup params forwarded to the runtime auth module. */
  params: Parameters<ResolveApiKeyForProvider>[0],
): Promise<Awaited<ReturnType<ResolveApiKeyForProvider>>> {
  const runtimeAuth = await loadRuntimeModelAuthModule();
  const resolveApiKeyForProviderLocal =
    typeof runtimeAuth.resolveApiKeyForProvider === "function"
      ? runtimeAuth.resolveApiKeyForProvider
      : resolveModelApiKeyForProvider;
  return resolveApiKeyForProviderLocal(params);
}

/**
 * Resolves the prepared runtime auth payload for a concrete model request.
 */
export async function getRuntimeAuthForModel(
  /** Concrete model auth request forwarded to the runtime auth module. */
  params: Parameters<GetRuntimeAuthForModel>[0],
): Promise<Awaited<ReturnType<GetRuntimeAuthForModel>>> {
  const { getRuntimeAuthForModel: getRuntimeAuthForModelLocal } =
    await loadRuntimeModelAuthModule();
  return getRuntimeAuthForModelLocal(params);
}
