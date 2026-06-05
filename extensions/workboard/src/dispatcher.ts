// Workboard plugin module implements dispatcher behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { WorkboardStore, type WorkboardDispatchResult } from "./store.js";
import type { WorkboardCard, WorkboardExecution } from "./types.js";

const DEFAULT_DISPATCH_MAX_STARTS = 3;
const DEFAULT_DISPATCH_OWNER = "workboard-dispatcher";
const DEFAULT_DISPATCH_MODEL = "default";

export type WorkboardSubagentRuntime = Pick<PluginRuntime["subagent"], "run">;

export type WorkboardDispatchStartOptions = {
  maxStarts?: number;
  model?: string;
  provider?: string;
  ownerId?: string;
  now?: number;
};

export type WorkboardStartedRun = {
  cardId: string;
  title: string;
  sessionKey: string;
  runId: string;
};

export type WorkboardStartFailure = {
  cardId: string;
  title: string;
  error: string;
};

export type WorkboardDispatchAndStartResult = WorkboardDispatchResult & {
  started: WorkboardStartedRun[];
  startFailures: WorkboardStartFailure[];
};

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
}

function cardBoardId(card: WorkboardCard): string {
  return card.metadata?.automation?.boardId ?? "default";
}

function sanitizeSessionSegment(value: string | undefined, fallback: string): string {
  const sanitized = (value ?? fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (sanitized || fallback).slice(0, 96);
}

function cardIsArchived(card: WorkboardCard): boolean {
  return Boolean(card.metadata?.archivedAt);
}

function buildSessionKey(card: WorkboardCard): string {
  const boardId = sanitizeSessionSegment(cardBoardId(card), "default");
  const cardId = sanitizeSessionSegment(card.id, "card");
  const suffix = `subagent:workboard-${boardId}-${cardId}`;
  return card.agentId ? `agent:${sanitizeSessionSegment(card.agentId, "agent")}:${suffix}` : suffix;
}

function buildExecution(params: {
  card: WorkboardCard;
  sessionKey: string;
  runId: string;
  model: string;
  now: number;
}): WorkboardExecution {
  return {
    id: params.card.execution?.id ?? `${params.card.id}:codex`,
    kind: "agent-session",
    engine: "codex",
    mode: "autonomous",
    status: "running",
    model: params.model,
    sessionKey: params.sessionKey,
    runId: params.runId,
    startedAt: params.now,
    updatedAt: params.now,
  };
}

function buildWorkerPrompt(params: {
  card: WorkboardCard;
  context: string;
  ownerId: string;
  token: string;
}): string {
  return [
    `Work on this OpenClaw Workboard card: ${params.card.title}`,
    "",
    "## Worker protocol",
    `Card id: ${params.card.id}`,
    `Claim ownerId: ${params.ownerId}`,
    `Claim token: ${params.token}`,
    "",
    "Heartbeat with workboard_heartbeat using the card id and token while working.",
    "When done, call workboard_complete with the card id, token, summary, and proof.",
    "If blocked, call workboard_block with the card id, token, and reason.",
    "",
    params.context,
  ].join("\n");
}

function sortReadyCards(a: WorkboardCard, b: WorkboardCard): number {
  const priorityRank: Record<WorkboardCard["priority"], number> = {
    urgent: 0,
    high: 1,
    normal: 2,
    low: 3,
  };
  return (
    priorityRank[a.priority] - priorityRank[b.priority] ||
    a.position - b.position ||
    a.createdAt - b.createdAt
  );
}

function selectStartableCards(cards: WorkboardCard[], limit: number): WorkboardCard[] {
  if (limit <= 0) {
    return [];
  }
  const runningByOwner = new Map<string, number>();
  for (const card of cards) {
    const consumesOwnerSlot =
      card.status === "running" ||
      Boolean(card.metadata?.claim) ||
      card.execution?.status === "running";
    if (!consumesOwnerSlot || cardIsArchived(card)) {
      continue;
    }
    const owner = card.agentId ?? DEFAULT_DISPATCH_OWNER;
    runningByOwner.set(owner, (runningByOwner.get(owner) ?? 0) + 1);
  }
  const selected: WorkboardCard[] = [];
  for (const card of cards
    .filter((entry) => entry.status === "ready" && !entry.metadata?.claim && !cardIsArchived(entry))
    .toSorted(sortReadyCards)) {
    const owner = card.agentId ?? DEFAULT_DISPATCH_OWNER;
    if ((runningByOwner.get(owner) ?? 0) > 0) {
      continue;
    }
    selected.push(card);
    runningByOwner.set(owner, 1);
    if (selected.length >= limit) {
      break;
    }
  }
  return selected;
}

export async function dispatchAndStartWorkboardCards(params: {
  store: WorkboardStore;
  subagent: WorkboardSubagentRuntime;
  options?: WorkboardDispatchStartOptions;
}): Promise<WorkboardDispatchAndStartResult> {
  const now = params.options?.now ?? Date.now();
  const dispatch = await params.store.dispatch(now);
  const maxStarts = normalizePositiveInteger(
    params.options?.maxStarts,
    DEFAULT_DISPATCH_MAX_STARTS,
  );
  const started: WorkboardStartedRun[] = [];
  const startFailures: WorkboardStartFailure[] = [];
  const model = params.options?.model?.trim() || DEFAULT_DISPATCH_MODEL;
  const cards = await params.store.list();

  for (const card of selectStartableCards(cards, maxStarts)) {
    const ownerId = params.options?.ownerId?.trim() || card.agentId || DEFAULT_DISPATCH_OWNER;
    const sessionKey = buildSessionKey(card);
    let token = "";
    try {
      const claimed = await params.store.claim(card.id, {
        ownerId,
        ttlSeconds: card.metadata?.automation?.maxRuntimeSeconds,
      });
      token = claimed.token;
      const context = await params.store.buildWorkerContext(card.id);
      const run = await params.subagent.run({
        sessionKey,
        message: buildWorkerPrompt({
          card: claimed.card,
          context,
          ownerId,
          token,
        }),
        ...(params.options?.provider ? { provider: params.options.provider } : {}),
        ...(params.options?.model ? { model: params.options.model } : {}),
        lane: `workboard:${cardBoardId(card)}:${card.id}`,
        idempotencyKey: `workboard:${card.id}:${claimed.card.updatedAt}`,
        lightContext: true,
        deliver: false,
      });
      const updated = await params.store.update(card.id, {
        sessionKey,
        runId: run.runId,
        execution: buildExecution({
          card: claimed.card,
          sessionKey,
          runId: run.runId,
          model,
          now,
        }),
      });
      await params.store.addWorkerLog(
        updated.id,
        {
          level: "info",
          message: `Dispatcher started subagent run ${run.runId}.`,
          sessionKey,
          runId: run.runId,
        },
        { ownerId, token },
      );
      started.push({
        cardId: updated.id,
        title: updated.title,
        sessionKey,
        runId: run.runId,
      });
    } catch (error) {
      const message = formatErrorMessage(error);
      startFailures.push({ cardId: card.id, title: card.title, error: message });
      if (!token) {
        continue;
      }
      try {
        await params.store.block(
          card.id,
          {
            ownerId,
            token,
            reason: `Dispatcher could not start worker: ${message}`,
          },
          { ownerId, token },
        );
      } catch {
        // Leave the original start failure visible; dispatch will diagnose stale claims later.
      }
    }
  }

  return {
    ...dispatch,
    started,
    startFailures,
    count: dispatch.count + started.length + startFailures.length,
  };
}
