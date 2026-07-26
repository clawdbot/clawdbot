import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MemorySyncParams } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveExpiresAtMsFromDurationMs } from "openclaw/plugin-sdk/number-runtime";
import {
  PluginStateLeaseError,
  type PluginStateLeaseContext,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { asQmdAbortError, isSqliteBusyError } from "./qmd-command-errors.js";
import { QmdManagerBase, qmdManagerLog } from "./qmd-manager-base.js";
import {
  getQmdEmbedQueueState,
  getQmdUpdateQueueState,
  isEmbedBackoffActive,
  qmdUsesVectors,
  QMD_EMBED_BACKOFF_BASE_MS,
  QMD_EMBED_BACKOFF_MAX_MS,
  resolveQmdEmbedLeaseOptions,
  resolveQmdStoreWriteLeaseOptions,
  resolveStableJitterMs,
} from "./qmd-manager-helpers.js";

export abstract class QmdManagerSync extends QmdManagerBase {
  async sync(params?: MemorySyncParams): Promise<void> {
    if (
      params?.sessions?.some((session) => session.sessionId.trim().length > 0) ||
      params?.archiveFiles?.some((sessionFile) => sessionFile.trim().length > 0)
    ) {
      qmdManagerLog.debug("qmd sync ignoring targeted session hint; running regular update");
    }
    if (params?.progress) {
      params.progress({ completed: 0, total: 1, label: "Updating QMD index…" });
    }
    await this.runUpdate(params?.reason ?? "manual", params?.force);
    if (params?.progress) {
      params.progress({ completed: 1, total: 1, label: "QMD index updated" });
    }
  }

  protected async runUpdate(
    reason: string,
    force?: boolean,
    opts?: { fromForcedQueue?: boolean },
  ): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.pendingUpdate) {
      if (force) {
        return this.enqueueForcedUpdate(reason);
      }
      return this.pendingUpdate;
    }
    if (this.queuedForcedUpdate && !opts?.fromForcedQueue) {
      if (force) {
        return this.enqueueForcedUpdate(reason);
      }
      return this.queuedForcedUpdate;
    }
    if (this.shouldSkipUpdate(force)) {
      return;
    }
    const run = async () => {
      const startTime = Date.now();
      let updatePublished = false;
      qmdManagerLog.debug(
        `qmd sync started for agent "${this.agentId}" reason=${reason} force=${force === true}`,
      );
      try {
        await this.withQmdUpdateQueue(async (lease) => {
          const { signal } = lease;
          if (this.closed) {
            return;
          }
          if (this.sessionExporter) {
            await this.exportSessions(lease);
            this.throwIfAborted(signal);
          }
          await this.runQmdUpdateWithRetry(reason, lease);
          updatePublished = true;
          if (this.sessionExporter) {
            this.throwIfAborted(signal);
            this.refreshSessionArtifactDocIds(lease);
          }
        });
      } catch (err) {
        if (err instanceof PluginStateLeaseError && this.shouldPreserveLeaseRetry(err)) {
          this.dirty = true;
          if (updatePublished && qmdUsesVectors(this.qmd.searchMode)) {
            this.embedLeaseRetryPending = true;
          }
        }
        throw err;
      }
      if (this.closed) {
        return;
      }
      this.dirty = false;
      if (this.shouldRunEmbed(force)) {
        try {
          // Wait for embed capacity before taking the per-agent write lease. The
          // lease should protect active qmd writes only, not time spent queued
          // behind unrelated agents' embeds.
          const embedded = await this.withQmdEmbedQueue(async () => {
            await this.withQmdGlobalEmbedLease((globalLease) =>
              this.withQmdStoreWriteLease(async (lease) => {
                globalLease.assertOwned();
                lease.assertOwned();
                await this.runQmd(["embed"], {
                  timeoutMs: this.qmd.update.embedTimeoutMs,
                  discardOutput: true,
                  signal: lease.signal,
                });
              }, globalLease.signal),
            );
          });
          if (!embedded) {
            return;
          }
          this.lastEmbedAt = Date.now();
          this.embedLeaseRetryPending = false;
          this.embedBackoffUntil = null;
          this.embedFailureCount = 0;
        } catch (err) {
          if (err instanceof PluginStateLeaseError) {
            if (this.shouldPreserveLeaseRetry(err)) {
              // The update already published documents. Keep both the dirty-sync
              // trigger and embed intent so contention cannot strand them unembedded.
              this.dirty = true;
              this.embedLeaseRetryPending = true;
            }
            throw err;
          }
          this.noteEmbedFailure(reason, err);
        }
      }
      if (this.closed) {
        return;
      }
      this.lastUpdateAt = Date.now();
      this.documentResolver.clearCache();
      qmdManagerLog.info(
        `qmd sync completed for agent "${this.agentId}" reason=${reason} durationMs=${Date.now() - startTime}`,
      );
    };
    this.pendingUpdate = run().finally(() => {
      this.pendingUpdate = null;
    });
    await this.pendingUpdate;
  }

  protected async runQmdUpdateWithRetry(
    reason: string,
    lease: PluginStateLeaseContext,
  ): Promise<void> {
    const { signal } = lease;
    const isBootRun = reason === "boot" || reason.startsWith("boot:");
    const maxAttempts = isBootRun ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.runQmdUpdateOnce(reason, lease);
        return;
      } catch (err) {
        if (attempt >= maxAttempts || !this.isRetryableUpdateError(err)) {
          throw err;
        }
        const delayMs = 500 * 2 ** (attempt - 1);
        qmdManagerLog.warn(
          `qmd update retry ${attempt}/${maxAttempts - 1} after failure (${reason}): ${String(err)}`,
        );
        await this.waitForRetryDelay(delayMs, signal);
      }
    }
  }

  protected async runQmdUpdateOnce(reason: string, lease: PluginStateLeaseContext): Promise<void> {
    const { signal } = lease;
    try {
      lease.assertOwned();
      await this.runQmd(["update"], {
        timeoutMs: this.qmd.update.updateTimeoutMs,
        discardOutput: true,
        signal,
      });
    } catch (err) {
      if (
        !(await this.tryRepairNullByteCollections(err, reason, lease)) &&
        !(await this.tryRepairDuplicateDocumentConstraint(err, reason, lease))
      ) {
        throw err;
      }
      lease.assertOwned();
      await this.runQmd(["update"], {
        timeoutMs: this.qmd.update.updateTimeoutMs,
        discardOutput: true,
        signal,
      });
    }
  }

  protected isRetryableUpdateError(err: unknown): boolean {
    if (isSqliteBusyError(err)) {
      return true;
    }
    const message = formatErrorMessage(err);
    const normalized = normalizeLowercaseStringOrEmpty(message);
    return normalized.includes("timed out");
  }

  protected throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw asQmdAbortError(signal);
    }
  }

  protected async waitForRetryDelay(delayMs: number, signal: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timeout);
        reject(asQmdAbortError(signal));
      };
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  protected shouldRunEmbed(force?: boolean): boolean {
    if (!qmdUsesVectors(this.qmd.searchMode)) {
      return false;
    }
    const now = Date.now();
    if (isEmbedBackoffActive(this.embedBackoffUntil)) {
      return false;
    }
    const embedIntervalMs = this.qmd.update.embedIntervalMs;
    return (
      this.embedLeaseRetryPending ||
      Boolean(force) ||
      this.lastEmbedAt === null ||
      (embedIntervalMs > 0 && now - this.lastEmbedAt > embedIntervalMs)
    );
  }

  protected shouldPreserveLeaseRetry(err: PluginStateLeaseError): boolean {
    return (
      !this.closed &&
      err.code !== "PLUGIN_STATE_LEASE_ABORTED" &&
      err.code !== "PLUGIN_STATE_LEASE_INVALID_INPUT"
    );
  }

  protected shouldScheduleEmbedTimer(): boolean {
    if (!qmdUsesVectors(this.qmd.searchMode)) {
      return false;
    }
    const embedIntervalMs = this.qmd.update.embedIntervalMs;
    if (embedIntervalMs <= 0) {
      return false;
    }
    const updateIntervalMs = this.qmd.update.intervalMs;
    return updateIntervalMs <= 0 || updateIntervalMs > embedIntervalMs;
  }

  protected resolveEmbedStartupJitterMs(): number {
    const windowMs = this.qmd.update.embedIntervalMs;
    if (windowMs <= 0) {
      return 0;
    }
    const customCollections = this.qmd.collections
      .filter((collection) => collection.kind === "custom")
      .map((collection) => `${collection.path}\u0000${collection.pattern}`)
      .toSorted()
      .join("\u0001");
    if (!customCollections) {
      return 0;
    }
    return resolveStableJitterMs({
      seed: `${this.agentId}:${customCollections}`,
      windowMs,
    });
  }

  protected async withQmdEmbedQueue(task: () => Promise<void>): Promise<boolean> {
    const queue = getQmdEmbedQueueState();
    const previous = queue.tail;
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    queue.tail = previous.then(
      () => current,
      () => current,
    );
    try {
      const waitResult = await Promise.race([
        previous.then(
          () => "ready" as const,
          () => "ready" as const,
        ),
        this.closeSignal.then(() => "closed" as const),
      ]);
      if (waitResult === "closed") {
        return false;
      }
      await task();
      return true;
    } finally {
      releaseCurrent();
    }
  }

  protected async withQmdGlobalEmbedLease<T>(
    task: (lease: PluginStateLeaseContext) => Promise<T>,
  ): Promise<T> {
    return await this.withLease(
      {
        namespace: "qmd",
        key: "embed",
        database: { scope: "shared" },
        ...resolveQmdEmbedLeaseOptions(this.qmd.update.embedTimeoutMs),
        signal: this.closeAbortController.signal,
      },
      async (lease) => await task(lease),
    );
  }

  protected async withQmdStoreWriteLease<T>(
    task: (lease: PluginStateLeaseContext) => Promise<T>,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    // SQLite is the sole coordinator; never dual-lock sidecars. One per-agent
    // lease guards every write to index.sqlite while agents remain parallel.
    return await this.withLease(
      {
        namespace: "qmd",
        key: "write",
        database: { scope: "agent", agentId: this.agentId },
        ...resolveQmdStoreWriteLeaseOptions(
          this.qmd.update.updateTimeoutMs,
          this.qmd.update.embedTimeoutMs,
        ),
        signal: parentSignal
          ? AbortSignal.any([this.closeAbortController.signal, parentSignal])
          : this.closeAbortController.signal,
      },
      async (lease) => await task(lease),
    );
  }

  protected async withQmdUpdateQueue<T>(
    task: (lease: PluginStateLeaseContext) => Promise<T>,
  ): Promise<T> {
    const queue = getQmdUpdateQueueState();
    const key = this.qmdDir;
    const previous = queue.tails.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const next = previous.then(
      () => current,
      () => current,
    );
    queue.tails.set(key, next);
    try {
      const waitResult = await Promise.race([
        previous.then(
          () => "ready" as const,
          () => "ready" as const,
        ),
        this.closeSignal.then(() => "closed" as const),
      ]);
      if (waitResult === "closed") {
        return undefined as T;
      }
      // The in-process queue is keyed per store; the per-agent write lease also
      // serializes separate processes and embed writes targeting this index.
      return await this.withQmdStoreWriteLease(task);
    } finally {
      releaseCurrent();
      void next.finally(() => {
        if (queue.tails.get(key) === next) {
          queue.tails.delete(key);
        }
      });
    }
  }

  protected noteEmbedFailure(reason: string, err: unknown): void {
    this.embedFailureCount += 1;
    const delayMs = Math.min(
      QMD_EMBED_BACKOFF_MAX_MS,
      QMD_EMBED_BACKOFF_BASE_MS * 2 ** Math.max(0, this.embedFailureCount - 1),
    );
    this.embedBackoffUntil = resolveExpiresAtMsFromDurationMs(delayMs) ?? null;
    qmdManagerLog.warn(
      `qmd embed failed (${reason}): ${String(err)}; backing off for ${Math.ceil(delayMs / 1000)}s`,
    );
  }

  protected enqueueForcedUpdate(reason: string): Promise<void> {
    this.queuedForcedRuns += 1;
    if (!this.queuedForcedUpdate) {
      this.queuedForcedUpdate = this.drainForcedUpdates(reason).finally(() => {
        this.queuedForcedUpdate = null;
      });
    }
    return this.queuedForcedUpdate;
  }

  protected async drainForcedUpdates(reason: string): Promise<void> {
    await this.pendingUpdate?.catch(() => undefined);
    while (!this.closed && this.queuedForcedRuns > 0) {
      this.queuedForcedRuns -= 1;
      await this.runUpdate(`${reason}:queued`, true, { fromForcedQueue: true });
    }
  }

  protected shouldSkipUpdate(force?: boolean): boolean {
    if (force) {
      return false;
    }
    const debounceMs = this.qmd.update.debounceMs;
    if (debounceMs <= 0 || !this.lastUpdateAt) {
      return false;
    }
    return Date.now() - this.lastUpdateAt < debounceMs;
  }

  protected async exportSessions(lease: PluginStateLeaseContext): Promise<void> {
    await this.sessionExporter?.exportSessions(lease);
  }

  protected refreshSessionArtifactDocIds(lease: PluginStateLeaseContext): void {
    this.sessionExporter?.refreshArtifactDocIds(lease);
  }
}
