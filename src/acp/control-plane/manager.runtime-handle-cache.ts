/** Process-local ACP runtime handle cache with lifecycle cleanup and reuse checks. */
import {
  resolveRuntimeHandleIdentifiersFromIdentity,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import type {
  AcpRuntime,
  AcpRuntimeHandle,
  AcpRuntimeSessionMode,
  AcpRuntimeStatus,
} from "@openclaw/acp-core/runtime/types";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { logVerbose } from "../../globals.js";
import { isAcpOwnerRepairRequired } from "./manager.runtime-owner.js";
import type { AcpSessionTarget, SessionAcpMeta } from "./manager.types.js";
import { acpSessionActorKey } from "./manager.utils.js";
import { normalizeText } from "./runtime-options.js";
import type { SessionActorQueue } from "./session-actor-queue.js";

/** Cached runtime handle plus the configuration signature that made it reusable. */
export type CachedRuntimeState = {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  backend: string;
  agent: string;
  mode: AcpRuntimeSessionMode;
  cwd?: string;
  configSignature: string;
  appliedControlSignature?: string;
};

/** Process-local cache of live ACP runtime handles keyed by canonical session actor. */
export class ManagerRuntimeHandleCache {
  private readonly runtimeCache = new Map<string, CachedRuntimeState>();

  get(target: AcpSessionTarget): CachedRuntimeState | null {
    return this.runtimeCache.get(acpSessionActorKey(target)) ?? null;
  }

  set(target: AcpSessionTarget, state: CachedRuntimeState): void {
    this.runtimeCache.set(acpSessionActorKey(target), state);
  }

  clear(target: AcpSessionTarget): void {
    this.runtimeCache.delete(acpSessionActorKey(target));
  }

  /** Returns cache counters used by ACP manager observability snapshots. */
  getObservabilitySnapshot() {
    return {
      activeSessions: this.runtimeCache.size,
      idleTtlMs: 0,
      evictedTotal: 0,
    };
  }

  /** Closes and removes one cached runtime handle when present. */
  async close(
    params: AcpSessionTarget & { reason: string; expectedHandle?: AcpRuntimeHandle },
  ): Promise<void> {
    const cached = this.get(params);
    if (!cached || (params.expectedHandle && cached.handle !== params.expectedHandle)) {
      return;
    }
    try {
      await cached.runtime.close({
        handle: cached.handle,
        reason: params.reason,
      });
    } catch (error) {
      if (params.expectedHandle && isAcpOwnerRepairRequired(error)) {
        throw error;
      }
      logVerbose(
        `acp-manager: cached runtime close failed for ${params.sessionKey}: ${String(error)}`,
      );
    } finally {
      this.clear(params);
    }
  }

  /** Drains every cached handle behind its session actor before process shutdown. */
  async closeAll(params: { actorQueue: SessionActorQueue; reason: string }): Promise<void> {
    await Promise.all(
      [...this.runtimeCache.keys()].map((actorKey) =>
        params.actorQueue.run(actorKey, async () => {
          const cached = this.runtimeCache.get(actorKey);
          if (!cached) {
            return;
          }
          try {
            await cached.runtime.close({ handle: cached.handle, reason: params.reason });
          } catch (error) {
            logVerbose(
              `acp-manager: cached runtime close failed for ${cached.handle.sessionKey}: ${String(error)}`,
            );
          } finally {
            this.runtimeCache.delete(actorKey);
          }
        }),
      ),
    );
  }

  /** Clears a cached handle only when the caller still owns the same runtime identifiers. */
  clearIfHandleMatches(params: AcpSessionTarget & { handle: AcpRuntimeHandle }): void {
    const cached = this.get(params);
    if (!cached || !this.runtimeHandlesMatch(cached.handle, params.handle)) {
      return;
    }
    this.clear(params);
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
        logVerbose(
          `acp-manager: evicting cached runtime handle for ${params.sessionKey} after unhealthy status probe: ${status.summary ?? "status unavailable"}`,
        );
        return false;
      }
      return true;
    } catch (error) {
      if (isAcpOwnerRepairRequired(error)) {
        throw error;
      }
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
      a.agentId === b.agentId &&
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
