// Gateway maintenance timers.
// Starts periodic health, dedupe, abort, and media cleanup loops.
import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { createManagedWorktreeOwnerProtection } from "../agents/worktrees/owner-protection.js";
import {
  managedWorktrees,
  resolveWorktreeCleanupLimits,
  WORKTREE_GC_INTERVAL_MS,
} from "../agents/worktrees/service.js";
import type { HealthSummary } from "../commands/health.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sweepStaleRunContexts } from "../infra/agent-events.js";
import { cleanOldMedia } from "../media/store.js";
import { startSkillCuratorMaintenance } from "../skills/workshop/curator.js";
import {
  abortTrackedChatRunById,
  type ChatAbortControllerEntry,
  removeChatAbortControllerEntry,
  type RestartRecoveryCandidate,
} from "./chat-abort.js";
import type { QueuedChatTurnMap } from "./chat-queued-turns.js";
import { pruneStaleControlPlaneBuckets } from "./control-plane-rate-limit.js";
import { chatAbortMarkerTimestampMs } from "./server-chat-state.js";
import type { ChatRunState } from "./server-chat-state.js";
import type { ChatRunEntry } from "./server-chat.js";
import {
  DEDUPE_MAX,
  DEDUPE_TTL_MS,
  HEALTH_REFRESH_INTERVAL_MS,
  TICK_INTERVAL_MS,
} from "./server-constants.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX, type DedupeEntry } from "./server-shared.js";
import { formatError } from "./server-utils.js";
import { setBroadcastHealthUpdate } from "./server/health-state.js";

export function startGatewayMaintenanceTimers(params: {
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  nodeSendToAllSubscribed: (event: string, payload: unknown) => void;
  getPresenceVersion: () => number;
  getHealthVersion: () => number;
  refreshGatewayHealthSnapshot: (opts?: {
    probe?: boolean;
    includeSensitive?: boolean;
  }) => Promise<HealthSummary>;
  logHealth: { error: (msg: string) => void };
  dedupe: Map<string, DedupeEntry>;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatQueuedTurns: QueuedChatTurnMap;
  restartRecoveryCandidates: Map<string, RestartRecoveryCandidate>;
  chatRunState: Pick<
    ChatRunState,
    | "abortedRuns"
    | "bufferUpdatedAt"
    | "clearRun"
    | "deltaLastBroadcastText"
    | "agentDeltaSentAt"
    | "bufferedAgentEvents"
  >;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  chatDeltaLastBroadcastLen: Map<string, number>;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  agentRunSeq: Map<string, number>;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  mediaCleanupTtlMs?: number;
  getRuntimeConfig: () => OpenClawConfig;
  runWorktreeGc?: () => Promise<unknown>;
  enableSkillCurator?: boolean;
  runSkillCuratorSweep?: () => Promise<unknown>;
  registerSkillUsageTracking?: () => () => void;
}): {
  tickInterval: ReturnType<typeof setInterval>;
  healthInterval: ReturnType<typeof setInterval>;
  dedupeCleanup: ReturnType<typeof setInterval>;
  mediaCleanup: ReturnType<typeof setInterval> | null;
  worktreeCleanup: ReturnType<typeof setInterval>;
  skillCuratorCleanup: () => void;
} {
  setBroadcastHealthUpdate((snap: HealthSummary) => {
    params.broadcast("health", snap, {
      stateVersion: {
        presence: params.getPresenceVersion(),
        health: params.getHealthVersion(),
      },
    });
    params.nodeSendToAllSubscribed("health", snap);
  });

  // periodic keepalive
  const tickInterval = setInterval(() => {
    const payload = { ts: Date.now() };
    params.broadcast("tick", payload);
    params.nodeSendToAllSubscribed("tick", payload);
  }, TICK_INTERVAL_MS);

  // Keep cached health warm without request-time live channel probes. Explicit
  // status/doctor probe paths still pass probe=true when the operator asks.
  const healthInterval = setInterval(() => {
    void params
      .refreshGatewayHealthSnapshot({ probe: false })
      .catch((err: unknown) => params.logHealth.error(`refresh failed: ${formatError(err)}`));
  }, HEALTH_REFRESH_INTERVAL_MS);

  // Prime cache so first client gets a snapshot without waiting.
  void params
    .refreshGatewayHealthSnapshot({ probe: false })
    .catch((err: unknown) => params.logHealth.error(`initial refresh failed: ${formatError(err)}`));

  const runWorktreeGc =
    params.runWorktreeGc ??
    (() => {
      const cfg = params.getRuntimeConfig();
      return managedWorktrees.gc({
        // Chat runs avoid registry acquire/bump writes; recent session metadata substitutes for
        // worktree activity so idle GC cannot remove a checkout still used by the session.
        shouldProtectOwner: createManagedWorktreeOwnerProtection(cfg),
        // Read limits per run so a config edit applies at the next hourly sweep.
        limits: resolveWorktreeCleanupLimits(cfg.worktrees),
      });
    });
  const performWorktreeGc = () =>
    runWorktreeGc().catch((err: unknown) => {
      params.logHealth.error(`managed worktree cleanup failed: ${formatError(err)}`);
    });
  const worktreeCleanup = setInterval(() => void performWorktreeGc(), WORKTREE_GC_INTERVAL_MS);
  void performWorktreeGc();

  let skillCuratorCleanup = () => {};
  if (params.enableSkillCurator) {
    skillCuratorCleanup = startSkillCuratorMaintenance({
      onError: (err) => params.logHealth.error(`skill curator sweep failed: ${formatError(err)}`),
      registerUsageTracking: params.registerSkillUsageTracking,
      runSweep: params.runSkillCuratorSweep,
    });
  }

  // dedupe cache cleanup
  const dedupeCleanup = setInterval(() => {
    const AGENT_RUN_SEQ_MAX = 10_000;
    const now = Date.now();
    const resolveDedupeRunId = (key: string, entry: DedupeEntry) => {
      if (!key.startsWith("agent:") && !key.startsWith("chat:")) {
        return undefined;
      }
      const keyRunId = key.slice(key.indexOf(":") + 1);
      if (keyRunId) {
        if (params.chatAbortControllers.has(keyRunId) || params.chatQueuedTurns.has(keyRunId)) {
          return keyRunId;
        }
      }
      const payload = entry.payload;
      return payload && typeof payload === "object" && !Array.isArray(payload)
        ? typeof (payload as { runId?: unknown }).runId === "string"
          ? (payload as { runId: string }).runId.trim() || undefined
          : undefined
        : undefined;
    };
    const isPendingAcceptedRunDedupeKey = (key: string, dedupeEntry: DedupeEntry) => {
      if (!key.startsWith("agent:") && !key.startsWith(PENDING_CHAT_SEND_DEDUPE_PREFIX)) {
        return false;
      }
      const payload = dedupeEntry.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return false;
      }
      if ((payload as { status?: unknown }).status !== "accepted") {
        return false;
      }
      const expiresAtMs = (payload as { expiresAtMs?: unknown }).expiresAtMs;
      return isFutureDateTimestampMs(expiresAtMs, { nowMs: now });
    };
    const isActiveRunDedupeKey = (key: string, dedupeEntry: DedupeEntry) => {
      // Keep idempotency records for active runs so retries cannot create
      // duplicate chat/agent work while a command is still draining.
      const isAgentKey = key.startsWith("agent:");
      const isChatKey = key.startsWith("chat:");
      if (!isAgentKey && !isChatKey) {
        return false;
      }
      const runId = resolveDedupeRunId(key, dedupeEntry);
      const entry = runId ? params.chatAbortControllers.get(runId) : undefined;
      if (entry) {
        return isAgentKey ? entry.kind === "agent" : entry.kind !== "agent";
      }
      return Boolean(isChatKey && runId && params.chatQueuedTurns.has(runId));
    };
    for (const [k, v] of params.dedupe) {
      if (isActiveRunDedupeKey(k, v) || isPendingAcceptedRunDedupeKey(k, v)) {
        continue;
      }
      if (now - v.ts > DEDUPE_TTL_MS) {
        params.dedupe.delete(k);
      }
    }
    if (params.dedupe.size > DEDUPE_MAX) {
      const excess = params.dedupe.size - DEDUPE_MAX;
      const oldestKeys = [...params.dedupe.entries()]
        .filter(
          ([key, entry]) =>
            !isActiveRunDedupeKey(key, entry) && !isPendingAcceptedRunDedupeKey(key, entry),
        )
        .toSorted(([, left], [, right]) => left.ts - right.ts)
        .slice(0, excess)
        .map(([key]) => key);
      for (const key of oldestKeys) {
        params.dedupe.delete(key);
      }
    }

    if (params.agentRunSeq.size > AGENT_RUN_SEQ_MAX) {
      const excess = params.agentRunSeq.size - AGENT_RUN_SEQ_MAX;
      let removed = 0;
      for (const runId of params.agentRunSeq.keys()) {
        params.agentRunSeq.delete(runId);
        removed += 1;
        if (removed >= excess) {
          break;
        }
      }
    }

    const resolveAgentThrottleRunId = (key: string) => {
      if (key.endsWith(":assistant")) {
        return key.slice(0, -":assistant".length);
      }
      if (key.endsWith(":thinking")) {
        return key.slice(0, -":thinking".length);
      }
      return key;
    };

    for (const [runId, entry] of params.chatAbortControllers) {
      if (entry.projectSessionTerminalPending === true) {
        continue;
      }
      if (isFutureDateTimestampMs(entry.expiresAtMs, { nowMs: now })) {
        continue;
      }
      if (entry.projectSessionTerminalPersistence) {
        const lifecycleGeneration = entry.lifecycleGeneration?.trim();
        const sessionKey = entry.sessionKey.trim();
        const sessionId = entry.sessionId.trim();
        if (entry.controlUiVisible !== false && lifecycleGeneration && sessionKey && sessionId) {
          params.restartRecoveryCandidates.set(runId, {
            runId,
            lifecycleGeneration,
            sessionKey,
            sessionId,
            observedAt: entry.projectSessionTerminalObservedAt,
          });
        }
        removeChatAbortControllerEntry(params.chatAbortControllers, runId, entry);
        continue;
      }
      if (entry.projectSessionActive === false) {
        removeChatAbortControllerEntry(params.chatAbortControllers, runId, entry);
        continue;
      }
      abortTrackedChatRunById(params, {
        runId,
        sessionKey: entry.sessionKey,
        stopReason: "timeout",
      });
    }

    const ABORTED_RUN_TTL_MS = 60 * 60_000;
    for (const [runId, abortMarker] of params.chatRunState.abortedRuns) {
      if (now - chatAbortMarkerTimestampMs(abortMarker) <= ABORTED_RUN_TTL_MS) {
        continue;
      }
      params.chatRunState.abortedRuns.delete(runId);
      params.chatRunState.clearRun(runId);
    }

    // Prune expired control-plane rate-limit buckets to prevent unbounded
    // growth when many unique clients connect over time.
    pruneStaleControlPlaneBuckets(now);

    // Sweep stale buffers for runs that were never explicitly aborted.
    // Only reap orphaned buffers after the abort controller is gone; active
    // runs can legitimately sit idle while tools/models work.
    for (const [runId, lastSentAt] of params.chatDeltaSentAt) {
      if (params.chatRunState.abortedRuns.has(runId)) {
        continue; // already handled above
      }
      if (params.chatAbortControllers.has(runId)) {
        continue;
      }
      if (now - lastSentAt <= ABORTED_RUN_TTL_MS) {
        continue;
      }
      params.chatRunState.clearRun(runId);
    }
    for (const [runId, lastUpdatedAt] of params.chatRunState.bufferUpdatedAt) {
      if (params.chatRunState.abortedRuns.has(runId)) {
        continue;
      }
      if (params.chatAbortControllers.has(runId)) {
        continue;
      }
      if (now - lastUpdatedAt <= ABORTED_RUN_TTL_MS) {
        continue;
      }
      params.chatRunState.clearRun(runId);
    }
    for (const [key, lastSentAt] of params.chatRunState.agentDeltaSentAt) {
      const runId = resolveAgentThrottleRunId(key);
      if (params.chatRunState.abortedRuns.has(runId)) {
        continue;
      }
      if (params.chatAbortControllers.has(runId)) {
        continue;
      }
      if (now - lastSentAt <= ABORTED_RUN_TTL_MS) {
        continue;
      }
      params.chatRunState.clearRun(runId);
    }
    // Sweep stale agent run contexts (orphaned when lifecycle end/error is missed).
    sweepStaleRunContexts();
  }, 60_000);

  if (typeof params.mediaCleanupTtlMs !== "number") {
    return {
      tickInterval,
      healthInterval,
      dedupeCleanup,
      mediaCleanup: null,
      worktreeCleanup,
      skillCuratorCleanup,
    };
  }

  let mediaCleanupInFlight: Promise<void> | null = null;
  const runMediaCleanup = () => {
    if (mediaCleanupInFlight) {
      return mediaCleanupInFlight;
    }
    mediaCleanupInFlight = cleanOldMedia(params.mediaCleanupTtlMs, {
      recursive: true,
      pruneEmptyDirs: true,
    })
      .catch((err: unknown) => {
        params.logHealth.error(`media cleanup failed: ${formatError(err)}`);
      })
      .finally(() => {
        mediaCleanupInFlight = null;
      });
    return mediaCleanupInFlight;
  };

  const mediaCleanup = setInterval(() => {
    void runMediaCleanup();
  }, 60 * 60_000);

  void runMediaCleanup();

  return {
    tickInterval,
    healthInterval,
    dedupeCleanup,
    mediaCleanup,
    worktreeCleanup,
    skillCuratorCleanup,
  };
}
