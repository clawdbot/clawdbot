import { Buffer } from "node:buffer";
import type {
  WorkerLiveEventErrorDetails,
  WorkerLiveEventParams,
  WorkerLiveEventResult,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { onSessionIdentityMutation } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunContext,
  emitAgentEventIfCurrent,
  emitAgentEventForOwner,
  getAgentEventLifecycleGeneration,
  getAgentRunContext,
  getAgentRunContextOwnerStatus,
  registerAgentRunContext,
  releaseAgentRunContext,
} from "../../infra/agent-events.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  createWorkerLiveTrajectoryRecorder,
  isDefinitiveWorkerTerminalEvent,
  prepareWorkerLiveEventData,
  recordWorkerLiveTrajectoryEvent,
  type WorkerLiveTrajectoryRecorder,
} from "./live-event-projection.js";
import {
  isValidLiveSessionBinding,
  matchesSessionIdentityMutation,
  prepareBoundLiveSessionSafely,
  type BoundLiveSession,
  type LiveEventTarget,
  type WorkerLiveSessionBinding,
} from "./live-event-session-binding.js";

const DEFAULT_WINDOW_SIZE = 128;
const DEFAULT_MAX_PENDING_BYTES = 512 * 1024;
const DEFAULT_MAX_SESSIONS = 128;
const DEFAULT_MAX_ACTIVE_RUNS = 32;
const MAX_FENCED_ENVIRONMENTS = 4096;

type PendingLiveEvent = {
  request: WorkerLiveEventParams;
  sizeBytes: number;
};

type OwnedLiveRun = {
  claimId: string;
  controlUiVisible: boolean;
  emissionMode: "exclusive" | "shared";
  lifecycleGeneration: string;
  trajectoryRecorder: WorkerLiveTrajectoryRecorder;
};

type WorkerLiveCredentialRotation = Readonly<{
  credentialHash: string;
  environmentId: string;
  newProcessTurn?: boolean;
  previousCredentialHash: string;
  runEpoch: number;
  sessionId: string;
}>;

type LiveEventWindow = {
  activeRuns: Map<string, OwnedLiveRun>;
  ackedSeq: number;
  credentialHash: string;
  environmentId: string;
  pending: Map<number, PendingLiveEvent>;
  pendingBytes: number;
  runEpoch: number;
  sessionId: string;
  target: LiveEventTarget;
  terminalRuns: Map<string, number>;
};

export type WorkerLiveEventApplicationResult =
  | { ok: true; result: WorkerLiveEventResult }
  | { ok: false; details: WorkerLiveEventErrorDetails };

type WorkerLiveEventFailure = Extract<WorkerLiveEventApplicationResult, { ok: false }>;

type WorkerLiveEventReceiverOptions = {
  getConfig: () => OpenClawConfig;
  maxActiveRuns?: number;
  maxPendingBytes?: number;
  maxSessions?: number;
  startupBindings: readonly WorkerLiveSessionBinding[];
  startupOwners: ReadonlyMap<string, number>;
  windowSize?: number;
};

function invalidEvent(): WorkerLiveEventFailure {
  return { ok: false, details: { reason: "invalid-event" } };
}

function capacityExceeded(): WorkerLiveEventFailure {
  return { ok: false, details: { reason: "capacity-exceeded" } };
}

export function createWorkerLiveEventReceiver(options: WorkerLiveEventReceiverOptions) {
  const boundSessions = new Map<string, BoundLiveSession>();
  const sessionBindings = new Map<string, WorkerLiveSessionBinding>();
  const fencedEnvironmentEpochs = new Map<string, number>();
  const staleSessions = new Set<string>();
  const windows = new Map<string, LiveEventWindow>();
  const startupBindingOwners = new Map(
    options.startupBindings
      .filter(isValidLiveSessionBinding)
      .map(({ environmentId, runEpoch }) => [environmentId, runEpoch]),
  );
  // Only an owner corroborated by the same persisted binding may seed a
  // post-restart ACK. Unmatched owner rows must restart from zero.
  const startupOwners = new Map(
    [...options.startupOwners].filter(
      ([environmentId, ownerEpoch]) =>
        environmentId.length > 0 &&
        Number.isSafeInteger(ownerEpoch) &&
        ownerEpoch >= 0 &&
        startupBindingOwners.get(environmentId) === ownerEpoch,
    ),
  );
  const windowSize = Math.max(1, Math.floor(options.windowSize ?? DEFAULT_WINDOW_SIZE));
  const maxActiveRuns = Math.max(1, Math.floor(options.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_RUNS));
  const maxPendingBytes = Math.max(
    1,
    Math.floor(options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES),
  );
  const maxSessions = Math.max(1, Math.floor(options.maxSessions ?? DEFAULT_MAX_SESSIONS));
  let committedConfig = options.getConfig();
  for (const binding of options.startupBindings) {
    if (!isValidLiveSessionBinding(binding)) {
      continue;
    }
    const existing = sessionBindings.get(binding.sessionId);
    if (
      !existing ||
      binding.runEpoch > existing.runEpoch ||
      (binding.runEpoch === existing.runEpoch && binding.environmentId === existing.environmentId)
    ) {
      sessionBindings.set(binding.sessionId, { ...binding });
    }
  }
  for (const binding of sessionBindings.values()) {
    const prepared = prepareBoundLiveSessionSafely(committedConfig, binding);
    if (prepared) {
      boundSessions.set(binding.sessionId, prepared);
    } else {
      staleSessions.add(binding.sessionId);
    }
  }

  // Durable credential renewal keeps the same owner epoch and replay cursor.
  const rotateCredential = (rotation: WorkerLiveCredentialRotation): boolean => {
    if (
      !rotation.credentialHash ||
      !rotation.environmentId ||
      !rotation.previousCredentialHash ||
      !rotation.sessionId ||
      !Number.isSafeInteger(rotation.runEpoch) ||
      rotation.runEpoch < 0
    ) {
      return false;
    }
    const window = windows.get(rotation.sessionId);
    if (
      window?.credentialHash === rotation.previousCredentialHash &&
      window.environmentId === rotation.environmentId &&
      window.runEpoch === rotation.runEpoch
    ) {
      if (rotation.newProcessTurn === true) {
        // A per-turn credential is an unforgeable process boundary. Retire only
        // the prior process's transient run claims/fences while preserving the
        // durable ACK cursor; cron may intentionally reuse its durable run id.
        for (const [runId, owned] of window.activeRuns) {
          releaseAgentRunContext(runId, owned.claimId);
        }
        window.activeRuns.clear();
        window.pending.clear();
        window.pendingBytes = 0;
        window.terminalRuns.clear();
      }
      window.credentialHash = rotation.credentialHash;
      return true;
    }
    return false;
  };

  const releaseRun = (window: LiveEventWindow, runId: string): void => {
    const owned = window.activeRuns.get(runId);
    if (!owned) {
      return;
    }
    window.activeRuns.delete(runId);
    releaseAgentRunContext(runId, owned.claimId);
  };

  const fenceReleasedRun = (window: LiveEventWindow, runId: string): void => {
    if (!window.terminalRuns.has(runId)) {
      window.terminalRuns.set(runId, window.ackedSeq);
    }
    releaseRun(window, runId);
  };

  const clearWindow = (window: LiveEventWindow): void => {
    windows.delete(window.sessionId);
    for (const runId of window.activeRuns.keys()) {
      releaseRun(window, runId);
    }
    window.pending.clear();
    window.pendingBytes = 0;
    window.terminalRuns.clear();
  };

  const bindSessionWithConfig = (
    binding: WorkerLiveSessionBinding,
    config: OpenClawConfig,
  ): boolean => {
    if (!isValidLiveSessionBinding(binding)) {
      return false;
    }
    const existing = sessionBindings.get(binding.sessionId);
    if (
      (existing && binding.runEpoch < existing.runEpoch) ||
      (existing &&
        binding.runEpoch === existing.runEpoch &&
        binding.environmentId !== existing.environmentId)
    ) {
      return false;
    }
    const prepared = prepareBoundLiveSessionSafely(config, binding);
    if (!prepared) {
      if (
        existing?.environmentId === binding.environmentId &&
        existing.runEpoch === binding.runEpoch
      ) {
        // Retain the last target for key-based identity matching, but gate delivery
        // as stale until target resolution succeeds again.
        staleSessions.add(binding.sessionId);
      }
      return false;
    }
    const window = windows.get(binding.sessionId);
    if (
      window &&
      (window.environmentId !== binding.environmentId || window.runEpoch !== binding.runEpoch)
    ) {
      clearWindow(window);
    }
    sessionBindings.set(binding.sessionId, { ...binding });
    boundSessions.set(binding.sessionId, prepared);
    staleSessions.delete(binding.sessionId);
    const retainedWindow = windows.get(binding.sessionId);
    if (retainedWindow) {
      retainedWindow.target = prepared.target;
      for (const [runId, owned] of retainedWindow.activeRuns) {
        if (
          getAgentRunContextOwnerStatus(runId, owned.claimId, owned.lifecycleGeneration) ===
          "active"
        ) {
          registerAgentRunContext(
            runId,
            {
              ...(prepared.target.agentId ? { agentId: prepared.target.agentId } : {}),
              isControlUiVisible: owned.controlUiVisible,
              lifecycleGeneration: owned.lifecycleGeneration,
              projectSessionActive: true,
              sessionId: binding.sessionId,
              sessionKey: prepared.target.sessionKey,
            },
            owned.claimId,
          );
        }
      }
    }
    return true;
  };

  const bindSession = (binding: WorkerLiveSessionBinding): boolean =>
    bindSessionWithConfig(binding, committedConfig);

  const rebindAll = (config: OpenClawConfig): void => {
    committedConfig = config;
    for (const binding of sessionBindings.values()) {
      bindSessionWithConfig(binding, committedConfig);
    }
  };

  let unsubscribeSessionIdentityMutation: (() => void) | undefined;
  const start = (): void => {
    if (unsubscribeSessionIdentityMutation) {
      return;
    }
    unsubscribeSessionIdentityMutation = onSessionIdentityMutation((mutation) => {
      for (const binding of sessionBindings.values()) {
        if (
          matchesSessionIdentityMutation(binding, boundSessions.get(binding.sessionId), mutation)
        ) {
          if (!bindSessionWithConfig(binding, committedConfig)) {
            // Keep stale binding after identity invalidates its cursor and claims.
            startupOwners.delete(binding.environmentId);
            const window = windows.get(binding.sessionId);
            if (window) {
              clearWindow(window);
            }
          }
        }
      }
    });
    // Re-resolve targets after subscribing to close the startup mutation gap.
    for (const binding of sessionBindings.values()) {
      if (!bindSessionWithConfig(binding, committedConfig)) {
        startupOwners.delete(binding.environmentId);
      }
    }
  };

  const resyncRequired = (ackedSeq: number): WorkerLiveEventFailure => ({
    ok: false,
    details: { reason: "resync-required", ackedSeq, expectedSeq: ackedSeq + 1 },
  });

  const resyncWindow = (window: LiveEventWindow): WorkerLiveEventFailure => {
    // Resync replays the unacked suffix from expectedSeq. Drop speculative state
    // so stable or renumbered replay sequences cannot collide with stale pending.
    window.pending.clear();
    window.pendingBytes = 0;
    return resyncRequired(window.ackedSeq);
  };

  const resolveOrCreateWindow = (
    sessionId: string,
    params: {
      identity: WorkerConnectionIdentity;
      request: WorkerLiveEventParams;
    },
  ): WorkerLiveEventApplicationResult | LiveEventWindow => {
    const binding = boundSessions.get(sessionId);
    if (!binding) {
      return { ok: false, details: { reason: "session-not-attached" } };
    }
    if (
      binding.environmentId !== params.identity.environmentId ||
      binding.runEpoch !== params.request.runEpoch
    ) {
      return { ok: false, details: { reason: "epoch-mismatch" } };
    }
    if (staleSessions.has(sessionId)) {
      return { ok: false, details: { reason: "session-not-attached" } };
    }
    let window = windows.get(sessionId);
    if (window) {
      if (
        params.request.runEpoch !== window.runEpoch ||
        params.identity.credentialHash !== window.credentialHash ||
        params.identity.environmentId !== window.environmentId
      ) {
        return { ok: false, details: { reason: "epoch-mismatch" } };
      }
    } else {
      const startupOwnerEpoch = startupOwners.get(params.identity.environmentId);
      if (startupOwnerEpoch !== params.request.runEpoch && params.request.lastAckedSeq !== 0) {
        return resyncRequired(0);
      }
      if (windows.size >= maxSessions) {
        return capacityExceeded();
      }
      window = {
        activeRuns: new Map(),
        ackedSeq: params.request.lastAckedSeq,
        credentialHash: params.identity.credentialHash,
        environmentId: params.identity.environmentId,
        pending: new Map(),
        pendingBytes: 0,
        runEpoch: params.request.runEpoch,
        sessionId,
        target: binding.target,
        terminalRuns: new Map(),
      };
      windows.set(sessionId, window);
      // Seed one process-lost window; later windows for this owner start at zero.
      startupOwners.delete(params.identity.environmentId);
    }
    if (params.request.seq <= window.ackedSeq) {
      return { ok: true, result: { ackedSeq: window.ackedSeq } };
    }
    if (params.request.lastAckedSeq > window.ackedSeq) {
      return resyncWindow(window);
    }
    return window;
  };

  const pruneReleasedRuns = (window: LiveEventWindow): WorkerLiveEventFailure | undefined => {
    for (const [runId, owned] of window.activeRuns) {
      const ownerStatus = getAgentRunContextOwnerStatus(
        runId,
        owned.claimId,
        owned.lifecycleGeneration,
      );
      if (ownerStatus === undefined) {
        clearWindow(window);
        return resyncRequired(0);
      }
      if (ownerStatus !== "active") {
        fenceReleasedRun(window, runId);
      }
    }
    return undefined;
  };

  const hasReachableBufferedTerminal = (
    window: LiveEventWindow,
    admittedRunId: string,
    countedRunIds: ReadonlySet<string>,
  ): boolean => {
    // Borrow one source-ended slot only when this ordered drain can reach that
    // active run's terminal without claiming another new run first.
    for (let seq = window.ackedSeq + 2; seq <= window.ackedSeq + windowSize; seq += 1) {
      const pending = window.pending.get(seq);
      if (!pending) {
        return false;
      }
      const pendingRunId = pending.request.runId;
      if (countedRunIds.has(pendingRunId)) {
        if (isDefinitiveWorkerTerminalEvent(pending.request.event)) {
          return true;
        }
        continue;
      }
      if (pendingRunId !== admittedRunId) {
        // Another new run would consume the borrowed slot before the terminal.
        return false;
      }
    }
    return false;
  };

  const claimRun = (
    window: LiveEventWindow,
    runId: string,
    allowBufferedTerminalCapacity: boolean,
  ): WorkerLiveEventFailure | OwnedLiveRun => {
    if (window.terminalRuns.has(runId)) {
      return invalidEvent();
    }
    const owned = window.activeRuns.get(runId);
    if (owned) {
      const context = getAgentRunContext(runId);
      const ownerStatus = getAgentRunContextOwnerStatus(
        runId,
        owned.claimId,
        owned.lifecycleGeneration,
      );
      if (ownerStatus === undefined) {
        // A process sweep lost sequencing state; restart the transient cursor.
        clearWindow(window);
        return resyncRequired(0);
      }
      if (
        ownerStatus !== "active" ||
        context?.sessionId !== window.sessionId ||
        context.sessionKey !== window.target.sessionKey ||
        context.agentId !== window.target.agentId ||
        context.lifecycleGeneration !== owned.lifecycleGeneration ||
        context.isControlUiVisible !== owned.controlUiVisible
      ) {
        fenceReleasedRun(window, runId);
        return invalidEvent();
      }
      return owned;
    }

    const pruneFailure = pruneReleasedRuns(window);
    if (pruneFailure) {
      return pruneFailure;
    }
    const countedRunIds = new Set<string>();
    for (const activeRunId of window.activeRuns.keys()) {
      if (!window.terminalRuns.has(activeRunId)) {
        countedRunIds.add(activeRunId);
      }
    }
    if (
      countedRunIds.size >= maxActiveRuns &&
      !(allowBufferedTerminalCapacity && hasReachableBufferedTerminal(window, runId, countedRunIds))
    ) {
      return capacityExceeded();
    }
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const existingContext = getAgentRunContext(runId);
    // A dispatch-owned turn context (e.g. a worker-routed turn) owns the run's
    // Control UI visibility; adopt it so worker live events keep reaching the
    // visible clients that started the turn. Identity still has to match, so a
    // foreign run is rejected; only the visibility preference is inherited. With
    // no pre-existing turn context we scope live events to this session.
    const controlUiVisible = existingContext?.isControlUiVisible ?? false;
    const adoptExistingUnowned = existingContext !== undefined;
    if (
      existingContext &&
      (existingContext.sessionId !== window.sessionId ||
        existingContext.sessionKey !== window.target.sessionKey ||
        (existingContext.agentId !== undefined &&
          existingContext.agentId !== window.target.agentId) ||
        existingContext.lifecycleGeneration !== lifecycleGeneration)
    ) {
      return invalidEvent();
    }
    let emissionMode: OwnedLiveRun["emissionMode"] = "exclusive";
    let claimId = claimAgentRunContext(
      runId,
      {
        ...(window.target.agentId ? { agentId: window.target.agentId } : {}),
        isControlUiVisible: controlUiVisible,
        lifecycleGeneration,
        projectSessionActive: true,
        sessionId: window.sessionId,
        sessionKey: window.target.sessionKey,
      },
      {
        adoptExistingUnowned,
        exclusive: true,
        onClearRequested: (clearedClaimId) => {
          if (window.activeRuns.get(runId)?.claimId === clearedClaimId) {
            fenceReleasedRun(window, runId);
          }
        },
        ownsContext: true,
        trackOwner: true,
      },
    );
    if (!claimId && existingContext) {
      // Cron and other Gateway-owned handoffs retain a non-exclusive claim while the
      // assigned worker runs. Share only that corroborated identity; exclusive owners
      // still reject this claim and prevent a foreign execution from joining the run.
      claimId = claimAgentRunContext(
        runId,
        {
          ...(window.target.agentId ? { agentId: window.target.agentId } : {}),
          isControlUiVisible: controlUiVisible,
          lifecycleGeneration,
          projectSessionActive: true,
          sessionId: window.sessionId,
          sessionKey: window.target.sessionKey,
        },
        {
          exclusive: false,
          onClearRequested: (clearedClaimId) => {
            if (window.activeRuns.get(runId)?.claimId === clearedClaimId) {
              fenceReleasedRun(window, runId);
            }
          },
          ownsContext: false,
          trackOwner: true,
        },
      );
      emissionMode = "shared";
    }
    if (!claimId) {
      return invalidEvent();
    }
    const claimed = {
      claimId,
      controlUiVisible,
      emissionMode,
      lifecycleGeneration,
      trajectoryRecorder: createWorkerLiveTrajectoryRecorder({ runId, target: window.target }),
    };
    window.activeRuns.set(runId, claimed);
    return claimed;
  };

  const publish = (
    window: LiveEventWindow,
    request: WorkerLiveEventParams,
    allowBufferedTerminalCapacity: boolean,
  ): WorkerLiveEventFailure | undefined => {
    const owned = claimRun(window, request.runId, allowBufferedTerminalCapacity);
    if ("ok" in owned) {
      return owned;
    }
    const definitiveTerminal = isDefinitiveWorkerTerminalEvent(request.event);
    if (definitiveTerminal) {
      // Emission runs synchronous listeners that can clear this claim reentrantly.
      // Fence first so terminal delivery cannot reopen the run ID.
      window.terminalRuns.set(request.runId, request.seq);
    }
    const event = {
      runId: request.runId,
      stream: request.event.kind,
      data: prepareWorkerLiveEventData(request.event),
    };
    if (owned.emissionMode === "shared") {
      if (!emitAgentEventIfCurrent(event)) {
        if (definitiveTerminal) {
          window.terminalRuns.delete(request.runId);
        }
        return invalidEvent();
      }
    } else {
      emitAgentEventForOwner(event, owned.claimId);
    }
    recordWorkerLiveTrajectoryEvent(owned.trajectoryRecorder, request.event);
    // Gateway handler owns cleanup so detach can revoke deferred terminal delivery.
    return undefined;
  };

  const drain = (
    window: LiveEventWindow,
    first: WorkerLiveEventParams,
    firstPending?: PendingLiveEvent,
  ): WorkerLiveEventApplicationResult => {
    let request: WorkerLiveEventParams | undefined = first;
    let buffered = firstPending;
    let publishedPrefix = false;
    while (request) {
      const failed = publish(window, request, buffered !== undefined);
      if (failed) {
        if (failed.details.reason === "capacity-exceeded" && buffered) {
          // Keep the ordered tail retryable while the active prefix claim drains.
          // Later gaps still hit windowSize/maxPendingBytes and force normal resync.
          return { ok: true, result: { ackedSeq: window.ackedSeq } };
        }
        if (buffered) {
          if (window.pending.delete(request.seq)) {
            window.pendingBytes -= buffered.sizeBytes;
          }
        }
        if (failed.details.reason === "capacity-exceeded" && !publishedPrefix) {
          // A fresh head cannot advance. Reset its cursor and release every claim.
          clearWindow(window);
          return failed;
        }
        return publishedPrefix ? { ok: true, result: { ackedSeq: window.ackedSeq } } : failed;
      }
      if (buffered) {
        if (window.pending.delete(request.seq)) {
          window.pendingBytes -= buffered.sizeBytes;
        }
      }
      window.ackedSeq = request.seq;
      publishedPrefix = true;
      const oldestRetainedSeq = window.ackedSeq - windowSize;
      for (const [runId, terminalSeq] of window.terminalRuns) {
        // Active terminal claims stay fenced until owner cleanup. Released run IDs
        // age out after windowSize later events and may then start a fresh claim.
        if (!window.activeRuns.has(runId) && terminalSeq <= oldestRetainedSeq) {
          window.terminalRuns.delete(runId);
        }
      }
      const next = window.pending.get(window.ackedSeq + 1);
      if (!next) {
        break;
      }
      request = next.request;
      buffered = next;
    }
    return { ok: true, result: { ackedSeq: window.ackedSeq } };
  };

  const apply = (params: {
    identity: WorkerConnectionIdentity;
    request: WorkerLiveEventParams;
  }): WorkerLiveEventApplicationResult => {
    if (!params.identity.sessionId) {
      return { ok: false, details: { reason: "session-not-attached" } };
    }
    if (params.request.runEpoch !== params.identity.ownerEpoch) {
      return { ok: false, details: { reason: "epoch-mismatch" } };
    }
    if (
      params.request.runEpoch <= (fencedEnvironmentEpochs.get(params.identity.environmentId) ?? -1)
    ) {
      return invalidEvent();
    }
    const sessionId = params.identity.sessionId;
    const window = resolveOrCreateWindow(sessionId, params);
    if ("ok" in window) {
      return window;
    }
    const { seq } = params.request;
    const expectedSeq = window.ackedSeq + 1;
    if (seq > window.ackedSeq + windowSize) {
      return resyncWindow(window);
    }
    if (seq === expectedSeq) {
      const pending = window.pending.get(seq);
      return drain(window, pending?.request ?? params.request, pending);
    }
    if (window.pending.has(seq)) {
      return { ok: true, result: { ackedSeq: window.ackedSeq } };
    }
    const sizeBytes = Buffer.byteLength(JSON.stringify(params.request.event), "utf8");
    if (window.pendingBytes + sizeBytes > maxPendingBytes) {
      return resyncWindow(window);
    }
    window.pending.set(seq, { request: params.request, sizeBytes });
    window.pendingBytes += sizeBytes;
    return { ok: true, result: { ackedSeq: window.ackedSeq } };
  };

  const clearEnvironment = (environmentId: string): void => {
    startupOwners.delete(environmentId);
    let fencedEpoch = fencedEnvironmentEpochs.get(environmentId) ?? -1;
    for (const [sessionId, binding] of sessionBindings) {
      if (binding.environmentId === environmentId) {
        fencedEpoch = Math.max(fencedEpoch, binding.runEpoch);
        sessionBindings.delete(sessionId);
        boundSessions.delete(sessionId);
        staleSessions.delete(sessionId);
      }
    }
    for (const window of windows.values()) {
      if (window.environmentId === environmentId) {
        fencedEpoch = Math.max(fencedEpoch, window.runEpoch);
        clearWindow(window);
      }
    }
    if (fencedEpoch >= 0) {
      // Oldest tombstones may expire because service/store ownership stays authoritative.
      // Refresh recency first so a re-fenced environment keeps its newest stale-owner epoch.
      fencedEnvironmentEpochs.delete(environmentId);
      fencedEnvironmentEpochs.set(environmentId, fencedEpoch);
      if (fencedEnvironmentEpochs.size > MAX_FENCED_ENVIRONMENTS) {
        const oldestEnvironmentId = fencedEnvironmentEpochs.keys().next().value;
        if (oldestEnvironmentId) {
          fencedEnvironmentEpochs.delete(oldestEnvironmentId);
        }
      }
    }
  };

  const clear = (): void => {
    unsubscribeSessionIdentityMutation?.();
    unsubscribeSessionIdentityMutation = undefined;
    for (const window of windows.values()) {
      clearWindow(window);
    }
    boundSessions.clear();
    sessionBindings.clear();
    fencedEnvironmentEpochs.clear();
    staleSessions.clear();
    startupOwners.clear();
  };

  return { apply, bindSession, clear, clearEnvironment, rebindAll, rotateCredential, start };
}

export type WorkerLiveEventReceiver = ReturnType<typeof createWorkerLiveEventReceiver>;
