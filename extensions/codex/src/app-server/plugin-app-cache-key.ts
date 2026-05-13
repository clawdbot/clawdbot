import { createHash } from "node:crypto";
import {
  buildCodexAppInventoryCacheKey,
  type CodexAppInventoryCacheKeyInput,
} from "./app-inventory-cache.js";
import { resolveCodexAppServerHomeDir } from "./auth-bridge.js";
import type { CodexAppServerRuntimeOptions, CodexAppServerStartOptions } from "./config.js";

export type CodexPluginAppCacheKeyParams = Omit<
  CodexAppInventoryCacheKeyInput,
  "codexHome" | "endpoint"
> & {
  appServer: Pick<CodexAppServerRuntimeOptions, "start">;
  agentDir?: string;
};

export function buildCodexPluginAppCacheKey(params: CodexPluginAppCacheKeyParams): string {
  return buildCodexAppInventoryCacheKey({
    codexHome: resolveCodexPluginAppCacheCodexHome(params.appServer, params.agentDir),
    endpoint: resolveCodexPluginAppCacheEndpoint(params.appServer),
    authProfileId: params.authProfileId,
    accountId: params.accountId,
    envApiKeyFingerprint: params.envApiKeyFingerprint,
    appServerVersion: params.appServerVersion,
  });
}

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
