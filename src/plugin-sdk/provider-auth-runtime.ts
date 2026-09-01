// Provider auth runtime helpers implement OAuth loopback, token exchange, and auth persistence.
import crypto from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { ensureAuthProfileStore } from "../agents/auth-profiles/store.js";
import type { OpenClawConfig } from "../config/config.js";
import { startOAuthLoopbackCallbackServer } from "../infra/oauth-loopback-callback.js";
import { escapeHtml } from "../shared/html-escape.js";

export { resolveEnvApiKey } from "../agents/model-auth-env.js";
export { removeProviderAuthProfilesWithLock } from "../agents/auth-profiles/profiles.js";
export { removeAuthProfileConfig } from "../plugins/provider-auth-helpers.js";
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

type ProviderOAuthLoopbackCallbackResult =
  | { type: "authorization_code"; code: string; state: string }
  | { type: "oauth_error"; error: string; errorDescription?: string };

type ProviderOAuthLoopbackCallbackServer = {
  waitForCallback: () => Promise<ProviderOAuthLoopbackCallbackResult>;
  close: () => Promise<void>;
};

type ProviderOAuthLoopbackRenderedResponse = { body: string; contentType: string };
type ProviderOAuthLoopbackCorsOriginResolver = (
  originHeader: string | string[] | undefined,
) => string | undefined;

/**
 * Binds a hardened loopback listener before returning so provider plugins can open the browser
 * only after the callback route is ready. Invalid request candidates remain nonterminal.
 */
export async function startProviderOAuthLoopbackCallbackServer(params: {
  redirectUrl: string | URL;
  expectedState: string;
  timeoutMs: number;
  signal?: AbortSignal;
  bindHostname?: string;
  resolveCorsOrigin?: ProviderOAuthLoopbackCorsOriginResolver;
  renderSuccess?: () => ProviderOAuthLoopbackRenderedResponse;
  renderError?: (message: string) => ProviderOAuthLoopbackRenderedResponse;
}): Promise<ProviderOAuthLoopbackCallbackServer> {
  return await startOAuthLoopbackCallbackServer(params);
}

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
function generateHexOAuthState(): string {
  return crypto.randomBytes(32).toString("hex");
}

export { generateHexOAuthState as generateOAuthState };

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
  /** Extra loopback hostname to bind; the redirect URI hostname is always bound. */
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
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  const escapedSuccessTitle = escapeHtml(params.successTitle);
  const callbackUrl = new URL(params.redirectUri);
  callbackUrl.port = String(params.port);
  callbackUrl.pathname = params.callbackPath;
  const resolveOAuthCallbackOrigin = buildOAuthCallbackOriginResolver(params.corsOriginAllowlist);
  const hasCorsOriginAllowlist =
    params.corsOriginAllowlist?.some((host) => host.trim().length > 0) ?? false;
  const callback = await startOAuthLoopbackCallbackServer({
    redirectUrl: callbackUrl,
    expectedState: params.expectedState,
    timeoutMs,
    ...(params.hostname ? { bindHostname: params.hostname } : {}),
    createServer,
    ...(params.signal ? { signal: params.signal } : {}),
    resolveCorsOrigin: hasCorsOriginAllowlist
      ? resolveOAuthCallbackOrigin
      : (originHeader) => {
          const value = Array.isArray(originHeader) ? originHeader[0] : originHeader;
          return value && isHttpOrigin(value) ? value : undefined;
        },
    renderSuccess: () => ({
      body:
        "<!doctype html><html><head><meta charset='utf-8'/></head>" +
        `<body><h2>${escapedSuccessTitle}</h2>` +
        "<p>You can close this window and return to OpenClaw.</p></body></html>",
      contentType: "text/html; charset=utf-8",
    }),
  });
  params.onProgress?.(
    params.progressMessage ?? `Waiting for OAuth callback on ${params.redirectUri}...`,
  );
  try {
    const result = await callback.waitForCallback();
    if (result.type === "oauth_error") {
      throw new Error(`OAuth error: ${result.error}`);
    }
    return { code: result.code, state: result.state };
  } finally {
    await callback.close();
  }
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

type ResolveApiKeyForProvider =
  typeof import("../agents/model-auth.js").resolveApiKeyForProviderCore;
type GetRuntimeAuthForModel =
  typeof import("../plugins/runtime/runtime-model-auth.runtime.js").getRuntimeAuthForModelCore;
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
    typeof runtimeAuth.resolveProviderRuntimeApiKey === "function"
      ? runtimeAuth.resolveProviderRuntimeApiKey
      : (await import("../agents/model-auth.js")).resolveApiKeyForProviderCore;
  return resolveApiKeyForProviderLocal(params);
}

/**
 * Resolves the prepared runtime auth payload for a concrete model request.
 */
export async function getRuntimeAuthForModel(
  /** Concrete model auth request forwarded to the runtime auth module. */
  params: Parameters<GetRuntimeAuthForModel>[0],
): Promise<Awaited<ReturnType<GetRuntimeAuthForModel>>> {
  const { getRuntimeAuthForModelCore: getRuntimeAuthForModelLocal } =
    await loadRuntimeModelAuthModule();
  return getRuntimeAuthForModelLocal(params);
}
