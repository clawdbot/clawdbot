import { randomUUID } from "node:crypto";
import { resolveAgentConfig, resolveAgentDir } from "../../agents/agent-scope.js";
import { resolveModel } from "../../agents/embedded-agent-runner/model.js";
import { isEmbeddedAgentRunActive } from "../../agents/embedded-agent-runner/runs.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection-config.js";
import { resolveHeartbeatPrompt } from "../../auto-reply/heartbeat.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { toErrorObject } from "../../infra/errors.js";
import {
  listHistoryScanCandidates,
  selectSkillHistoryScanCandidates,
  type SkillHistoryScanCandidate,
} from "./history-scan-candidates.js";
import {
  reconcileSkillHistoryScanProgress,
  resolveSkillHistoryScanHasMore,
} from "./history-scan-progress.js";
import { HISTORY_SCAN_MAX_PROPOSAL_MUTATIONS } from "./history-scan-review-outcome.js";
import { HISTORY_SCAN_SESSION_SEGMENT, runSkillHistoryScanReview } from "./history-scan-review.js";
import {
  emptyHistoryScanResult,
  historyScanStateKey,
  historyScanStore,
  isStoredHistoryScanState,
  toPublicHistoryScanResult,
  withoutPendingHistoryScan,
  withHistoryScanIdeas,
  type SkillHistoryScanDirection,
  type SkillHistoryScanResult,
  type SkillHistoryScanScope,
  type StoredSkillHistoryScanSnapshot,
  type StoredSkillHistoryScanState,
} from "./history-scan-state.js";
import {
  collectSkillHistoryScanBatch,
  HISTORY_SCAN_MAX_SESSION_CHARS,
  HISTORY_SCAN_SESSION_OVERHEAD_CHARS,
  readHistoryScanSession,
  resolveSkillHistoryScanTranscriptBudget,
  type SkillHistoryScanBatchSession,
} from "./history-scan-transcript.js";
import { getSkillProposalRunProgress } from "./service.js";

type ActiveSkillHistoryScan = {
  direction: SkillHistoryScanDirection;
  run: Promise<SkillHistoryScanResult>;
};

const historyScansInFlight = new Map<string, ActiveSkillHistoryScan>();

function finalizeUnreplayableSkillHistoryScan(
  previous: StoredSkillHistoryScanSnapshot,
  pending: NonNullable<StoredSkillHistoryScanState["pending"]>,
): StoredSkillHistoryScanSnapshot {
  // Durable proposals prove useful work completed. If the source rotated or
  // changed, finalize that partial batch instead of wedging every later scan.
  return withHistoryScanIdeas({
    next: pending.next,
    previous,
    ideasFound: pending.progress.proposalIds.length,
  });
}

function toStoredState(params: {
  previous: StoredSkillHistoryScanState | undefined;
  direction: SkillHistoryScanDirection;
  considered: readonly SkillHistoryScanCandidate[];
  sessions: readonly SkillHistoryScanBatchSession[];
  candidates: readonly SkillHistoryScanCandidate[];
  ideasFound: number;
  now: number;
}): StoredSkillHistoryScanState {
  const previous = params.previous;
  const reviewedTimes = params.sessions.map((session) => session.updatedAtMs);
  const previousOldest = previous?.oldestReviewedAt
    ? Date.parse(previous.oldestReviewedAt)
    : undefined;
  const previousNewest = previous?.newestReviewedAt
    ? Date.parse(previous.newestReviewedAt)
    : undefined;
  const oldestReviewedAtMs = Math.min(
    ...reviewedTimes,
    ...(Number.isFinite(previousOldest) ? [previousOldest as number] : []),
  );
  const newestReviewedAtMs = Math.max(
    ...reviewedTimes,
    ...(Number.isFinite(previousNewest) ? [previousNewest as number] : []),
  );
  const lastConsidered = params.considered.at(-1);
  const firstConsidered = params.considered.at(0);
  const oldestCursor =
    params.direction === "older" && lastConsidered
      ? { instanceId: lastConsidered.instanceId, updatedAtMs: lastConsidered.updatedAtMs }
      : previous?.oldestCursor;
  const newestCursor =
    params.direction === "newer" && lastConsidered
      ? { instanceId: lastConsidered.instanceId, updatedAtMs: lastConsidered.updatedAtMs }
      : (previous?.newestCursor ??
        (firstConsidered
          ? { instanceId: firstConsidered.instanceId, updatedAtMs: firstConsidered.updatedAtMs }
          : undefined));
  const hasMore = resolveSkillHistoryScanHasMore({
    direction: params.direction,
    ...(oldestCursor ? { oldestCursor } : {}),
    candidates: params.candidates,
  });
  return {
    schema: "openclaw.skill-workshop.history-scan.v1",
    hasScanned: true,
    reviewedSessions: (previous?.reviewedSessions ?? 0) + params.sessions.length,
    ideasFound: (previous?.ideasFound ?? 0) + params.ideasFound,
    hasMore,
    lastScanReviewed: params.sessions.length,
    lastScanIdeas: params.ideasFound,
    lastScanAt: new Date(params.now).toISOString(),
    ...(Number.isFinite(oldestReviewedAtMs)
      ? { oldestReviewedAt: new Date(oldestReviewedAtMs).toISOString() }
      : {}),
    ...(Number.isFinite(newestReviewedAtMs)
      ? { newestReviewedAt: new Date(newestReviewedAtMs).toISOString() }
      : {}),
    ...(oldestCursor ? { oldestCursor } : {}),
    ...(newestCursor ? { newestCursor } : {}),
  };
}

async function runSkillHistoryScanCore(
  params: SkillHistoryScanScope,
): Promise<SkillHistoryScanResult> {
  const store = historyScanStore(params.env);
  const storePath = resolveStorePath(params.config.session?.store, {
    agentId: params.agentId,
    ...(params.env ? { env: params.env } : {}),
  });
  const stateKey = historyScanStateKey(params.agentId, params.workspaceDir, storePath);
  let stored = store.lookup(stateKey);
  if (stored === undefined) {
    store.registerIfAbsent(stateKey, emptyHistoryScanResult());
    stored = store.lookup(stateKey);
  }
  if (!isStoredHistoryScanState(stored)) {
    stored = emptyHistoryScanResult();
    store.register(stateKey, stored);
  }
  const previous = withoutPendingHistoryScan(stored);
  const direction: SkillHistoryScanDirection = params.direction ?? "older";
  let resumedPending: StoredSkillHistoryScanState["pending"];
  if (stored.pending) {
    if (stored.pending.completed) {
      const recovered = withHistoryScanIdeas({
        next: stored.pending.next,
        previous,
        ideasFound: stored.pending.completed.ideasFound,
      });
      store.register(stateKey, recovered);
      return recovered;
    }
    if (stored.pending.direction !== direction) {
      throw new Error(
        `An interrupted Skill Workshop history scan in the ${stored.pending.direction} direction must finish first.`,
      );
    }
    const durableProgress = await getSkillProposalRunProgress({
      runId: stored.pending.runId,
      workspaceDir: params.workspaceDir,
      ...(params.env ? { env: params.env } : {}),
    });
    resumedPending = {
      ...stored.pending,
      progress: reconcileSkillHistoryScanProgress({
        durableMutationCount: durableProgress.mutationCount,
        durableProposalIds: durableProgress.proposalIds,
      }),
    };
    store.register(stateKey, { ...previous, pending: resumedPending });
  }
  const candidates = listHistoryScanCandidates(params);
  let eligible = selectSkillHistoryScanCandidates({
    candidates,
    direction,
    ...(previous.oldestCursor ? { oldestCursor: previous.oldestCursor } : {}),
    ...(previous.newestCursor ? { newestCursor: previous.newestCursor } : {}),
  });
  if (resumedPending) {
    const candidatesById = new Map(
      candidates.map((candidate) => [candidate.instanceId, candidate] as const),
    );
    const resumedCandidates = resumedPending.sessionCursors.flatMap((cursor) => {
      const candidate = candidatesById.get(cursor.instanceId);
      return candidate?.updatedAtMs === cursor.updatedAtMs ? [candidate] : [];
    });
    if (resumedCandidates.length !== resumedPending.sessionCursors.length) {
      if (resumedPending.progress.proposalIds.length === 0) {
        store.register(stateKey, previous);
        return await runSkillHistoryScanCore(params);
      }
      const sourceStillActive = resumedPending.sessionCursors.some((cursor) => {
        const candidate = candidatesById.get(cursor.instanceId);
        return candidate ? isEmbeddedAgentRunActive(candidate.entry.sessionId) : false;
      });
      if (sourceStillActive) {
        throw new Error(
          "Interrupted Skill Workshop history scan source sessions are still active.",
        );
      }
      const recovered = finalizeUnreplayableSkillHistoryScan(previous, resumedPending);
      store.register(stateKey, recovered);
      return recovered;
    }
    eligible = resumedCandidates;
  }
  const modelRef = resolveDefaultModelForAgent({ cfg: params.config, agentId: params.agentId });
  const resolvedModel =
    eligible.length > 0
      ? resolveModel(
          modelRef.provider,
          modelRef.model,
          resolveAgentDir(params.config, params.agentId, params.env),
          params.config,
          { workspaceDir: params.workspaceDir },
        ).model
      : undefined;
  const contextTokens = resolvedModel
    ? Math.min(
        resolvedModel.contextTokens ?? resolvedModel.contextWindow,
        resolvedModel.contextWindow,
      )
    : undefined;
  const maxTranscriptChars = resolveSkillHistoryScanTranscriptBudget(contextTokens);
  const maxSessionTranscriptChars = Math.min(
    HISTORY_SCAN_MAX_SESSION_CHARS,
    Math.max(1, maxTranscriptChars - HISTORY_SCAN_SESSION_OVERHEAD_CHARS),
  );
  // The configured prompt is only an extra legacy match; the stable marker is authoritative.
  const heartbeatPrompt = resolveHeartbeatPrompt(
    resolveAgentConfig(params.config, params.agentId)?.heartbeat?.prompt ??
      params.config.agents?.defaults?.heartbeat?.prompt,
  );
  const batch = await collectSkillHistoryScanBatch({
    candidates: eligible,
    isSessionActive: (candidate) => isEmbeddedAgentRunActive(candidate.entry.sessionId),
    maxTranscriptChars,
    readSession: (candidate) =>
      readHistoryScanSession({
        agentId: params.agentId,
        candidate,
        heartbeatPrompt,
        maxTranscriptChars: maxSessionTranscriptChars,
        storePath,
      }),
  });
  if (
    resumedPending &&
    (batch.sessions.length !== resumedPending.sessionCursors.length ||
      batch.sessions.some(
        (session, index) => session.instanceId !== resumedPending.sessionCursors[index]?.instanceId,
      ))
  ) {
    if (resumedPending.progress.proposalIds.length === 0) {
      store.register(stateKey, previous);
      return await runSkillHistoryScanCore(params);
    }
    if (batch.blockedByActive) {
      throw new Error("Interrupted Skill Workshop history scan source sessions are still active.");
    }
    const recovered = finalizeUnreplayableSkillHistoryScan(previous, resumedPending);
    store.register(stateKey, recovered);
    return recovered;
  }
  const provisionalNext =
    resumedPending?.next ??
    toStoredState({
      previous,
      direction,
      considered: batch.considered,
      sessions: batch.sessions,
      candidates,
      ideasFound: 0,
      now: Date.now(),
    });
  if (batch.sessions.length === 0) {
    if (resumedPending) {
      throw new Error("Interrupted Skill Workshop history scan has no readable settled sessions.");
    }
    store.register(stateKey, provisionalNext);
    return provisionalNext;
  }
  const runId = resumedPending?.runId ?? `${HISTORY_SCAN_SESSION_SEGMENT}:${randomUUID()}`;
  const progress = resumedPending?.progress ?? {
    proposalIds: [],
    remaining: HISTORY_SCAN_MAX_PROPOSAL_MUTATIONS,
    successfulMutations: 0,
  };
  // Checkpoint before persistence. Only the explicit final tool call completes the batch.
  store.register(stateKey, {
    ...previous,
    pending: {
      direction,
      runId,
      next: provisionalNext,
      progress,
      sessionCursors:
        resumedPending?.sessionCursors ??
        batch.sessions.map((session) => ({
          instanceId: session.instanceId,
          updatedAtMs: session.updatedAtMs,
        })),
    },
  });
  let reviewError: unknown;
  try {
    await runSkillHistoryScanReview({
      agentId: params.agentId,
      config: params.config,
      env: params.env,
      modelRef,
      progress,
      onProgress: async (nextProgress) => {
        const current = store.lookup(stateKey);
        if (
          !isStoredHistoryScanState(current) ||
          current.pending?.runId !== runId ||
          current.pending.completed
        ) {
          throw new Error("Historical skill scan progress checkpoint changed.");
        }
        store.register(stateKey, {
          ...previous,
          pending: { ...current.pending, progress: nextProgress },
        });
      },
      onComplete: async (ideasFound) => {
        const current = store.lookup(stateKey);
        if (
          !isStoredHistoryScanState(current) ||
          current.pending?.runId !== runId ||
          current.pending.completed
        ) {
          throw new Error("Historical skill scan completion checkpoint changed.");
        }
        store.register(stateKey, {
          ...previous,
          pending: { ...current.pending, completed: { ideasFound } },
        });
      },
      runId,
      sessions: batch.sessions,
      workspaceDir: params.workspaceDir,
    });
  } catch (error) {
    reviewError = error;
  }
  const completedState = store.lookup(stateKey);
  if (
    isStoredHistoryScanState(completedState) &&
    completedState.pending?.runId === runId &&
    completedState.pending.completed
  ) {
    const next = withHistoryScanIdeas({
      next: completedState.pending.next,
      previous,
      ideasFound: completedState.pending.completed.ideasFound,
    });
    store.register(stateKey, next);
    return next;
  }
  // Retry reuses its run id, durable proposal ids, and remaining mutation budget.
  throw toErrorObject(reviewError, "Historical skill scan did not confirm batch completion.");
}

export function runSkillHistoryScan(
  params: SkillHistoryScanScope,
): Promise<SkillHistoryScanResult> {
  const storePath = resolveStorePath(params.config.session?.store, {
    agentId: params.agentId,
    ...(params.env ? { env: params.env } : {}),
  });
  const key = historyScanStateKey(params.agentId, params.workspaceDir, storePath);
  const direction = params.direction ?? "older";
  const active = historyScansInFlight.get(key);
  if (active) {
    return active.direction === direction
      ? active.run
      : Promise.reject(
          new Error(
            `A Skill Workshop history scan in the ${active.direction} direction is running.`,
          ),
        );
  }
  const run = runSkillHistoryScanCore({ ...params, direction }).then(toPublicHistoryScanResult);
  const current = { direction, run };
  historyScansInFlight.set(key, current);
  void run
    .finally(() => {
      if (historyScansInFlight.get(key) === current) {
        historyScansInFlight.delete(key);
      }
    })
    .catch(() => undefined);
  return run;
}
