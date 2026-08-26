// Memory Core plugin module owns embedding provider lifecycle.
import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  formatErrorMessage,
  readErrorName,
  toErrorObject,
} from "openclaw/plugin-sdk/error-runtime";
import { listRegisteredMemoryEmbeddingProviderAdapters } from "openclaw/plugin-sdk/memory-core-host-embedding-registry";
import { readRemoteProviderErrorFacts } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createSubsystemLogger,
  resolveAgentDir,
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type {
  MemoryEmbeddingProbeResult,
  MemorySearchRuntimeDebug,
  MemorySyncParams,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import {
  createEmbeddingProvider,
  resolveEmbeddingProviderAdapterTransport,
  type EmbeddingProvider,
  type EmbeddingProviderRequest,
  type EmbeddingProviderResult,
} from "./embeddings.js";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";
import { isMemoryEmbeddingProviderAccessError } from "./manager-embedding-policy.js";
import {
  createDegradedMemoryProviderLifecycle,
  createPendingMemoryProviderLifecycle,
  resolveMemoryPrimaryProviderRequest,
  resolveMemoryProviderState,
} from "./manager-provider-state.js";
import type { MemoryIndexIdentityState } from "./manager-reindex-state.js";

const EMBEDDING_PROBE_CACHE_TTL_MS = 30_000;
// Backoff for account-level provider rejections (quota, billing, auth). These
// only clear when an operator acts, so re-probing every 30s would burn one
// doomed paid request per sync tick; one probe per backoff window is enough.
const EMBEDDING_ACCESS_ERROR_BACKOFF_MS = 10 * 60_000;
const log = createSubsystemLogger("memory");

export type MemoryEmbeddingProviderRequirement = {
  mode: "fts-only" | "optional" | "required";
  provider: string;
  configuredProvider?: string;
};
export type MemoryEmbeddingBootstrapDebug = NonNullable<
  MemorySearchRuntimeDebug["embeddingBootstrap"]
>;
type EmbeddingProbeCacheEntry = {
  result: MemoryEmbeddingProbeResult;
  checkedAtMs: number;
  expireAtMs: number;
};
const EMBEDDING_PROBE_CACHE = new Map<string, EmbeddingProbeCacheEntry>();

export function clearMemoryEmbeddingProbeCache(): void {
  EMBEDDING_PROBE_CACHE.clear();
}

/** Probe-failure TTL doubles as the retry backoff for the failed provider. */
function resolveEmbeddingProbeFailureBackoffMs(err: unknown): number {
  return isMemoryEmbeddingProviderAccessError(err)
    ? EMBEDDING_ACCESS_ERROR_BACKOFF_MS
    : EMBEDDING_PROBE_CACHE_TTL_MS;
}

export function resolveEffectiveMemorySearchSettings(
  settings: ResolvedMemorySearchConfig,
): ResolvedMemorySearchConfig {
  if (settings.provider !== "none" || !settings.store.vector.enabled) {
    return settings;
  }
  return {
    ...settings,
    store: {
      ...settings.store,
      vector: {
        ...settings.store.vector,
        enabled: false,
      },
    },
  };
}

function resolveConfiguredMemoryEmbeddingProvider(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): string | undefined {
  const agentEntry = resolveAgentConfig(params.cfg, normalizeAgentId(params.agentId));
  return agentEntry?.memory?.search?.provider ?? params.cfg.memory?.search?.provider;
}

export function resolveMemoryEmbeddingProviderRequirement(params: {
  cfg: OpenClawConfig;
  agentId: string;
  settings: ResolvedMemorySearchConfig;
}): MemoryEmbeddingProviderRequirement {
  const configuredProvider = resolveConfiguredMemoryEmbeddingProvider(params)?.trim();
  if (params.settings.provider === "none" || configuredProvider === "none") {
    return { mode: "fts-only", provider: params.settings.provider };
  }
  const adapterTransport = resolveEmbeddingProviderAdapterTransport(
    params.settings.provider,
    params.cfg,
  );
  if (!configuredProvider || configuredProvider === "auto" || adapterTransport === "local") {
    return { mode: "optional", provider: params.settings.provider };
  }
  return {
    mode: "required",
    provider: params.settings.provider,
    configuredProvider,
  };
}

export abstract class MemoryProviderLifecycle extends MemoryManagerEmbeddingOps {
  protected abstract readonly cacheKey: string;
  protected abstract readonly purpose: "default" | "status" | "cli";
  protected abstract readonly providerRequirement: MemoryEmbeddingProviderRequirement;
  protected abstract readonly requestedProvider: EmbeddingProviderRequest;
  protected abstract providerInitPromise: Promise<void> | null;
  protected abstract providerInitialized: boolean;
  protected abstract providerRetirementPromise: Promise<void>;
  protected abstract providersPendingRetirement: Set<EmbeddingProvider>;
  protected abstract closing: boolean;
  protected abstract activeManagerOperations: number;
  protected abstract managerIdleWaiters: Set<() => void>;
  protected abstract indexIdentityDirty: boolean;
  protected abstract indexIdentityState: MemoryIndexIdentityState;
  protected abstract syncAdmitted(
    params?: MemorySyncParams,
    options?: { allowEmbeddingBootstrapFallback?: boolean; queuedSessionOwner?: boolean },
  ): Promise<void>;

  protected applyProviderResult(providerResult: EmbeddingProviderResult): void {
    const providerState = resolveMemoryProviderState(providerResult);
    this.provider = providerState.provider;
    this.fallbackFrom = providerState.fallbackFrom;
    this.fallbackReason = providerState.fallbackReason;
    this.providerUnavailableReason = providerState.providerUnavailableReason;
    this.providerLifecycle = providerState.lifecycle;
    this.providerRuntime = providerState.providerRuntime;
    this.providerInitialized = true;
  }

  protected markEmbeddingBootstrapFailure(
    err: unknown,
    options?: { retainProvider?: boolean; provider?: string },
  ): MemoryEmbeddingBootstrapDebug {
    const rawErrorName = readErrorName(err).trim();
    const errorName = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawErrorName) ? rawErrorName : "";
    const message =
      redactSensitiveText(formatErrorMessage(err), { mode: "tools" }).trim() ||
      "embedding provider initialization failed";
    const reason = redactSensitiveText(
      errorName && errorName !== "Error" ? `${errorName}: ${message}` : message,
      { mode: "tools" },
    );
    // settings.provider is already resolved from "auto"; never trust an unknown
    // error object's provider-shaped field for public diagnostics.
    const provider = options?.provider ?? this.provider?.id ?? this.settings.provider;
    const debug: MemoryEmbeddingBootstrapDebug = {
      ok: false,
      provider,
      reason,
      degradedTo: "keyword-only",
    };
    if (!options?.retainProvider) {
      this.provider = null;
      this.providerRuntime = undefined;
    }
    const backoffMs = resolveEmbeddingProbeFailureBackoffMs(err);
    const errorFacts = readRemoteProviderErrorFacts(err);
    this.providerInitialized = true;
    this.providerUnavailableReason = reason;
    this.providerLifecycle = createDegradedMemoryProviderLifecycle({
      providerId: provider,
      reason,
      code: errorFacts.code ?? errorFacts.errorType,
      retryAtMs: Date.now() + backoffMs,
    });
    this.embeddingBootstrapFailure = debug;
    this.providerKey = this.computeProviderKey();
    this.batch = this.resolveBatchConfig();
    this.vector.semanticAvailable = false;
    this.cacheProbeResult({ ok: false, error: reason }, { ttlMs: backoffMs });
    return debug;
  }

  protected async ensureEmbeddingProviderForSearch(
    onDebug?: (debug: MemorySearchRuntimeDebug) => void,
  ): Promise<boolean> {
    const failure = this.embeddingBootstrapFailure;
    if (failure) {
      const cached = this.getCachedEmbeddingAvailability();
      if (cached?.ok === false) {
        onDebug?.({ backend: "builtin", embeddingBootstrap: failure });
        return true;
      }
    }
    try {
      await this.ensureProviderInitialized();
    } catch (err) {
      if (this.providerRequirement.mode !== "optional") {
        throw err;
      }
      const nextFailure = this.markEmbeddingBootstrapFailure(err);
      onDebug?.({ backend: "builtin", embeddingBootstrap: nextFailure });
      return true;
    }
    if (!failure) {
      return false;
    }
    if (!this.provider) {
      const nextFailure: MemoryEmbeddingBootstrapDebug = {
        ...failure,
        reason: this.providerUnavailableReason ?? failure.reason,
      };
      this.embeddingBootstrapFailure = nextFailure;
      this.cacheProbeResult({ ok: false, error: nextFailure.reason });
      onDebug?.({ backend: "builtin", embeddingBootstrap: nextFailure });
      return true;
    }

    const currentIdentity = this.refreshIndexIdentityDirty({ providerKeyKnown: true });
    let activeFailure = failure;
    if (currentIdentity.status !== "valid") {
      try {
        await this.syncAdmitted({ reason: "search", force: true });
      } catch (err) {
        const message = redactSensitiveText(formatErrorMessage(err), { mode: "tools" });
        log.warn(`memory sync failed (embedding-bootstrap-recovery): ${message}`);
        activeFailure = this.markEmbeddingBootstrapFailure(err, { retainProvider: true });
      }
    }
    if (
      this.refreshIndexIdentityDirty({ providerKeyKnown: true }).status === "valid" &&
      (await this.confirmEmbeddingBootstrapRecovery())
    ) {
      // A valid existing index skips recovery reindex, so explicitly restore the
      // semantic readiness flag cleared when bootstrap degradation began.
      this.vector.semanticAvailable = await this.probeVectorStoreAvailabilityAdmitted();
      this.clearEmbeddingBootstrapFailureAfterRecovery();
      return false;
    }
    activeFailure = this.embeddingBootstrapFailure ?? activeFailure;
    onDebug?.({ backend: "builtin", embeddingBootstrap: activeFailure });
    return true;
  }

  protected clearEmbeddingBootstrapFailureAfterRecovery(): void {
    this.embeddingBootstrapFailure = undefined;
    this.providerUnavailableReason = undefined;
    if (this.provider) {
      this.providerLifecycle = this.fallbackFrom
        ? {
            mode: "fallback-active",
            providerId: this.provider.id,
            fallbackFrom: this.fallbackFrom,
            reason: this.fallbackReason ?? "fallback activated",
          }
        : { mode: "active", providerId: this.provider.id };
    }
    EMBEDDING_PROBE_CACHE.delete(this.cacheKey);
  }

  protected async confirmEmbeddingBootstrapRecovery(): Promise<boolean> {
    const cached = this.getCachedEmbeddingAvailability();
    if (cached) {
      return cached.ok;
    }
    if (!this.provider) {
      return false;
    }
    try {
      await this.embedBatchWithRetry(["ping"]);
      this.cacheProbeResult({ ok: true });
      return true;
    } catch (err) {
      this.markEmbeddingBootstrapFailure(err, {
        retainProvider: true,
        provider: this.provider.id,
      });
      return false;
    }
  }

  protected async ensureProviderInitialized(): Promise<void> {
    if (this.providerInitialized) {
      const bootstrapRetryDue =
        this.embeddingBootstrapFailure !== undefined &&
        !this.provider &&
        this.getCachedEmbeddingAvailability() === null;
      if (!bootstrapRetryDue) {
        await this.getPendingFallbackProviderInitialization()?.catch(() => undefined);
        return;
      }
      this.resetProviderInitializationForRetry();
    }
    if (this.settings.provider === "none") {
      this.applyProviderResult({
        provider: null,
        requestedProvider: "none",
        providerUnavailableReason: "No embedding provider available (FTS-only mode)",
      });
      this.providerKey = this.computeProviderKey();
      this.batch = this.resolveBatchConfig();
      return;
    }
    if (!this.providerInitPromise) {
      this.providerInitPromise = (async () => {
        await this.getPendingFallbackProviderInitialization()?.catch(() => undefined);
        await this.retireCurrentProvider();
        if (this.closed) {
          return;
        }
        const providerResult = await createEmbeddingProvider({
          config: this.cfg,
          agentDir: resolveAgentDir(this.cfg, this.agentId),
          ...(this.acquireLocalService ? { acquireLocalService: this.acquireLocalService } : {}),
          ...resolveMemoryPrimaryProviderRequest({ settings: this.settings }),
        });
        this.applyProviderResult(providerResult);
        this.providerKey = this.computeProviderKey();
        this.batch = this.resolveBatchConfig();
      })();
    }
    try {
      await this.providerInitPromise;
    } catch (err) {
      // Clear the cached rejected promise so subsequent calls can retry
      // initialization instead of being permanently stuck with a stale failure.
      this.providerInitPromise = null;
      throw err;
    } finally {
      if (this.providerInitialized) {
        this.providerInitPromise = null;
      }
    }
  }

  protected resetProviderInitializationForRetry(): void {
    void this.retireCurrentProvider();
    this.providerInitialized = false;
    this.providerInitPromise = null;
    this.providerUnavailableReason = undefined;
    this.providerLifecycle = createPendingMemoryProviderLifecycle(this.requestedProvider);
  }

  protected markEmbeddingProviderDegraded(err: unknown): void {
    if (this.provider?.id === "local") {
      const message = formatErrorMessage(err);
      const degradedProvider = this.provider;
      void this.retireCurrentProvider();
      this.providerUnavailableReason = `Local embeddings degraded: ${message}`;
      this.providerLifecycle = createDegradedMemoryProviderLifecycle({
        providerId: degradedProvider.id,
        reason: message,
      });
      EMBEDDING_PROBE_CACHE.delete(this.cacheKey);
      this.providerKey = this.computeProviderKey();
      this.batch = this.resolveBatchConfig();
      this.vector.semanticAvailable = false;
      log.warn("memory embeddings: local provider degraded after transport failure", {
        error: message,
      });
      return;
    }
    // Remote providers degrade only on account-level rejections (quota,
    // billing, auth): request-scoped 4xx must not pause the whole provider,
    // and required mode stays fail-fast so a broken explicit provider remains
    // operator-visible instead of silently dropping to keyword search.
    if (
      !this.provider ||
      this.providerRequirement.mode !== "optional" ||
      !isMemoryEmbeddingProviderAccessError(err)
    ) {
      return;
    }
    this.markEmbeddingBootstrapFailure(err, {
      retainProvider: true,
      provider: this.provider.id,
    });
    log.warn("memory embeddings: provider access error; pausing embeddings until backoff expires", {
      provider: this.provider.id,
      error: this.providerUnavailableReason,
    });
  }

  protected override retireCurrentProvider(): Promise<void> {
    const provider = this.provider;
    if (provider) {
      this.provider = null;
      this.providerRuntime = undefined;
      this.providersPendingRetirement.add(provider);
    }
    if (this.providersPendingRetirement.size === 0) {
      return this.providerRetirementPromise;
    }
    // Provider replacement must wait for the previous worker to exit; otherwise
    // repeated retries can accumulate local workers on constrained hosts.
    const retirement = this.providerRetirementPromise
      .catch(() => {})
      .then(async () => {
        let firstError: unknown;
        let closeFailed = false;
        for (const pendingProvider of this.providersPendingRetirement) {
          try {
            await this.awaitProviderIdle(pendingProvider);
            await pendingProvider.close?.();
            this.providersPendingRetirement.delete(pendingProvider);
          } catch (err) {
            if (!closeFailed) {
              firstError = err;
            }
            closeFailed = true;
          }
        }
        if (closeFailed) {
          throw toErrorObject(firstError, "Embedding provider retirement failed");
        }
      });
    this.providerRetirementPromise = retirement;
    void retirement.catch((err: unknown) => {
      log.warn(`memory embeddings: failed to close previous provider: ${formatErrorMessage(err)}`);
    });
    return retirement;
  }

  protected async drainPendingProviderRetirements(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (
      let attempt = 0;
      attempt < 2 && (this.provider !== null || this.providersPendingRetirement.size > 0);
      attempt += 1
    ) {
      try {
        await this.retireCurrentProvider();
      } catch (err) {
        errors.push(err);
        log.warn(`memory close: pending manager work failed: ${formatErrorMessage(err)}`);
      }
    }
    return errors;
  }

  protected isRequiredProviderUnavailable(): boolean {
    return this.providerRequirement.mode === "required" && !this.provider;
  }

  protected buildRequiredProviderUnavailableError(operation: "search" | "sync"): Error {
    const registeredProviderIds = listRegisteredMemoryEmbeddingProviderAdapters()
      .map((adapter) => adapter.id)
      .toSorted();
    const registeredProviders =
      registeredProviderIds.length > 0 ? registeredProviderIds.join(",") : "none";
    const reason =
      this.providerUnavailableReason ??
      (this.providerLifecycle.mode === "fts-only"
        ? this.providerLifecycle.reason
        : "provider is unavailable");
    return new Error(
      `Memory ${operation} unavailable: embedding provider "${this.settings.provider}" is configured but unavailable. ` +
        `Reason: ${reason}. ` +
        `agentId=${this.agentId} purpose=${this.purpose} lifecycle=${JSON.stringify(this.providerLifecycle)} ` +
        `registeredMemoryEmbeddingProviders=${registeredProviders}`,
    );
  }

  protected assertRequiredProviderAvailable(operation: "search" | "sync"): void {
    if (this.isRequiredProviderUnavailable()) {
      const error = this.buildRequiredProviderUnavailableError(operation);
      this.resetProviderInitializationForRetry();
      throw error;
    }
  }

  protected refreshIndexIdentityDirty(params?: { providerKeyKnown?: boolean }) {
    const provider =
      this.settings.provider === "none"
        ? null
        : this.providerInitialized
          ? this.provider
            ? { id: this.provider.id, model: this.provider.model }
            : null
          : undefined;
    const state = this.resolveCurrentIndexIdentityState({
      ...(provider !== undefined ? { provider } : {}),
      providerKeyKnown: params?.providerKeyKnown,
    });
    this.indexIdentityState = state;
    this.indexIdentityDirty =
      state.status === "mismatched" ||
      (state.status === "missing" && (this.sources.has("memory") || this.hasIndexedChunks()));
    return state;
  }

  protected refreshKeywordFallbackIndexIdentity() {
    const meta = this.readMeta();
    const state = this.resolveCurrentIndexIdentityState({
      meta,
      provider: meta && meta.provider !== "none" ? { id: meta.provider, model: meta.model } : null,
      providerKeyKnown: false,
      vectorReady: false,
    });
    this.indexIdentityState = state;
    this.indexIdentityDirty =
      state.status === "mismatched" ||
      (state.status === "missing" && (this.sources.has("memory") || this.hasIndexedChunks()));
    return state;
  }

  protected async withManagerOperation<T>(run: () => Promise<T>): Promise<T> {
    if (this.closing || this.closed) {
      throw new Error("Memory index manager is closed");
    }
    this.activeManagerOperations += 1;
    try {
      return await run();
    } finally {
      this.activeManagerOperations -= 1;
      if (this.activeManagerOperations === 0) {
        const waiters = Array.from(this.managerIdleWaiters);
        this.managerIdleWaiters.clear();
        for (const resolve of waiters) {
          resolve();
        }
      }
    }
  }

  protected async awaitManagerIdle(): Promise<void> {
    if (this.activeManagerOperations === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.managerIdleWaiters.add(resolve);
    });
  }

  async probeVectorAvailability(): Promise<boolean> {
    return await this.withManagerOperation(async () => {
      if (!this.vector.enabled) {
        this.vector.semanticAvailable = false;
        return false;
      }
      await this.ensureProviderInitialized();
      // FTS-only mode: vector search not available
      if (!this.provider) {
        this.vector.semanticAvailable = false;
        return false;
      }
      const ready = await this.probeVectorStoreAvailabilityAdmitted();
      this.vector.semanticAvailable = ready;
      return ready;
    });
  }

  async probeVectorStoreAvailability(): Promise<boolean> {
    return await this.withManagerOperation(
      async () => await this.probeVectorStoreAvailabilityAdmitted(),
    );
  }

  private async probeVectorStoreAvailabilityAdmitted(): Promise<boolean> {
    if (!this.vector.enabled) {
      this.vector.available = false;
      return false;
    }
    return await this.ensureVectorReady();
  }

  protected cacheProbeResult(
    result: MemoryEmbeddingProbeResult,
    options?: { ttlMs?: number },
  ): MemoryEmbeddingProbeResult {
    const checkedAtMs = Date.now();
    EMBEDDING_PROBE_CACHE.set(this.cacheKey, {
      result,
      checkedAtMs,
      expireAtMs: checkedAtMs + (options?.ttlMs ?? EMBEDDING_PROBE_CACHE_TTL_MS),
    });
    return result;
  }

  getCachedEmbeddingAvailability(): MemoryEmbeddingProbeResult | null {
    const cached = EMBEDDING_PROBE_CACHE.get(this.cacheKey);
    if (!cached) {
      return null;
    }
    const nowMs = Date.now();
    if (nowMs >= cached.expireAtMs) {
      EMBEDDING_PROBE_CACHE.delete(this.cacheKey);
      return null;
    }
    return {
      ...cached.result,
      checked: true,
      cached: true,
      checkedAtMs: cached.checkedAtMs,
      cacheExpiresAtMs: cached.expireAtMs,
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return await this.withManagerOperation(async () => {
      const cached = this.getCachedEmbeddingAvailability();
      if (cached) {
        return cached;
      }
      await this.ensureProviderInitialized();
      // FTS-only mode: embeddings not available but search still works
      if (!this.provider) {
        return this.cacheProbeResult({
          ok: false,
          error:
            this.providerUnavailableReason ?? "No embedding provider available (FTS-only mode)",
        });
      }
      try {
        await this.embedBatchWithRetry(["ping"]);
        return this.cacheProbeResult({ ok: true });
      } catch (err) {
        const message = formatErrorMessage(err);
        return this.cacheProbeResult(
          { ok: false, error: message },
          { ttlMs: resolveEmbeddingProbeFailureBackoffMs(err) },
        );
      }
    });
  }
}
