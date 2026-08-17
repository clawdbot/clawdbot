import type {
  WorkboardCard,
  WorkboardExecutionStatus,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi, OpenClawPluginService } from "../api.js";
import {
  workboardCardMatchesLifecycleLink,
  workboardCardSessionLookupKey,
} from "./session-link.js";
import type { WorkboardStore } from "./store.js";

const WORKBOARD_LIFECYCLE_SWEEP_MS = 60_000;
const WORKBOARD_STALE_SESSION_MS = 30 * 60 * 1000;
const WORKBOARD_SESSION_SWEEP_LIMIT = 10_000;

type WorkboardLifecycleState = "running" | "succeeded" | "failed" | "idle" | "missing" | "stale";

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

type WorkboardLifecycleMatchHandler = (input: {
  cards: readonly WorkboardCard[];
  sessionKey?: string;
}) => Promise<void>;

const LIFECYCLE_TARGETS = {
  running: { card: "running", execution: "running" },
  succeeded: { card: "review", execution: "review" },
  failed: { card: "blocked", execution: "blocked" },
  idle: { execution: "idle" },
  missing: {},
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
}): Promise<boolean> {
  const target = LIFECYCLE_TARGETS[params.observation.state];
  return await params.store.syncLifecycle(params.cardId, {
    targetStatus: "card" in target ? target.card : undefined,
    executionStatus: "execution" in target ? target.execution : undefined,
    sourceUpdatedAt: params.observation.sourceUpdatedAt,
    stale: params.observation.stale,
    now: params.now,
  });
}

async function syncWorkboardLifecycleEvent(params: {
  store: WorkboardStore;
  source: { sessionKey?: string; runId?: string };
  observation: WorkboardLifecycleObservation;
  now: number;
  onMatched?: WorkboardLifecycleMatchHandler;
}): Promise<number> {
  const cards = (await params.store.list()).filter(
    (card) => !card.metadata?.archivedAt && workboardCardMatchesLifecycleLink(card, params.source),
  );
  const updates = Promise.all(
    cards.map(async (card) => await syncWorkboardCardLifecycle({ ...params, cardId: card.id })),
  );
  await Promise.all([
    updates,
    params.onMatched?.({
      cards,
      ...(params.source.sessionKey ? { sessionKey: params.source.sessionKey } : {}),
    }),
  ]);
  return (await updates).filter(Boolean).length;
}

export async function syncWorkboardSubagentEnded(params: {
  store: WorkboardStore;
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
  return await syncWorkboardLifecycleEvent({
    store: params.store,
    source: { sessionKey: params.event.targetSessionKey, runId: params.event.runId },
    observation: {
      state: params.event.outcome === "ok" ? "succeeded" : "failed",
      sourceUpdatedAt: params.event.endedAt ?? now,
    },
    now,
    ...(params.onMatched ? { onMatched: params.onMatched } : {}),
  });
}

export async function syncWorkboardAgentEnded(params: {
  store: WorkboardStore;
  event: { runId?: string; success: boolean };
  context: { runId?: string; sessionKey?: string };
  now?: number;
  onMatched?: WorkboardLifecycleMatchHandler;
}): Promise<number> {
  const now = params.now ?? Date.now();
  return await syncWorkboardLifecycleEvent({
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
  });
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
  sessions: readonly WorkboardLifecycleSession[];
  complete?: boolean;
  now?: number;
}): Promise<number> {
  const now = params.now ?? Date.now();
  const sessionsByKey = new Map<string, WorkboardLifecycleSession>();
  for (const session of params.sessions) {
    sessionsByKey.set(session.key, session);
    const suffixIndex = session.key.lastIndexOf(":subagent:workboard-");
    if (suffixIndex >= 0) {
      sessionsByKey.set(session.key.slice(suffixIndex + 1), session);
    }
  }
  let count = 0;
  for (const card of await params.store.list()) {
    if (card.metadata?.archivedAt) {
      continue;
    }
    const session = sessionsByKey.get(workboardCardSessionLookupKey(card));
    const observation = session
      ? lifecycleFromSession(session, now)
      : params.complete
        ? ({ state: "missing" } as const)
        : undefined;
    if (
      observation &&
      (await syncWorkboardCardLifecycle({ store: params.store, cardId: card.id, observation, now }))
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
): Promise<WorkboardLifecycleSessionSnapshot> {
  if (!(await gateway.isAvailable())) {
    return { sessions: [], complete: false };
  }
  const payload = await gateway.request(
    "sessions.list",
    {
      limit: WORKBOARD_SESSION_SWEEP_LIMIT,
      includeGlobal: true,
      includeUnknown: true,
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
    // sessions.list has no hasMore/cursor field; it honors `limit` unclamped, so a
    // short page proves the snapshot is complete. A full page may be truncated —
    // treat it as incomplete so absent sessions are never inferred as "missing".
    complete: payload.sessions.length < WORKBOARD_SESSION_SWEEP_LIMIT,
  };
}

export function createWorkboardLifecycleService(params: {
  store: WorkboardStore;
  readSessions: () => Promise<WorkboardLifecycleSessionSnapshot>;
  now?: () => number;
}): OpenClawPluginService {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    id: "workboard-lifecycle-sync",
    start(ctx) {
      const owner = ++generation;
      const reconcile = async () => {
        try {
          const snapshot = await params.readSessions();
          if (generation === owner) {
            await syncWorkboardLifecycleSessions({
              store: params.store,
              ...snapshot,
              now: params.now?.() ?? Date.now(),
            });
          }
        } catch (error) {
          ctx.logger.warn(`workboard lifecycle sync failed: ${String(error)}`);
        } finally {
          if (generation === owner) {
            timer = setTimeout(() => void reconcile(), WORKBOARD_LIFECYCLE_SWEEP_MS);
            timer.unref?.();
          }
        }
      };
      // This service owns one bounded session sweep; terminal hooks keep end-state writes immediate.
      void reconcile();
    },
    stop() {
      generation += 1;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
