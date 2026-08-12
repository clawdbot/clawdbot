// Memory Core plugin module owns primary provider recovery after fallback activation.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  resolveAgentDir,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderRuntime,
} from "./embeddings.js";
import {
  resolveEmbeddingTimeoutMs,
  runEmbeddingOperationWithTimeout,
} from "./manager-embedding-ops.js";
import {
  clearMemoryEmbeddingProbeCacheEntry,
  MemoryProviderLifecycle,
  type MemoryEmbeddingBootstrapDebug,
} from "./manager-provider-lifecycle.js";
import {
  resolveMemoryPrimaryProviderRequest,
  shouldAttemptPrimaryProviderRecovery,
  type MemoryProviderLifecycleState,
} from "./manager-provider-state.js";
import type { MemoryIndexIdentityState } from "./manager-reindex-state.js";

const EMBEDDING_PROBE_CACHE_TTL_MS = 30_000;
const log = createSubsystemLogger("memory");

type PrimaryProviderRecoveryFallbackState = {
  provider: EmbeddingProvider;
  providerRuntime?: EmbeddingProviderRuntime;
  providerKey: string | null;
  fallbackFrom?: string;
  fallbackReason?: string;
  providerUnavailableReason?: string;
  providerLifecycle: MemoryProviderLifecycleState;
  providerInitialized: boolean;
  embeddingBootstrapFailure?: MemoryEmbeddingBootstrapDebug;
};

export abstract class MemoryProviderRecovery extends MemoryProviderLifecycle {
  private primaryProviderRecoveryFallbackState: PrimaryProviderRecoveryFallbackState | null = null;
  // Throttles primary-provider recovery attempts so a latched fallback does
  // not bring the network path back online every search call. Without this,
  // a transient remote outage permanently downgrades the in-gateway tool even
  // after the primary is reachable again (only a full process restart clears
  // the latch).
  private lastPrimaryRecoveryAttemptMs = 0;
  private primaryProviderRecoveryPromise: Promise<boolean> | null = null;
  protected primaryProviderRecoveryBackgroundPromise: Promise<void> | null = null;

  /**
   * Attempts to restore the configured primary embedding provider after a
   * fallback was activated. Returns true when the primary is reachable again
   * and the manager has switched back.
   *
   * Without this, a single transient outage permanently latches the in-gateway
   * memory tool onto the fallback provider. The index is keyed by the original
   * model identity, so subsequent searches fail identity validation until the
   * gateway process fully restarts. In-process restarts and config soft-reloads
   * reuse the singleton manager instance and must recover explicitly.
   */
  protected async attemptPrimaryProviderRecovery(params: {
    force?: boolean;
    signal?: AbortSignal;
    admitted?: boolean;
    transactional?: boolean;
  }): Promise<boolean> {
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
      return false;
    }
    this.lastPrimaryRecoveryAttemptMs = nowMs;
    const recovery = params.admitted
      ? this.attemptPrimaryProviderRecoveryOnce({ transactional: params.transactional })
      : this.withManagerOperation(
          async () =>
            await this.attemptPrimaryProviderRecoveryOnce({
              transactional: params.transactional,
            }),
        );
    this.primaryProviderRecoveryPromise = recovery;
    void recovery.then(
      () => {
        if (this.primaryProviderRecoveryPromise === recovery) {
          this.primaryProviderRecoveryPromise = null;
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
    recovery: Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!signal) {
      return await recovery;
    }
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("search aborted");
    }
    return await Promise.race([
      recovery,
      new Promise<boolean>((_resolve, reject) => {
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

  private async attemptPrimaryProviderRecoveryOnce(params?: {
    transactional?: boolean;
  }): Promise<boolean> {
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
        return false;
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
      const previousProvider = this.provider;
      const previousFallbackState =
        previousProvider && params?.transactional
          ? {
              provider: previousProvider,
              providerKey: this.providerKey,
              ...(this.providerRuntime ? { providerRuntime: this.providerRuntime } : {}),
              ...(this.fallbackFrom ? { fallbackFrom: this.fallbackFrom } : {}),
              ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}),
              ...(this.providerUnavailableReason
                ? { providerUnavailableReason: this.providerUnavailableReason }
                : {}),
              providerLifecycle: this.providerLifecycle,
              providerInitialized: this.providerInitialized,
              ...(this.embeddingBootstrapFailure
                ? { embeddingBootstrapFailure: this.embeddingBootstrapFailure }
                : {}),
            }
          : null;
      this.applyProviderResult(providerResult);
      this.providerKey = this.computeProviderKey();
      this.batch = this.resolveBatchConfig();
      pendingProvider = null;
      if (previousFallbackState) {
        this.primaryProviderRecoveryFallbackState = previousFallbackState;
      } else if (previousProvider && previousProvider !== this.provider) {
        void this.retireProvider(previousProvider);
      }
      clearMemoryEmbeddingProbeCacheEntry(this.cacheKey);
      log.info(
        `memory embeddings: recovered primary provider (${providerResult.provider.id}) from fallback`,
      );
      return true;
    } catch (err) {
      discardPending("failed recovery probe");
      log.debug(
        `memory embeddings: primary recovery attempted but failed: ${formatErrorMessage(err)}`,
      );
      return false;
    }
  }

  private async reindexAfterPrimaryProviderRecovery(
    recoveredProvider: EmbeddingProvider | null,
  ): Promise<MemoryIndexIdentityState> {
    let indexIdentity = this.refreshIndexIdentityDirty({ providerKeyKnown: true });
    // A forced sync may join a fallback-owned generation that was already active
    // when recovery completed. Recheck after that join and admit one fresh primary
    // generation so recovery cannot clear fallback state with a stale index.
    for (let attempt = 0; indexIdentity.status !== "valid" && attempt < 2; attempt += 1) {
      try {
        await this.syncAdmitted(
          { reason: "search", force: true },
          { suppressFallbackActivation: true },
        );
      } catch (err) {
        log.warn(`memory sync failed (primary-recovery-reindex): ${formatErrorMessage(err)}`);
      }
      indexIdentity = this.refreshIndexIdentityDirty({ providerKeyKnown: true });
    }
    if (indexIdentity.status === "valid" && this.provider !== recoveredProvider) {
      return {
        status: "mismatched",
        reason: "primary recovery reindex completed with a different active provider",
      };
    }
    return indexIdentity;
  }

  private commitPrimaryProviderRecovery(): void {
    const previous = this.primaryProviderRecoveryFallbackState;
    this.primaryProviderRecoveryFallbackState = null;
    this.lastPrimaryRecoveryAttemptMs = 0;
    if (previous && previous.provider !== this.provider) {
      void this.retireProvider(previous.provider).catch((err: unknown) => {
        log.debug(`memory embeddings: failed to retire recovered fallback: ${String(err)}`);
      });
    }
  }

  private async rollbackPrimaryProviderRecovery(): Promise<void> {
    const previous = this.primaryProviderRecoveryFallbackState;
    if (!previous) {
      return;
    }
    const failedPrimary = this.provider;
    this.provider = previous.provider;
    this.providerRuntime = previous.providerRuntime;
    this.providerKey = previous.providerKey;
    this.fallbackFrom = previous.fallbackFrom;
    this.fallbackReason = previous.fallbackReason;
    this.providerUnavailableReason = previous.providerUnavailableReason;
    this.providerLifecycle = previous.providerLifecycle;
    this.providerInitialized = previous.providerInitialized;
    this.embeddingBootstrapFailure = previous.embeddingBootstrapFailure;
    this.batch = this.resolveBatchConfig();
    this.primaryProviderRecoveryFallbackState = null;
    this.refreshIndexIdentityDirty({ providerKeyKnown: true });
    if (failedPrimary && failedPrimary !== previous.provider) {
      await this.retireProvider(failedPrimary).catch((err: unknown) => {
        log.debug(`memory embeddings: failed to retire failed primary recovery: ${String(err)}`);
      });
    }
  }

  private async runPrimaryProviderRecoveryTransaction(): Promise<void> {
    await this.withManagerExclusiveOperation(async () => {
      const recovered = await this.attemptPrimaryProviderRecovery({
        admitted: true,
        transactional: true,
      });
      if (!recovered) {
        return;
      }
      const recoveredProvider = this.provider;
      try {
        const identity = await this.reindexAfterPrimaryProviderRecovery(recoveredProvider);
        if (identity.status === "valid") {
          this.commitPrimaryProviderRecovery();
        } else {
          await this.rollbackPrimaryProviderRecovery();
        }
      } catch (err) {
        await this.rollbackPrimaryProviderRecovery();
        throw err;
      }
    });
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
    // A stalled primary probe must not block a healthy fallback result or the
    // caller's deadline; reindex only after the manager has recovered primary.
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
