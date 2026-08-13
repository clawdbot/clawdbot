// Proxy capture env helpers build proxy-related env vars for child processes.
import { randomUUID } from "node:crypto";
import type { Agent } from "node:http";
import process from "node:process";
import { createAmbientNodeProxyAgent } from "@openclaw/proxyline";
import {
  resolveDebugProxyBlobDir,
  resolveDebugProxyCertDir,
  resolveDebugProxyDbPath,
} from "./paths.js";

// Environment contract for debug proxy capture. These vars are passed to child
// processes and provider transports so capture sessions share one store/proxy.
const OPENCLAW_DEBUG_PROXY_ENABLED = "OPENCLAW_DEBUG_PROXY_ENABLED";
const OPENCLAW_DEBUG_PROXY_URL = "OPENCLAW_DEBUG_PROXY_URL";
const OPENCLAW_DEBUG_PROXY_CERT_DIR = "OPENCLAW_DEBUG_PROXY_CERT_DIR";
const OPENCLAW_DEBUG_PROXY_SESSION_ID = "OPENCLAW_DEBUG_PROXY_SESSION_ID";
const OPENCLAW_DEBUG_PROXY_REQUIRE = "OPENCLAW_DEBUG_PROXY_REQUIRE";

export type DebugProxySettings = {
  enabled: boolean;
  required: boolean;
  proxyUrl?: string;
  /** @deprecated Capture storage now lives in the shared state database. */
  dbPath: string;
  /** @deprecated Capture payloads now live in the shared state database. */
  blobDir: string;
  certDir: string;
  sessionId: string;
  sourceProcess: string;
};

let cachedImplicitSessionId: string | undefined;

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function resolveDebugProxySettings(
  env: NodeJS.ProcessEnv = process.env,
): DebugProxySettings {
  const enabled = isTruthy(env[OPENCLAW_DEBUG_PROXY_ENABLED]);
  const explicitSessionId = env[OPENCLAW_DEBUG_PROXY_SESSION_ID]?.trim() || undefined;
  // Local implicit sessions stay stable within one process so repeated callers
  // write to the same capture session until an explicit id overrides it.
  const sessionId = explicitSessionId ?? (cachedImplicitSessionId ??= randomUUID());
  return {
    enabled,
    required: isTruthy(env[OPENCLAW_DEBUG_PROXY_REQUIRE]),
    proxyUrl: env[OPENCLAW_DEBUG_PROXY_URL]?.trim() || undefined,
    dbPath: resolveDebugProxyDbPath(env),
    blobDir: resolveDebugProxyBlobDir(env),
    certDir: env[OPENCLAW_DEBUG_PROXY_CERT_DIR]?.trim() || resolveDebugProxyCertDir(env),
    sessionId,
    sourceProcess: "openclaw",
  };
}

export function applyDebugProxyEnv(
  env: NodeJS.ProcessEnv,
  params: {
    proxyUrl: string;
    sessionId: string;
    certDir?: string;
  },
): NodeJS.ProcessEnv {
  // Child process env forces proxy capture and standard proxy variables while
  // preserving unrelated environment values.
  return {
    ...env,
    [OPENCLAW_DEBUG_PROXY_ENABLED]: "1",
    [OPENCLAW_DEBUG_PROXY_REQUIRE]: "1",
    [OPENCLAW_DEBUG_PROXY_URL]: params.proxyUrl,
    [OPENCLAW_DEBUG_PROXY_CERT_DIR]: params.certDir ?? resolveDebugProxyCertDir(env),
    [OPENCLAW_DEBUG_PROXY_SESSION_ID]: params.sessionId,
    HTTP_PROXY: params.proxyUrl,
    HTTPS_PROXY: params.proxyUrl,
    ALL_PROXY: params.proxyUrl,
  };
}

export function createDebugProxyWebSocketAgent(settings: DebugProxySettings): Agent | undefined {
  if (!settings.enabled || !settings.proxyUrl) {
    return undefined;
  }
  return createAmbientNodeProxyAgent({
    protocol: "https",
    env: {
      HTTP_PROXY: settings.proxyUrl,
      HTTPS_PROXY: settings.proxyUrl,
      ALL_PROXY: undefined,
      NO_PROXY: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
      all_proxy: undefined,
      no_proxy: undefined,
    },
  }) as Agent | undefined;
}

// Configured URLs win over ambient capture settings; callers use this when a
// channel/provider already exposes an explicit proxy option.
export function resolveEffectiveDebugProxyUrl(configuredProxyUrl?: string): string | undefined {
  const explicit = configuredProxyUrl?.trim();
  if (explicit) {
    return explicit;
  }
  const settings = resolveDebugProxySettings();
  return settings.enabled ? settings.proxyUrl : undefined;
}
