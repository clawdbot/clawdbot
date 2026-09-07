import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { isRecord, truncateUtf16Safe } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { requestSessionCreate } from "../sessions/index.ts";
import { normalizeTaskSummary } from "../tasks/task-summary.ts";
import {
  normalizeString,
  replaceCard,
  workboardCardRunId,
  workboardCardSessionKey,
} from "./card-state.ts";
import { formatError } from "./normalization-utils.ts";
import { normalizeCardPayload } from "./normalization.ts";
import {
  getWorkboardState,
  invalidateWorkboardLoads,
  workboardMutationsReady,
  type WorkboardHost,
} from "./runtime.ts";
import { workboardCardSessionTarget } from "./session-resolution.ts";
import {
  isMissingTaskLookupError,
  listWorkboardTasks,
  taskMatchesCard,
  taskUpdatedAtValue,
  WORKBOARD_TASK_LOOKUP_RETRY_DELAYS_MS,
} from "./task-links.ts";
import type {
  WorkboardCard,
  WorkboardExecution,
  WorkboardExecutionEngine,
  WorkboardExecutionMode,
  WorkboardExecutionStatus,
  WorkboardTaskSummary,
  WorkboardUiState,
} from "./types.ts";

const WORKBOARD_ENGINE_MODELS = {
  codex: "openai/gpt-5.6-sol",
  claude: "anthropic/claude-sonnet-4-6",
} as const;
const WORKBOARD_SESSION_LABEL_MAX_CHARS = 512;

export function canStartWorkboardCard(state: WorkboardUiState, card: WorkboardCard): boolean {
  const task = state.tasksByCardId.get(card.id);
  return (
    !workboardCardSessionKey(card) &&
    !taskIsActive(task) &&
    !(card.taskId && !task && !state.missingTaskIds.has(card.taskId))
  );
}

function assertCurrentCard(state: WorkboardUiState, card: WorkboardCard): void {
  const current = state.cards.find((candidate) => candidate.id === card.id);
  // Page hiding closes admission; an existing action still owns this revision.
  if (!current || current.updatedAt !== card.updatedAt) {
    throw new Error("This card changed. Refresh its details before starting or stopping it.");
  }
}

function engineModel(engine: WorkboardExecutionEngine | null | undefined): string | undefined {
  return engine === "codex"
    ? WORKBOARD_ENGINE_MODELS.codex
    : engine === "claude"
      ? WORKBOARD_ENGINE_MODELS.claude
      : undefined;
}

function buildCardSessionLabel(card: WorkboardCard): string {
  const suffix = card.id.trim().slice(0, 8) || "card";
  const title = card.title.trim() || "Workboard card";
  const suffixText = ` (${suffix})`;
  if (title.length + suffixText.length <= WORKBOARD_SESSION_LABEL_MAX_CHARS) {
    return `${title}${suffixText}`;
  }
  const titleMax = WORKBOARD_SESSION_LABEL_MAX_CHARS - suffixText.length;
  return `${truncateUtf16Safe(title, titleMax - 3).trimEnd()}...${suffixText}`;
}

function isScheduledForLater(card: WorkboardCard, now = Date.now()): boolean {
  const scheduledAt = card.metadata?.automation?.scheduledAt;
  if (typeof scheduledAt === "number") {
    return scheduledAt > now;
  }
  return card.status === "scheduled";
}

function buildWorkboardExecution(params: {
  card: WorkboardCard;
  engine: WorkboardExecutionEngine;
  mode: WorkboardExecutionMode;
  sessionKey?: string | null;
  runId?: string;
  status: WorkboardExecutionStatus;
}): WorkboardExecution {
  const now = Date.now();
  const model = engineModel(params.engine);
  return {
    id: params.card.execution?.id ?? `${params.card.id}:agent-session`,
    kind: "agent-session",
    engine: params.engine,
    mode: params.mode,
    status: params.status,
    startedAt: now,
    updatedAt: now,
    ...(model ? { model } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
  };
}

async function findTaskForStartedRun(params: {
  client: GatewayBrowserClient;
  card: WorkboardCard;
  sessionKey: string;
  runId?: string;
}): Promise<WorkboardTaskSummary | null> {
  const probeCard = {
    ...params.card,
    taskId: undefined,
    sessionKey: params.sessionKey,
    ...(params.runId ? { runId: params.runId } : {}),
  };
  for (const delayMs of [0, ...WORKBOARD_TASK_LOOKUP_RETRY_DELAYS_MS]) {
    if (delayMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
    let task: WorkboardTaskSummary | null = null;
    try {
      task =
        (await listWorkboardTasks(params.client))
          .filter((candidate) => taskMatchesCard(candidate, probeCard))
          .toSorted((left, right) => taskUpdatedAtValue(right) - taskUpdatedAtValue(left))[0] ??
        null;
    } catch {
      // Task registration/linkage is best effort after the run already started.
    }
    if (task) {
      return task;
    }
  }
  return null;
}

function workboardRunWasAborted(result: unknown): boolean {
  return (
    isRecord(result) &&
    (result.aborted === true || (Array.isArray(result.runIds) && result.runIds.length > 0))
  );
}

async function abortWorkboardSessionRun(params: {
  client: GatewayBrowserClient;
  session: BoardGetParams;
  runId?: string;
  assertCurrent: () => void;
}): Promise<boolean> {
  const targetedAbort = await params.client.request("chat.abort", {
    ...params.session,
    ...(params.runId ? { runId: params.runId } : {}),
  });
  params.assertCurrent();
  const aborted = workboardRunWasAborted(targetedAbort);
  if (aborted || !params.runId) {
    return aborted;
  }
  // A card run id that no longer names the live run aborts nothing, so retry
  // session-wide before reporting failure; otherwise Stop strands an active run.
  return workboardRunWasAborted(await params.client.request("chat.abort", params.session));
}

function taskIsActive(task: WorkboardTaskSummary | undefined): task is WorkboardTaskSummary {
  return task?.status === "queued" || task?.status === "running";
}

async function cancelWorkboardTaskRun(params: {
  client: GatewayBrowserClient;
  taskId: string;
}): Promise<{ cancelled: boolean; missing: boolean; task: WorkboardTaskSummary | null }> {
  const result = await params.client.request("tasks.cancel", {
    taskId: params.taskId,
    reason: "Stopped from Workboard.",
  });
  return {
    cancelled: isRecord(result) && result.cancelled === true,
    missing: isRecord(result) && result.found === false,
    task: isRecord(result) ? normalizeTaskSummary(result.task) : null,
  };
}

export async function startWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  card: WorkboardCard;
  engine?: WorkboardExecutionEngine;
  mode?: WorkboardExecutionMode;
  requestUpdate?: () => void;
}): Promise<string | null> {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.dispatching ||
    state.busyCardIds.has(params.card.id)
  ) {
    return null;
  }
  const engine = params.engine;
  const mode = params.mode ?? "autonomous";
  const model = engineModel(engine);
  state.error = null;
  if (mode === "autonomous" && isScheduledForLater(params.card)) {
    state.error = "Scheduled cards cannot start before their scheduled time.";
    params.requestUpdate?.();
    return null;
  }
  invalidateWorkboardLoads(params.host);
  state.busyCardIds.add(params.card.id);
  params.requestUpdate?.();
  try {
    assertCurrentCard(state, params.card);
    if (!canStartWorkboardCard(state, params.card)) {
      throw new Error(
        "This card already has an execution. Refresh its details or use Edit to clear its session link before starting another.",
      );
    }
    if (mode === "autonomous") {
      const separator = model?.indexOf("/") ?? -1;
      const payload = await params.client.request("workboard.cards.start", {
        id: params.card.id,
        ...(separator > 0
          ? { provider: model?.slice(0, separator), model: model?.slice(separator + 1) }
          : {}),
      });
      assertCurrentCard(state, params.card);
      const card = normalizeCardPayload(payload);
      replaceCard(state, card);
      const sessionKey = workboardCardSessionKey(card);
      const runId = workboardCardRunId(card);
      const task = sessionKey
        ? await findTaskForStartedRun({ client: params.client, card, sessionKey, runId })
        : null;
      assertCurrentCard(state, card);
      if (task) {
        state.tasksByCardId.set(card.id, task);
      } else {
        state.tasksByCardId.delete(card.id);
      }
      return sessionKey ?? null;
    }
    const shouldClearManualSchedule = params.card.metadata?.automation?.scheduledAt !== undefined;
    const shouldUnscheduleManual = params.card.status === "scheduled";
    const nextCardStatus = shouldUnscheduleManual ? "todo" : params.card.status;
    const created = await requestSessionCreate(params.client, {
      ...(params.card.agentId ? { agentId: params.card.agentId } : {}),
      label: buildCardSessionLabel(params.card),
      ...(model ? { model } : {}),
    });
    assertCurrentCard(state, params.card);
    const sessionKey = created.key.trim() || null;
    const payload = await params.client.request("workboard.cards.update", {
      id: params.card.id,
      expectedUpdatedAt: params.card.updatedAt,
      patch: {
        status: nextCardStatus,
        ...(shouldClearManualSchedule ? { scheduledAt: null } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        runId: null,
        taskId: null,
        ...(engine
          ? {
              execution: buildWorkboardExecution({
                card: params.card,
                engine,
                mode,
                sessionKey,
                status: "idle",
              }),
            }
          : { execution: null }),
      },
    });
    assertCurrentCard(state, params.card);
    replaceCard(state, normalizeCardPayload(payload));
    state.tasksByCardId.delete(params.card.id);
    return sessionKey;
  } catch (error) {
    state.error = formatError(error);
    return null;
  } finally {
    state.busyCardIds.delete(params.card.id);
    params.requestUpdate?.();
  }
}

export async function stopWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  card: WorkboardCard;
  session?: BoardGetParams;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  const linkedSessionKey = workboardCardSessionKey(params.card);
  const session = workboardCardSessionTarget(params.card, params.session);
  const task = state.tasksByCardId.get(params.card.id);
  const cardTaskId = normalizeString(params.card.taskId);
  const taskId = cardTaskId && !state.missingTaskIds.has(cardTaskId) ? cardTaskId : task?.taskId;
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.dispatching ||
    state.busyCardIds.has(params.card.id) ||
    (!linkedSessionKey && !taskId)
  ) {
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.busyCardIds.add(params.card.id);
  state.error = null;
  params.requestUpdate?.();
  const assertCurrent = () => assertCurrentCard(state, params.card);
  try {
    assertCurrent();
    let taskStopped = false;
    if (taskId && (!task || taskIsActive(task))) {
      try {
        const cancelled = await cancelWorkboardTaskRun({
          client: params.client,
          taskId,
        });
        assertCurrent();
        if (cancelled.missing) {
          state.missingTaskIds.add(taskId);
          if (task?.taskId === taskId || task?.id === taskId) {
            state.tasksByCardId.delete(params.card.id);
          }
          taskStopped = !linkedSessionKey;
        } else if (cancelled.cancelled) {
          taskStopped = true;
          state.tasksByCardId.set(
            params.card.id,
            cancelled.task ?? {
              ...(task ?? { id: taskId, taskId }),
              status: "cancelled",
              updatedAt: Date.now(),
            },
          );
        }
      } catch (error) {
        assertCurrent();
        if (!isMissingTaskLookupError(error, taskId)) {
          throw error;
        }
        state.missingTaskIds.add(taskId);
        if (task?.taskId === taskId || task?.id === taskId) {
          state.tasksByCardId.delete(params.card.id);
        }
        taskStopped = !linkedSessionKey;
      }
    }
    let sessionAborted = false;
    if (session) {
      try {
        sessionAborted = await abortWorkboardSessionRun({
          client: params.client,
          session,
          runId: workboardCardRunId(params.card),
          assertCurrent,
        });
      } catch (error) {
        if (!taskStopped) {
          throw error;
        }
      }
    }
    assertCurrent();
    if (!taskStopped && !sessionAborted) {
      if (linkedSessionKey && !session) {
        throw new Error(
          "Refresh this card's session details before stopping it, or use Edit to choose its session.",
        );
      }
      return;
    }
    const payload = await params.client.request("workboard.cards.update", {
      id: params.card.id,
      expectedUpdatedAt: params.card.updatedAt,
      patch: {
        status: "blocked",
        ...(params.card.execution
          ? {
              execution: {
                ...params.card.execution,
                status: "blocked",
                updatedAt: Date.now(),
              },
            }
          : {}),
      },
    });
    assertCurrent();
    replaceCard(state, normalizeCardPayload(payload));
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.busyCardIds.delete(params.card.id);
    params.requestUpdate?.();
  }
}
