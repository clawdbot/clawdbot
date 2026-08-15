// Memory Core plugin module owns primary provider recovery after fallback activation.
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  resolveAgentDir,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderResult,
  type EmbeddingProviderRuntime,
} from "./embeddings.js";
import {
  resolveEmbeddingTimeoutMs,
  runEmbeddingOperationWithTimeout,
} from "./manager-embedding-ops.js";
import {
  clearMemoryEmbeddingProbeCacheEntry,
  MemoryProviderLifecycle,
} from "./manager-provider-lifecycle.js";
import {
  resolveMemoryPrimaryProviderRequest,
  shouldAttemptPrimaryProviderRecovery,
} from "./manager-provider-state.js";
import { resolveMemoryIndexProviderIdentities } from "./manager-reindex-state.js";

const EMBEDDING_PROBE_CACHE_TTL_MS = 30_000;
const log = createSubsystemLogger("memory");

type PrimaryProviderRecoveryProbe = {
  provider: EmbeddingProvider;
  runtime?: EmbeddingProviderRuntime;
};

// While the recovery shadow build runs, the manager's write state points at
// the build's temp database. A search admitted during that window reads the
// still-live fallback-owned index through this snapshot instead.
type PrimaryRecoverySearchSnapshot = {
  db: DatabaseSync;
  ftsAvailable: boolean;
  vectorReady: Promise<boolean> | null;
};

export abstract class MemoryProviderRecovery extends MemoryProviderLifecycle {
  // Throttles primary-provider recovery attempts so a latched fallback does
  // not bring the network path back online every search call. Without this,
  // a transient remote outage permanently downgrades the in-gateway tool even
  // after the primary is reachable again (only a full process restart clears
  // the latch).
  private lastPrimaryRecoveryAttemptMs = 0;
  private primaryProviderRecoveryPromise: Promise<PrimaryProviderRecoveryProbe | null> | null =
    null;
  private pendingPrimaryRecoveryProbe: PrimaryProviderRecoveryProbe | null = null;
  private primaryRecoveryBuildSnapshot: PrimaryRecoverySearchSnapshot | null = null;
  protected primaryProviderRecoveryBackgroundPromise: Promise<void> | null = null;

  protected getActivePrimaryRecoveryBuildSnapshot(): PrimaryRecoverySearchSnapshot | null {
    return this.primaryRecoveryBuildSnapshot;
  }

  /**
   * Probes the configured primary embedding provider without touching the
   * manager's active provider or index state. Fallback searches keep running
   * against the fallback-owned index while the probe is in flight; the
   * recovered provider is applied later, only after the primary-owned shadow
   * index is built and validated.
   */
  protected async attemptPrimaryProviderRecovery(params: {
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<PrimaryProviderRecoveryProbe | null> {
    if (params.signal?.aborted) {
      throw params.signal.reason instanceof Error
        ? params.signal.reason
        : new Error("search aborted");
    }
    const pending = this.primaryProviderRecoveryPromise;
    if (pending) {
      return await this.waitForPrimaryProviderRecovery(pending, params.signal);
    }
    const nowMs = Date.now();
    if (
      !shouldAttemptPrimaryProviderRecovery({
        fallbackFrom: this.fallbackFrom,
        lastAttemptMs: this.lastPrimaryRecoveryAttemptMs,
        nowMs,
        throttleMs: EMBEDDING_PROBE_CACHE_TTL_MS,
        force: params.force,
      })
    ) {
      return null;
    }
    this.lastPrimaryRecoveryAttemptMs = nowMs;
    const recovery = this.withManagerOperation(async () => await this.probePrimaryProvider());
    this.primaryProviderRecoveryPromise = recovery;
    void recovery.then(
      (probe) => {
        if (this.primaryProviderRecoveryPromise === recovery) {
          this.primaryProviderRecoveryPromise = null;
        }
        // A caller that aborted its wait must not orphan the recovered
        // provider: keep the completed probe manager-owned until the
        // recovery transaction consumes it.
        if (probe) {
          const previous = this.pendingPrimaryRecoveryProbe;
          this.pendingPrimaryRecoveryProbe = probe;
          if (previous && previous !== probe) {
            this.retireRecoveredProvider(previous.provider);
          }
        }
      },
      () => {
        if (this.primaryProviderRecoveryPromise === recovery) {
          this.primaryProviderRecoveryPromise = null;
        }
      },
    );
    return await this.waitForPrimaryProviderRecovery(recovery, params.signal);
  }

  private async waitForPrimaryProviderRecovery(
    recovery: Promise<PrimaryProviderRecoveryProbe | null>,
    signal?: AbortSignal,
  ): Promise<PrimaryProviderRecoveryProbe | null> {
    if (!signal) {
      return await recovery;
    }
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("search aborted");
    }
    return await Promise.race([
      recovery,
      new Promise<PrimaryProviderRecoveryProbe | null>((_resolve, reject) => {
        const abort = () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error("search aborted"));
        };
        signal.addEventListener("abort", abort, { once: true });
        void recovery.then(
          () => signal.removeEventListener("abort", abort),
          () => signal.removeEventListener("abort", abort),
        );
      }),
    ]);
  }

  private async probePrimaryProvider(): Promise<PrimaryProviderRecoveryProbe | null> {
    let pendingProvider: EmbeddingProvider | null = null;
    const discardPending = (label: string): void => {
      const provider = pendingProvider;
      pendingProvider = null;
      if (provider && provider !== this.provider) {
        void this.retireProvider(provider).catch((err: unknown) => {
          log.debug(`memory embeddings: failed to close ${label}: ${String(err)}`);
        });
      }
    };
    try {
      const providerResult = await createEmbeddingProvider({
        config: this.cfg,
        agentDir: resolveAgentDir(this.cfg, this.agentId),
        ...(this.acquireLocalService ? { acquireLocalService: this.acquireLocalService } : {}),
        ...resolveMemoryPrimaryProviderRequest({ settings: this.settings }),
        fallback: "none",
      });
      if (!providerResult.provider || providerResult.fallbackFrom) {
        pendingProvider = providerResult.provider;
        discardPending("discarded recovery probe");
        return null;
      }
      pendingProvider = providerResult.provider;
      const pingProvider = providerResult.provider;
      const pingRuntime = providerResult.runtime;
      const pingTimeoutMs = resolveEmbeddingTimeoutMs({
        kind: "query",
        providerId: pingProvider.id,
        providerRuntime: pingRuntime
          ? {
              inlineQueryTimeoutMs: pingRuntime.inlineQueryTimeoutMs,
              inlineBatchTimeoutMs: pingRuntime.inlineBatchTimeoutMs,
            }
          : undefined,
      });
      await runEmbeddingOperationWithTimeout({
        timeoutMs: pingTimeoutMs,
        message: `memory embeddings recovery ping timed out after ${Math.round(pingTimeoutMs / 1000)}s`,
        run: async (signal) => await pingProvider.embedQuery("ping", { signal }),
      });
      pendingProvider = null;
      return {
        provider: providerResult.provider,
        ...(providerResult.runtime ? { runtime: providerResult.runtime } : {}),
      };
    } catch (err) {
      discardPending("failed recovery probe");
      log.debug(
        `memory embeddings: primary recovery attempted but failed: ${formatErrorMessage(err)}`,
      );
      return null;
    }
  }

  private recoveredProviderMetaMatches(probe: PrimaryProviderRecoveryProbe): boolean {
    const meta = this.readMeta();
    if (!meta || meta.provider !== probe.provider.id || meta.model !== probe.provider.model) {
      return false;
    }
    const identities = resolveMemoryIndexProviderIdentities({
      provider: probe.provider,
      cacheKeyData: probe.runtime?.cacheKeyData,
      aliases: probe.runtime?.indexIdentityAliases,
    });
    const providerKey = identities[0]?.providerKey;
    return providerKey !== undefined && meta.providerKey === providerKey;
  }

  private async buildPrimaryProviderShadowIndex(
    probe: PrimaryProviderRecoveryProbe,
  ): Promise<boolean> {
    this.primaryRecoveryBuildSnapshot = {
      db: this.db,
      ftsAvailable: this.fts.available,
      vectorReady: this.vectorReady,
    };
    try {
      // A forced sync may join a fallback-owned sync that was already in
      // flight when recovery completed. Recheck after that join and admit one
      // fresh primary generation so recovery cannot cut over onto a stale
      // fallback-owned index.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.syncAdmitted(
            { reason: "search", force: true },
            {
              suppressFallbackActivation: true,
              providerGeneration: {
                provider: probe.provider,
                ...(probe.runtime ? { runtime: probe.runtime } : {}),
              },
            },
          );
        } catch (err) {
          log.warn(`memory sync failed (primary-recovery-reindex): ${formatErrorMessage(err)}`);
        }
        if (this.recoveredProviderMetaMatches(probe)) {
          return true;
        }
      }
      return false;
    } finally {
      this.primaryRecoveryBuildSnapshot = null;
    }
  }

  private retireRecoveredProvider(provider: EmbeddingProvider | null): void {
    if (!provider || provider === this.provider) {
      return;
    }
    void this.retireProvider(provider).catch((err: unknown) => {
      log.debug(`memory embeddings: failed to retire failed primary recovery: ${String(err)}`);
    });
  }

  private async commitPrimaryProviderRecovery(probe: PrimaryProviderRecoveryProbe): Promise<void> {
    await this.withManagerExclusiveOperation(async () => {
      if (!this.recoveredProviderMetaMatches(probe)) {
        this.retireRecoveredProvider(probe.provider);
        return;
      }
      const previousProvider = this.provider;
      const providerResult: EmbeddingProviderResult = {
        provider: probe.provider,
        requestedProvider: this.requestedProvider ?? this.settings.provider,
        ...(probe.runtime ? { runtime: probe.runtime } : {}),
      };
      this.applyProviderResult(providerResult);
      this.providerKey = this.computeProviderKey();
      this.batch = this.resolveBatchConfig();
      this.lastPrimaryRecoveryAttemptMs = 0;
      clearMemoryEmbeddingProbeCacheEntry(this.cacheKey);
      this.refreshIndexIdentityDirty({ providerKeyKnown: true });
      if (previousProvider && previousProvider !== this.provider) {
        void this.retireProvider(previousProvider).catch((err: unknown) => {
          log.debug(`memory embeddings: failed to retire recovered fallback: ${String(err)}`);
        });
      }
      log.info(
        `memory embeddings: recovered primary provider (${probe.provider.id}) from fallback`,
      );
    });
  }

  private async runPrimaryProviderRecoveryTransaction(): Promise<void> {
    const probe =
      this.consumePendingPrimaryRecoveryProbe() ?? (await this.attemptPrimaryProviderRecovery({}));
    if (!probe) {
      return;
    }
    // The awaited attempt may have re-stored the probe for a caller that
    // aborted; this transaction owns it from here on.
    this.pendingPrimaryRecoveryProbe = null;
    if (!(await this.buildPrimaryProviderShadowIndex(probe))) {
      this.retireRecoveredProvider(probe.provider);
      return;
    }
    await this.commitPrimaryProviderRecovery(probe);
  }

  private consumePendingPrimaryRecoveryProbe(): PrimaryProviderRecoveryProbe | null {
    const probe = this.pendingPrimaryRecoveryProbe;
    this.pendingPrimaryRecoveryProbe = null;
    return probe;
  }

  protected schedulePrimaryProviderRecovery(): void {
    if (
      !this.fallbackFrom ||
      this.closing ||
      this.closed ||
      this.primaryProviderRecoveryBackgroundPromise
    ) {
      return;
    }
    // The probe and shadow reindex both run outside the manager-exclusive
    // gate, so healthy fallback searches keep serving results until the final
    // provider/index cutover.
    const recovery = (async () => {
      if (!this.closing && !this.closed) {
        await this.runPrimaryProviderRecoveryTransaction();
      }
    })();
    this.primaryProviderRecoveryBackgroundPromise = recovery;
    void recovery
      .catch((err: unknown) => {
        log.warn(`memory background primary recovery failed: ${formatErrorMessage(err)}`);
      })
      .finally(() => {
        if (this.primaryProviderRecoveryBackgroundPromise === recovery) {
          this.primaryProviderRecoveryBackgroundPromise = null;
        }
      });
  }
}
