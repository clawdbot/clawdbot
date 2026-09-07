import type {
  WorkboardCard,
  WorkboardExecutionStatus,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi, OpenClawPluginService } from "../api.js";
import {
  cleanupWorkboardCardWorktree,
  isWorkboardWorktreeCleanupCandidate,
  type WorkboardWorktreeCleanupRuntime,
} from "./dispatcher-workspace.js";
import {
  workboardCardMatchesLifecycleLink,
  workboardCardSessionLookupKey,
} from "./session-link.js";
import { cardRunId, cardSessionKey } from "./store-card-helpers.js";
import { DEFAULT_WORKBOARD_DISPATCH_OWNER } from "./store-constants.js";
import type { WorkboardStore } from "./store.js";

const WORKBOARD_LIFECYCLE_SWEEP_MS = 60_000;
const WORKBOARD_STALE_SESSION_MS = 30 * 60 * 1000;
const WORKBOARD_SESSION_SWEEP_LIMIT = 10_000;
const WORKBOARD_WORKTREE_CLEANUP_SWEEP_LIMIT = 32;
// Keep readiness across plugin-only reloads, while the singleton lifecycle
// clears it before an in-process Gateway restart starts replacement services.
const workboardLifecycleGatewayState = resolveGlobalSingleton(
  Symbol.for("openclaw.workboard.lifecycleGatewayState"),
  () => ({ ready: false }),
  (state) => {
    state.ready = false;
  },
);

type WorkboardLifecycleState = "running" | "succeeded" | "failed" | "idle" | "stale";

type WorkboardLifecycleObservation = {
  state: WorkboardLifecycleState;
  sourceUpdatedAt?: number;
  stale?: {
    detectedAt: number;
    lastSessionUpdatedAt: number;
    reason: string;
  };
};

type WorkboardLifecycleSession = {
  key: string;
  updatedAt?: number;
  status?: "running" | "done" | "failed" | "killed" | "timeout";
  hasActiveRun?: boolean;
  abortedLastRun?: boolean;
};

type WorkboardLifecycleSessionSnapshot = {
  sessions: WorkboardLifecycleSession[];
  complete: boolean;
};

function sessionProvesPreparedAcceptance(session: WorkboardLifecycleSession): boolean {
  return (
    session.hasActiveRun === true ||
    session.status === "done" ||
    session.status === "failed" ||
    session.status === "killed" ||
    session.status === "timeout"
  );
}

type WorkboardLifecycleSessionReadOptions = {
  includeUnknown: boolean;
};

type WorkboardLifecycleMatchHandler = (input: {
  cards: readonly WorkboardCard[];
  sessionKey?: string;
}) => Promise<void>;

type WorkboardLifecycleService = OpenClawPluginService & {
  stop: () => void;
  onGatewayStart: () => void;
  onGatewayStop: () => void;
};

function needsWorkboardLifecycleReconciliation(card: WorkboardCard): boolean {
  if (card.metadata?.archivedAt) {
    return false;
  }
  // A running claim can own an accepted session even when persisting its link failed.
  // Keep those cards, and stale cleanup, in the missed-event recovery sweep.
  return Boolean(
    card.sessionKey ||
    card.runId ||
    card.execution ||
    card.status === "running" ||
    card.metadata?.claim ||
    card.metadata?.stale,
  );
}

const LIFECYCLE_TARGETS = {
  running: { card: "running", execution: "running" },
  succeeded: { card: "review", execution: "review" },
  failed: { card: "blocked", execution: "blocked" },
  idle: { execution: "idle" },
  stale: { card: "running", execution: "running" },
} as const satisfies Record<
  WorkboardLifecycleState,
  { card?: WorkboardStatus; execution?: WorkboardExecutionStatus }
>;

async function syncWorkboardCardLifecycle(params: {
  store: WorkboardStore;
  cardId: string;
  observation: WorkboardLifecycleObservation;
  now: number;
  association?: {
    expectedSessionKey?: string;
    expectedRunId?: string;
    sessionKey: string;
    runId?: string;
    acceptedAt?: number;
  };
}): Promise<boolean> {
  const target = LIFECYCLE_TARGETS[params.observation.state];
  return await params.store.syncLifecycle(params.cardId, {
    targetStatus: "card" in target ? target.card : undefined,
    executionStatus: "execution" in target ? target.execution : undefined,
    sourceUpdatedAt: params.observation.sourceUpdatedAt,
    stale: params.observation.stale,
    now: params.now,
    ...(params.association ? { association: params.association } : {}),
  });
}

async function syncWorkboardLifecycleEvent(params: {
  store: WorkboardStore;
  source: { sessionKey?: string; runId?: string };
  observation: WorkboardLifecycleObservation;
  now: number;
  onMatched?: WorkboardLifecycleMatchHandler;
}): Promise<{ cards: readonly WorkboardCard[]; count: number }> {
  const cards = (await params.store.list()).filter(
    (card) => !card.metadata?.archivedAt && workboardCardMatchesLifecycleLink(card, params.source),
  );
  const updates = Promise.all(
    cards.map(
      async (card) =>
        await syncWorkboardCardLifecycle({
          ...params,
          cardId: card.id,
          ...(params.source.sessionKey
            ? {
                association: {
                  ...(cardSessionKey(card) ? { expectedSessionKey: cardSessionKey(card) } : {}),
                  ...(cardRunId(card) ? { expectedRunId: cardRunId(card) } : {}),
                  sessionKey: params.source.sessionKey,
                  ...(params.source.runId ? { runId: params.source.runId } : {}),
                  acceptedAt: params.observation.sourceUpdatedAt ?? params.now,
                },
              }
            : {}),
        }),
    ),
  );
  await Promise.all([
    updates,
    params.onMatched?.({
      cards,
      ...(params.source.sessionKey ? { sessionKey: params.source.sessionKey } : {}),
    }),
  ]);
  return { cards, count: (await updates).filter(Boolean).length };
}

export async function syncWorkboardSubagentEnded(params: {
  store: WorkboardStore;
  worktrees?: WorkboardWorktreeCleanupRuntime;
  event: {
    targetSessionKey: string;
    runId?: string;
    endedAt?: number;
    outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
  };
  now?: number;
  onMatched?: WorkboardLifecycleMatchHandler;
}): Promise<number> {
  const now = params.now ?? Date.now();
  const synced = await syncWorkboardLifecycleEvent({
    store: params.store,
    source: { sessionKey: params.event.targetSessionKey, runId: params.event.runId },
    observation: {
      state: params.event.outcome === "ok" ? "succeeded" : "failed",
      sourceUpdatedAt: params.event.endedAt ?? now,
    },
    now,
    ...(params.onMatched ? { onMatched: params.onMatched } : {}),
  });
  if (params.worktrees) {
    for (const matched of synced.cards) {
      const card = await params.store.get(matched.id);
      if (card) {
        await cleanupWorkboardCardWorktree({
          store: params.store,
          worktrees: params.worktrees,
          card,
        });
      }
    }
  }
  return synced.count;
}

export async function syncWorkboardAgentEnded(params: {
  store: WorkboardStore;
  event: { runId?: string; success: boolean };
  context: { runId?: string; sessionKey?: string };
  now?: number;
  onMatched?: WorkboardLifecycleMatchHandler;
}): Promise<number> {
  const now = params.now ?? Date.now();
  return (
    await syncWorkboardLifecycleEvent({
      store: params.store,
      source: {
        sessionKey: params.context.sessionKey,
        runId: params.event.runId ?? params.context.runId,
      },
      observation: {
        state: params.event.success ? "succeeded" : "failed",
        sourceUpdatedAt: now,
      },
      now,
      ...(params.onMatched ? { onMatched: params.onMatched } : {}),
    })
  ).count;
}

function lifecycleFromSession(
  session: WorkboardLifecycleSession,
  now: number,
): WorkboardLifecycleObservation {
  const sourceUpdatedAt = session.updatedAt;
  if (
    session.status === "running" &&
    session.hasActiveRun === false &&
    sourceUpdatedAt !== undefined &&
    now - sourceUpdatedAt >= WORKBOARD_STALE_SESSION_MS
  ) {
    return {
      state: "stale",
      sourceUpdatedAt,
      stale: {
        detectedAt: now,
        lastSessionUpdatedAt: sourceUpdatedAt,
        reason: "Linked session has not reported recent activity.",
      },
    };
  }
  if (session.hasActiveRun === true || session.status === "running") {
    return { state: "running", sourceUpdatedAt };
  }
  if (
    session.abortedLastRun ||
    session.status === "failed" ||
    session.status === "killed" ||
    session.status === "timeout"
  ) {
    return { state: "failed", sourceUpdatedAt };
  }
  if (session.status === "done") {
    return { state: "succeeded", sourceUpdatedAt };
  }
  return { state: "idle", sourceUpdatedAt };
}

async function syncWorkboardLifecycleSessions(params: {
  store: WorkboardStore;
  cards?: readonly WorkboardCard[];
  sessions: readonly WorkboardLifecycleSession[];
  complete?: boolean;
  now?: number;
}): Promise<number> {
  const now = params.now ?? Date.now();
  const sessionsByKey = new Map<string, WorkboardLifecycleSession>();
  const sessionsByWorkboardSuffix = new Map<string, WorkboardLifecycleSession>();
  const ambiguousWorkboardSuffixes = new Set<string>();
  for (const session of params.sessions) {
    sessionsByKey.set(session.key, session);
    const suffixIndex = session.key.lastIndexOf(":subagent:workboard-");
    if (suffixIndex >= 0) {
      const suffix = session.key.slice(suffixIndex + 1);
      const existing = sessionsByWorkboardSuffix.get(suffix);
      if (existing && existing.key !== session.key) {
        sessionsByWorkboardSuffix.delete(suffix);
        ambiguousWorkboardSuffixes.add(suffix);
      } else if (!ambiguousWorkboardSuffixes.has(suffix)) {
        sessionsByWorkboardSuffix.set(suffix, session);
      }
    }
  }
  let count = 0;
  for (const card of params.cards ?? (await params.store.list())) {
    if (card.metadata?.archivedAt) {
      continue;
    }
    const lookupKey = workboardCardSessionLookupKey(card);
    const suffixIndex = lookupKey.lastIndexOf("subagent:workboard-");
    const linkedSessionKey = cardSessionKey(card);
    const canUseAgentlessFallback =
      linkedSessionKey?.startsWith("subagent:workboard-") === true ||
      (!linkedSessionKey &&
        (!card.agentId ||
          (card.agentId === DEFAULT_WORKBOARD_DISPATCH_OWNER &&
            card.metadata?.claim?.ownerId === DEFAULT_WORKBOARD_DISPATCH_OWNER)));
    // Persisted links and explicit agent targets stay authoritative. The unique
    // suffix fallback recovers a run accepted before its link could be persisted.
    const session =
      sessionsByKey.get(lookupKey) ??
      (canUseAgentlessFallback && suffixIndex >= 0
        ? sessionsByWorkboardSuffix.get(lookupKey.slice(suffixIndex))
        : undefined);
    const launch = card.metadata?.automation?.launch;
    const preparedAcceptanceAt =
      launch?.phase === "prepared" && session && sessionProvesPreparedAcceptance(session)
        ? session.hasActiveRun === true
          ? Math.max(now, launch.preparedAt)
          : session.updatedAt
        : undefined;
    if (
      launch?.phase === "prepared" &&
      (preparedAcceptanceAt === undefined || preparedAcceptanceAt < launch.preparedAt)
    ) {
      if (
        params.complete &&
        (await params.store.failPreparedLaunch(card.id, {
          expectedLaunch: launch,
          reason: "Gateway did not accept the prepared Workboard session before restart.",
          failedAt: now,
        }))
      ) {
        count += 1;
      }
      continue;
    }
    if (!session) {
      continue;
    }
    const observation = lifecycleFromSession(session, now);
    if (
      await syncWorkboardCardLifecycle({
        store: params.store,
        cardId: card.id,
        observation,
        now,
        association: {
          ...(cardSessionKey(card) ? { expectedSessionKey: cardSessionKey(card) } : {}),
          ...(cardRunId(card) ? { expectedRunId: cardRunId(card) } : {}),
          sessionKey: session.key,
          ...(preparedAcceptanceAt === undefined ? {} : { acceptedAt: preparedAcceptanceAt }),
        },
      })
    ) {
      count += 1;
    }
  }
  return count;
}

function normalizeSession(value: unknown): WorkboardLifecycleSession | undefined {
  if (!isRecord(value) || typeof value.key !== "string" || !value.key) {
    return undefined;
  }
  const status =
    value.status === "running" ||
    value.status === "done" ||
    value.status === "failed" ||
    value.status === "killed" ||
    value.status === "timeout"
      ? value.status
      : undefined;
  return {
    key: value.key,
    ...(typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
      ? { updatedAt: value.updatedAt }
      : {}),
    ...(status ? { status } : {}),
    ...(typeof value.hasActiveRun === "boolean" ? { hasActiveRun: value.hasActiveRun } : {}),
    ...(value.abortedLastRun === true ? { abortedLastRun: true } : {}),
  };
}

export async function readWorkboardLifecycleSessions(
  gateway: Pick<OpenClawPluginApi["runtime"]["gateway"], "isAvailable" | "request">,
  options: WorkboardLifecycleSessionReadOptions = { includeUnknown: false },
): Promise<WorkboardLifecycleSessionSnapshot> {
  if (!(await gateway.isAvailable())) {
    return { sessions: [], complete: false };
  }
  let includeUnknown = false;
  if (options.includeUnknown) {
    const agentsPayload = await gateway.request("agents.list", {}, { scopes: ["operator.read"] });
    if (!isRecord(agentsPayload) || typeof agentsPayload.selectionRequired !== "boolean") {
      throw new Error("agents.list returned an invalid ownership snapshot");
    }
    // The unknown key is a legacy ownerless sentinel. Preserve an existing
    // captured link only while the Gateway proves that its owner is unambiguous.
    includeUnknown = !agentsPayload.selectionRequired;
  }
  const payload = await gateway.request(
    "sessions.list",
    {
      limit: WORKBOARD_SESSION_SWEEP_LIMIT,
      configuredAgentsOnly: true,
      includeGlobal: false,
      includeUnknown,
    },
    { scopes: ["operator.read"] },
  );
  if (!isRecord(payload) || !Array.isArray(payload.sessions)) {
    throw new Error("sessions.list returned an invalid lifecycle snapshot");
  }
  return {
    sessions: payload.sessions.flatMap((value) => {
      const session = normalizeSession(value);
      return session ? [session] : [];
    }),
    // A short page proves the snapshot is complete. Keep full pages conservative
    // so absent sessions are never inferred as "missing" when the page is truncated.
    complete: payload.sessions.length < WORKBOARD_SESSION_SWEEP_LIMIT,
  };
}

export function createWorkboardLifecycleService(params: {
  store: WorkboardStore;
  worktrees?: WorkboardWorktreeCleanupRuntime;
  readSessions: (
    options: WorkboardLifecycleSessionReadOptions,
  ) => Promise<WorkboardLifecycleSessionSnapshot>;
  now?: () => number;
}): WorkboardLifecycleService {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let begin: (() => void) | undefined;
  let cleanupCursor = 0;
  const cleanupWorktrees = async (
    cards: readonly WorkboardCard[],
    warn: (message: string) => void,
  ) => {
    if (!params.worktrees) {
      return;
    }
    const candidates = cards.filter(isWorkboardWorktreeCleanupCandidate);
    const start = cleanupCursor % Math.max(candidates.length, 1);
    const rotated = [...candidates.slice(start), ...candidates.slice(0, start)];
    const batch = rotated.slice(0, WORKBOARD_WORKTREE_CLEANUP_SWEEP_LIMIT);
    cleanupCursor = candidates.length === 0 ? 0 : (start + batch.length) % candidates.length;
    for (const card of batch) {
      try {
        await cleanupWorkboardCardWorktree({
          store: params.store,
          worktrees: params.worktrees,
          card,
        });
      } catch (error) {
        warn(`workboard worktree cleanup failed for card ${card.id}: ${String(error)}`);
      }
    }
  };
  const stop = () => {
    generation += 1;
    begin = undefined;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return {
    id: "workboard-lifecycle-sync",
    start(ctx) {
      const owner = ++generation;
      let begun = false;
      const reconcile = async () => {
        try {
          await params.store.runOperation(async () => {
            let cards = await params.store.list();
            if (generation !== owner) {
              return;
            }
            if (cards.some((card) => needsWorkboardLifecycleReconciliation(card))) {
              try {
                const snapshot = await params.readSessions({
                  includeUnknown: cards.some(
                    (card) => !card.metadata?.archivedAt && cardSessionKey(card) === "unknown",
                  ),
                });
                if (generation !== owner) {
                  return;
                }
                await syncWorkboardLifecycleSessions({
                  store: params.store,
                  cards,
                  ...snapshot,
                  now: params.now?.() ?? Date.now(),
                });
                if (generation !== owner) {
                  return;
                }
                cards = await params.store.list();
              } catch (error) {
                ctx.logger.warn(`workboard lifecycle sync failed: ${String(error)}`);
              }
            }
            if (generation === owner) {
              await cleanupWorktrees(cards, (message) => ctx.logger.warn(message));
            }
          });
        } catch (error) {
          ctx.logger.warn(`workboard lifecycle recovery failed: ${String(error)}`);
        } finally {
          if (generation === owner) {
            timer = setTimeout(() => void reconcile(), WORKBOARD_LIFECYCLE_SWEEP_MS);
            timer.unref?.();
          }
        }
      };
      begin = () => {
        if (generation !== owner || begun) {
          return;
        }
        begun = true;
        // The Gateway lifecycle signal owns the first bounded sweep; terminal
        // hooks keep end-state writes immediate between 60-second sweeps.
        void reconcile();
      };
      if (workboardLifecycleGatewayState.ready) {
        begin();
      }
    },
    stop,
    onGatewayStart() {
      workboardLifecycleGatewayState.ready = true;
      begin?.();
    },
    onGatewayStop() {
      workboardLifecycleGatewayState.ready = false;
      stop();
    },
  };
}
