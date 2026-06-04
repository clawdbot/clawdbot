/** Process-local ACP runtime handle cache with idle eviction and reuse checks. */
import {
  resolveRuntimeHandleIdentifiersFromIdentity,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import type {
  AcpRuntime,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
} from "@openclaw/acp-core/runtime/types";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import type { ActiveTurnState, SessionAcpMeta } from "./manager.types.js";
import { normalizeActorKey, resolveRuntimeIdleTtlMs } from "./manager.utils.js";
import { RuntimeCache, type CachedRuntimeState } from "./runtime-cache.js";
import { normalizeText } from "./runtime-options.js";
import type { SessionActorQueue } from "./session-actor-queue.js";

/** Process-local cache of live ACP runtime handles keyed by canonical session actor. */
export class ManagerRuntimeHandleCache {
  private readonly runtimeCache = new RuntimeCache();
  private evictedRuntimeCount = 0;
  private lastEvictedAt: number | undefined;

  size(): number {
    return this.runtimeCache.size();
  }

  has(sessionKey: string): boolean {
    return this.runtimeCache.has(normalizeActorKey(sessionKey));
  }

  get(sessionKey: string): CachedRuntimeState | null {
    return this.runtimeCache.get(normalizeActorKey(sessionKey));
  }

  set(sessionKey: string, state: CachedRuntimeState): void {
    this.runtimeCache.set(normalizeActorKey(sessionKey), state);
  }

  clear(sessionKey: string): void {
    this.runtimeCache.clear(normalizeActorKey(sessionKey));
  }

  /** Returns cache counters used by ACP manager observability snapshots. */
  getObservabilitySnapshot(cfg: OpenClawConfig) {
    return {
      activeSessions: this.runtimeCache.size(),
      idleTtlMs: resolveRuntimeIdleTtlMs(cfg),
      evictedTotal: this.evictedRuntimeCount,
      ...(this.lastEvictedAt ? { lastEvictedAt: this.lastEvictedAt } : {}),
    };
  }

  /** Closes and removes one cached runtime handle when present. */
  async close(params: { sessionKey: string; reason: string }): Promise<void> {
    const cached = this.get(params.sessionKey);
    if (!cached) {
      return;
    }
    try {
      await cached.runtime.close({
        handle: cached.handle,
        reason: params.reason,
      });
    } catch (error) {
      logVerbose(
        `acp-manager: cached runtime close failed for ${params.sessionKey}: ${String(error)}`,
      );
    } finally {
      this.clear(params.sessionKey);
    }
  }

  /** Clears a cached handle only when the caller still owns the same runtime identifiers. */
  clearIfHandleMatches(params: { sessionKey: string; handle: AcpRuntimeHandle }): void {
    const cached = this.get(params.sessionKey);
    if (!cached || !this.runtimeHandlesMatch(cached.handle, params.handle)) {
      return;
    }
    this.clear(params.sessionKey);
  }

  /** Closes handles that exceeded the configured idle TTL without racing active turns. */
  async evictIdle(params: {
    cfg: OpenClawConfig;
    actorQueue: SessionActorQueue;
    activeTurnBySession: Map<string, ActiveTurnState>;
  }): Promise<void> {
    const idleTtlMs = resolveRuntimeIdleTtlMs(params.cfg);
    if (idleTtlMs <= 0 || this.runtimeCache.size() === 0) {
      return;
    }
    const now = Date.now();
    const candidates = this.runtimeCache.collectIdleCandidates({
      maxIdleMs: idleTtlMs,
      now,
    });
    if (candidates.length === 0) {
      return;
    }

    for (const candidate of candidates) {
      // Evict under the same actor queue so turns cannot race with runtime close.
      await params.actorQueue.run(candidate.actorKey, async () => {
        if (params.activeTurnBySession.has(candidate.actorKey)) {
          return;
        }
        const lastTouchedAt = this.runtimeCache.getLastTouchedAt(candidate.actorKey);
        if (lastTouchedAt == null || now - lastTouchedAt < idleTtlMs) {
          return;
        }
        const cached = this.runtimeCache.peek(candidate.actorKey);
        if (!cached) {
          return;
        }
        this.runtimeCache.clear(candidate.actorKey);
        this.evictedRuntimeCount += 1;
        this.lastEvictedAt = Date.now();
        try {
          await cached.runtime.close({
            handle: cached.handle,
            reason: "idle-evicted",
          });
        } catch (error) {
          logVerbose(
            `acp-manager: idle eviction close failed for ${candidate.state.handle.sessionKey}: ${String(error)}`,
          );
        }
      });
    }
  }

  /** Checks whether a cached runtime handle is still healthy enough to reuse. */
  async isReusable(params: {
    sessionKey: string;
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
  }): Promise<boolean> {
    if (!params.runtime.getStatus) {
      return true;
    }
    try {
      const status = await params.runtime.getStatus({
        handle: params.handle,
      });
      if (isRuntimeStatusUnavailable(status)) {
        this.clear(params.sessionKey);
        logVerbose(
          `acp-manager: evicting cached runtime handle for ${params.sessionKey} after unhealthy status probe: ${status.summary ?? "status unavailable"}`,
        );
        return false;
      }
      return true;
    } catch (error) {
      this.clear(params.sessionKey);
      logVerbose(
        `acp-manager: evicting cached runtime handle for ${params.sessionKey} after status probe failed: ${String(error)}`,
      );
      return false;
    }
  }

  handleMatchesMeta(params: { handle: AcpRuntimeHandle; meta: SessionAcpMeta }): boolean {
    const identity = resolveSessionIdentityFromMeta(params.meta);
    const expectedHandleIds = resolveRuntimeHandleIdentifiersFromIdentity(identity);
    if ((params.handle.backendSessionId ?? "") !== (expectedHandleIds.backendSessionId ?? "")) {
      return false;
    }
    if ((params.handle.agentSessionId ?? "") !== (expectedHandleIds.agentSessionId ?? "")) {
      return false;
    }

    const expectedAcpxRecordId = identity?.acpxRecordId ?? "";
    const actualAcpxRecordId =
      normalizeText((params.handle as { acpxRecordId?: unknown }).acpxRecordId) ?? "";
    return actualAcpxRecordId === expectedAcpxRecordId;
  }

  private runtimeHandlesMatch(a: AcpRuntimeHandle, b: AcpRuntimeHandle): boolean {
    return (
      a.sessionKey === b.sessionKey &&
      a.backend === b.backend &&
      a.runtimeSessionName === b.runtimeSessionName &&
      (a.cwd ?? "") === (b.cwd ?? "") &&
      (a.acpxRecordId ?? "") === (b.acpxRecordId ?? "") &&
      (a.backendSessionId ?? "") === (b.backendSessionId ?? "") &&
      (a.agentSessionId ?? "") === (b.agentSessionId ?? "")
    );
  }
}

function isRuntimeStatusUnavailable(status: AcpRuntimeStatus | undefined): boolean {
  if (!status) {
    return false;
  }
  const detailsStatus = normalizeLowercaseStringOrEmpty(status.details?.status);
  if (detailsStatus === "dead" || detailsStatus === "no-session") {
    return true;
  }
  const summaryMatch = status.summary?.match(/\bstatus=([^\s]+)/i);
  const summaryStatus = normalizeLowercaseStringOrEmpty(summaryMatch?.[1]);
  return summaryStatus === "dead" || summaryStatus === "no-session";
}
