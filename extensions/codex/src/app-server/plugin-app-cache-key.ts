/**
 * Builds stable Codex plugin/app inventory cache keys from app-server startup,
 * auth, account, and version inputs without storing secret material.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { OPENCLAW_VERSION } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readPluginPackageVersion } from "openclaw/plugin-sdk/extension-shared";
import {
  buildCodexAppInventoryCacheKey,
  type CodexAppInventoryCacheKeyInput,
} from "./app-inventory-cache.js";
import { resolveCodexAppServerHomeDir } from "./auth-bridge.js";
import type { CodexAppServerRuntimeIdentity } from "./client.js";
import {
  resolveCodexAppServerUserHomeDir,
  type CodexAppServerRuntimeOptions,
  type CodexAppServerStartOptions,
} from "./config.js";

const require = createRequire(import.meta.url);
const CODEX_PLUGIN_VERSION = readPluginPackageVersion({ require });

/** Inputs that identify the Codex app inventory cache scope for one runtime. */
export type CodexPluginAppCacheKeyParams = Omit<
  CodexAppInventoryCacheKeyInput,
  "codexHome" | "endpoint"
> & {
  appServer: Pick<CodexAppServerRuntimeOptions, "start">;
  agentDir?: string;
  runtimeIdentity?: CodexAppServerRuntimeIdentity;
};

/** Builds the full app inventory cache key for Codex plugin/app discovery. */
export function buildCodexPluginAppCacheKey(params: CodexPluginAppCacheKeyParams): string {
  return buildCodexAppInventoryCacheKey(
    {
      codexHome:
        params.runtimeIdentity?.codexHome ??
        resolveCodexPluginAppCacheCodexHome(params.appServer, params.agentDir),
      endpoint: resolveCodexPluginAppCacheEndpoint(params.appServer),
      authProfileId: params.authProfileId,
      accountId: params.accountId,
      envApiKeyFingerprint: params.envApiKeyFingerprint,
      appServerVersion: params.appServerVersion ?? params.runtimeIdentity?.serverVersion,
      runtimeIdentity: params.runtimeIdentity,
    },
    OPENCLAW_VERSION,
    CODEX_PLUGIN_VERSION,
  );
}

/** Builds a durable thread-binding fingerprint for one initialized app-server runtime. */
export function buildCodexAppServerRuntimeFingerprint(params: {
  appServer: Pick<
    CodexAppServerRuntimeOptions,
    "start" | "connectionClass" | "remoteWorkspaceRoot"
  >;
  appServerVersion?: string;
  runtimeIdentity?: CodexAppServerRuntimeIdentity;
}): string {
  return JSON.stringify({
    endpoint: resolveCodexPluginAppCacheEndpoint(params.appServer),
    connectionClass: params.appServer.connectionClass,
    remoteWorkspaceRoot: params.appServer.remoteWorkspaceRoot ?? null,
    appServerVersion: params.appServerVersion ?? params.runtimeIdentity?.serverVersion ?? null,
    runtimeIdentity: params.runtimeIdentity ?? null,
  });
}

/** Fingerprints the configured connection that owns a supervised source thread. */
export function buildCodexAppServerConnectionFingerprint(
  appServer: Pick<
    CodexAppServerRuntimeOptions,
    "start" | "connectionClass" | "remoteWorkspaceRoot"
  >,
  agentDir?: string,
): string {
  return JSON.stringify({
    endpoint: resolveCodexPluginAppCacheEndpoint(appServer),
    connectionClass: appServer.connectionClass,
    remoteWorkspaceRoot: appServer.remoteWorkspaceRoot ?? null,
    homeScope: appServer.start.homeScope ?? null,
    codexHome: resolveCodexAppServerConnectionHome(appServer.start, agentDir),
    cwd: appServer.start.cwd ?? null,
  });
}

function resolveCodexAppServerConnectionHome(
  start: CodexAppServerStartOptions,
  agentDir?: string,
): string | null {
  const configured = start.env?.CODEX_HOME?.trim();
  if (configured) {
    return configured;
  }
  if (start.transport === "unix" && (!start.url || start.url === "unix://")) {
    return resolveCodexAppServerUserHomeDir(start.env ?? process.env);
  }
  if (start.transport !== "stdio") {
    return null;
  }
  if (start.homeScope === "user") {
    return resolveCodexAppServerUserHomeDir(process.env);
  }
  return agentDir ? resolveCodexAppServerHomeDir(agentDir) : null;
}

/** Serializes app-server endpoint identity, including credential fingerprints. */
export function resolveCodexPluginAppCacheEndpoint(
  appServer: Pick<CodexAppServerRuntimeOptions, "start">,
): string {
  return JSON.stringify({
    transport: appServer.start.transport,
    command: appServer.start.command,
    args: appServer.start.args,
    url: appServer.start.url ?? null,
    credentialFingerprint: fingerprintCodexPluginAppCacheCredentials(appServer.start),
  });
}

/** Resolves the CODEX_HOME value that scopes local app-server inventory. */
export function resolveCodexPluginAppCacheCodexHome(
  appServer: Pick<CodexAppServerRuntimeOptions, "start">,
  agentDir?: string,
): string | undefined {
  const configuredCodexHome = appServer.start.env?.CODEX_HOME?.trim();
  if (configuredCodexHome) {
    return configuredCodexHome;
  }
  return appServer.start.transport === "stdio" && agentDir
    ? resolveCodexAppServerHomeDir(agentDir)
    : undefined;
}

function fingerprintCodexPluginAppCacheCredentials(
  startOptions: CodexAppServerStartOptions,
): string | null {
  const authToken = startOptions.authToken ?? "";
  const headers = Object.entries(startOptions.headers)
    .map(([key, value]) => [key.toLowerCase(), value] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));
  if (!authToken && headers.length === 0) {
    return null;
  }
  const hash = createHash("sha256");
  hash.update("openclaw:codex:plugin-app-cache-credentials:v1");
  hash.update("\0");
  hash.update(authToken);
  for (const [key, value] of headers) {
    hash.update("\0");
    hash.update(key);
    hash.update("\0");
    hash.update(value);
  }
  return `sha256:${hash.digest("hex")}`;
}
