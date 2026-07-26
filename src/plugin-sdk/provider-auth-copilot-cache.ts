import { createHash } from "node:crypto";
import path from "node:path";
import { asDateTimestampMs } from "../../packages/normalization-core/src/number-coercion.js";
import { COPILOT_INTEGRATION_ID } from "../agents/copilot-dynamic-headers.js";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { DEFAULT_GITHUB_COPILOT_DOMAIN } from "./github-copilot-domain.js";

const COPILOT_CACHE_NAMESPACE = "github-copilot-token";
// Retain ordinary multi-account rotation without letting credential-derived
// bearer tokens grow unbounded in shared state.
const COPILOT_TOKEN_CACHE_MAX_ENTRIES = 8;

/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
export type CachedCopilotToken = {
  /** Copilot API token returned by GitHub's internal exchange endpoint. */
  token: string;
  /** Absolute epoch milliseconds when the Copilot API token expires. */
  expiresAt: number;
  /** Absolute epoch milliseconds when this cache entry was written. */
  updatedAt: number;
  /** Copilot integration id that produced this cached token. */
  integrationId?: string;
  /** SHA-256 fingerprint of the GitHub credential exchanged for this token. */
  sourceCredentialFingerprint?: string;
  /**
   * GitHub host this token was minted for. Guards against reusing a public
   * `github.com` Copilot token against a `*.ghe.com` tenant host (or vice
   * versa) after a domain switch. Shipped caches predate this field and were
   * only ever minted for public github.com, so a missing value means
   * `github.com` (keeps valid public entries usable across upgrade).
   */
  domain?: string;
};

function resolveLegacyCopilotTokenCachePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "credentials", "github-copilot.token.json");
}

export function fingerprintCopilotSourceCredential(githubToken: string): string {
  return createHash("sha256").update(githubToken).digest("hex");
}

export function isCopilotTokenUsable(params: {
  cache: CachedCopilotToken;
  domain: string;
  sourceCredentialFingerprint: string;
  now?: number;
}): boolean {
  const expiresAt = asDateTimestampMs(params.cache.expiresAt);
  // Legacy entries (pre domain-stamp) could only have been minted for public
  // github.com; defaulting keeps them usable across upgrade while tenant
  // requests still force a re-exchange.
  const cacheDomain = params.cache.domain ?? DEFAULT_GITHUB_COPILOT_DOMAIN;
  return (
    params.cache.integrationId === COPILOT_INTEGRATION_ID &&
    cacheDomain === params.domain &&
    params.cache.sourceCredentialFingerprint === params.sourceCredentialFingerprint &&
    expiresAt !== undefined &&
    expiresAt - (params.now ?? Date.now()) > 5 * 60 * 1000
  );
}

type CopilotTokenCache = {
  path: string;
  load(): CachedCopilotToken | undefined;
  save(value: CachedCopilotToken): void;
};

export async function resolveCopilotTokenCache(params: {
  env: NodeJS.ProcessEnv;
  domain: string;
  sourceCredentialFingerprint: string;
  cachePath?: string;
  loadJsonFileImpl?: (path: string) => unknown;
  saveJsonFileImpl?: (path: string, value: CachedCopilotToken) => void;
}): Promise<CopilotTokenCache> {
  const usesLegacyCacheAdapter =
    params.cachePath !== undefined ||
    params.loadJsonFileImpl !== undefined ||
    params.saveJsonFileImpl !== undefined;
  if (usesLegacyCacheAdapter) {
    // Kept only for the deprecated public helper's explicit cache adapters.
    // Normal runtime state uses the bounded SQLite namespace below.
    const cachePath = params.cachePath?.trim() || resolveLegacyCopilotTokenCachePath(params.env);
    const loadJsonFileFn = params.loadJsonFileImpl ?? loadJsonFile;
    const saveJsonFileFn = params.saveJsonFileImpl ?? saveJsonFile;
    return {
      path: cachePath,
      load: () => loadJsonFileFn(cachePath) as CachedCopilotToken | undefined,
      save: (value) => saveJsonFileFn(cachePath, value),
    };
  }

  const { createCorePluginStateSyncKeyedStore } =
    await import("../plugin-state/plugin-state-store.js");
  const store = createCorePluginStateSyncKeyedStore<CachedCopilotToken>({
    ownerId: "core:provider-auth",
    namespace: COPILOT_CACHE_NAMESPACE,
    maxEntries: COPILOT_TOKEN_CACHE_MAX_ENTRIES,
    overflowPolicy: "evict-oldest",
    env: params.env,
  });
  const key = `${params.domain}:${params.sourceCredentialFingerprint}`;
  return {
    path: "plugin-state",
    load: () => store.lookup(key),
    save: (value) =>
      store.register(key, value, {
        ttlMs: Math.max(1, value.expiresAt - Date.now()),
      }),
  };
}
