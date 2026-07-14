import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { requestSessionCreate } from "../sessions/index.ts";
import {
  normalizeString,
  replaceCard,
  workboardCardRunId,
  workboardCardSessionKey,
} from "./card-state.ts";
import { formatError, isRecord } from "./normalization-utils.ts";
import { normalizeCardPayload, normalizeTaskSummary } from "./normalization.ts";
import {
  getWorkboardState,
  invalidateWorkboardLoads,
  workboardMutationsReady,
  type WorkboardHost,
} from "./runtime.ts";
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
} from "./types.ts";

const WORKBOARD_ENGINE_MODELS = {
  codex: "openai/gpt-5.6-sol",
  claude: "anthropic/claude-sonnet-4-6",
} as const;
const WORKBOARD_SESSION_LABEL_MAX_CHARS = 512;

function buildCardPrompt(card: WorkboardCard): string {
  const lines = [`Work on this OpenClaw Workboard card: ${card.title}`];
  if (card.notes?.trim()) {
    lines.push("", card.notes.trim());
  }
  if (card.labels.length > 0) {
    lines.push("", `Labels: ${card.labels.join(", ")}`);
  }
  const parents = card.metadata?.links
    ?.filter((link) => link.type === "parent" && link.targetCardId)
    .map((link) => link.targetCardId);
  if (parents?.length) {
    lines.push("", `Parents: ${parents.join(", ")}`);
  }
  if (card.metadata?.automation?.skills?.length) {
    lines.push("", `Suggested skills: ${card.metadata.automation.skills.join(", ")}`);
  }
  if (card.metadata?.automation?.workspace) {
    const workspace = card.metadata.automation.workspace;
    lines.push("", `Workspace: ${workspace.kind}${workspace.path ? ` ${workspace.path}` : ""}`);
  }
  lines.push("", "When done, summarize what changed and what remains.");
  return lines.join("\n");
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

function sanitizeSessionSegment(value: string | undefined, fallback: string): string {
  const sanitized = (value ?? fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (sanitized || fallback).slice(0, 96);
}

function buildCardTaskSessionKey(card: WorkboardCard): string {
  const boardId = sanitizeSessionSegment(card.metadata?.automation?.boardId, "default");
  const cardId = sanitizeSessionSegment(card.id, "card");
  const suffix = `subagent:workboard-${boardId}-${cardId}`;
  const sessionKey = card.agentId
    ? `agent:${sanitizeSessionSegment(card.agentId, "agent")}:${suffix}`
    : suffix;
  const existing = workboardCardSessionKey(card)?.trim();
  return existing === sessionKey ? existing : sessionKey;
}

function buildCardRunIdempotencyKey(card: WorkboardCard): string {
  const boardId = sanitizeSessionSegment(card.metadata?.automation?.boardId, "default");
  const cardId = sanitizeSessionSegment(card.id, "card");
  return `workboard:${boardId}:${cardId}:${card.updatedAt}`;
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
  return {
    id: params.card.execution?.id ?? `${params.card.id}:${params.engine}`,
    kind: "agent-session",
    engine: params.engine,
    mode: params.mode,
    status: params.status,
    model: WORKBOARD_ENGINE_MODELS[params.engine],
    startedAt: now,
    updatedAt: now,
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

async function abortWorkboardSessionRun(params: {
  client: GatewayBrowserClient;
  sessionKey: string;
  runId?: string;
}): Promise<boolean> {
  let abortResult = await params.client.request("chat.abort", {
    sessionKey: params.sessionKey,
    ...(params.runId ? { runId: params.runId } : {}),
  });
  let aborted =
    isRecord(abortResult) &&
    (abortResult.aborted === true ||
      (Array.isArray(abortResult.runIds) && abortResult.runIds.length > 0));
  if (!aborted && params.runId) {
    abortResult = await params.client.request("chat.abort", {
      sessionKey: params.sessionKey,
    });
    aborted =
      isRecord(abortResult) &&
      (abortResult.aborted === true ||
        (Array.isArray(abortResult.runIds) && abortResult.runIds.length > 0));
  }
  return aborted;
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
  state.error = null;
  if (mode === "autonomous" && isScheduledForLater(params.card)) {
    state.error = "Scheduled cards cannot start before their scheduled time.";
    params.requestUpdate?.();
    return null;
  }
  invalidateWorkboardLoads(params.host);
  state.busyCardIds.add(params.card.id);
  params.requestUpdate?.();
  let preflightCard: WorkboardCard | null = null;
  let createdSessionKey: string | null = null;
  let createdRunId: string | undefined;
  try {
    const shouldClearManualSchedule =
      mode === "manual" && params.card.metadata?.automation?.scheduledAt !== undefined;
    const shouldUnscheduleManual = mode === "manual" && params.card.status === "scheduled";
    const nextCardStatus =
      mode === "autonomous" ? "running" : shouldUnscheduleManual ? "todo" : params.card.status;
    const nextExecutionStatus = mode === "autonomous" ? "running" : "idle";
    let card = params.card;
    if (mode === "autonomous") {
      const preflightPayload = await params.client.request("workboard.cards.update", {
        id: params.card.id,
        patch: { status: nextCardStatus },
      });
      preflightCard = normalizeCardPayload(preflightPayload);
      if (preflightCard) {
        replaceCard(state, preflightCard);
        card = preflightCard;
      }
    }
    const created =
      mode === "autonomous"
        ? await params.client.request("agent", {
            sessionKey: buildCardTaskSessionKey(card),
            ...(card.agentId ? { agentId: card.agentId } : {}),
            label: buildCardSessionLabel(card),
            ...(engine ? { model: WORKBOARD_ENGINE_MODELS[engine] } : {}),
            message: buildCardPrompt(card),
            deliver: false,
            bootstrapContextMode: "lightweight",
            idempotencyKey: buildCardRunIdempotencyKey(card),
          })
        : await requestSessionCreate(params.client, {
            ...(card.agentId ? { agentId: card.agentId } : {}),
            label: buildCardSessionLabel(card),
            ...(engine ? { model: WORKBOARD_ENGINE_MODELS[engine] } : {}),
          });
    const sessionKey =
      isRecord(created) && typeof created.sessionKey === "string" && created.sessionKey.trim()
        ? created.sessionKey.trim()
        : isRecord(created) && typeof created.key === "string" && created.key.trim()
          ? created.key.trim()
          : mode === "autonomous"
            ? buildCardTaskSessionKey(card)
            : null;
    const runId =
      isRecord(created) && typeof created.runId === "string" && created.runId.trim()
        ? created.runId.trim()
        : undefined;
    if (mode === "autonomous" && !runId) {
      throw new Error("Gateway agent method returned an invalid runId.");
    }
    createdSessionKey = sessionKey;
    createdRunId = runId;
    const task =
      mode === "autonomous" && sessionKey
        ? await findTaskForStartedRun({
            client: params.client,
            card,
            sessionKey,
            runId,
          })
        : null;
    const payload = await params.client.request("workboard.cards.update", {
      id: params.card.id,
      patch: {
        status: nextCardStatus,
        ...(shouldClearManualSchedule ? { scheduledAt: null } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        runId: runId ?? null,
        taskId: task?.taskId ?? null,
        ...(engine
          ? {
              execution: buildWorkboardExecution({
                card,
                engine,
                mode,
                sessionKey,
                runId,
                status: nextExecutionStatus,
              }),
            }
          : { execution: null }),
      },
    });
    replaceCard(state, normalizeCardPayload(payload));
    if (task) {
      state.tasksByCardId.set(params.card.id, task);
    } else {
      state.tasksByCardId.delete(params.card.id);
    }
    return sessionKey;
  } catch (error) {
    if (mode === "autonomous" && createdSessionKey) {
      try {
        await abortWorkboardSessionRun({
          client: params.client,
          sessionKey: createdSessionKey,
          runId: createdRunId,
        });
      } catch {
        // Preserve the card-start failure; the user-facing repair is the rollback below.
      }
    }
    if (preflightCard) {
      try {
        const rollbackPayload = await params.client.request("workboard.cards.update", {
          id: params.card.id,
          patch: {
            status: params.card.status,
            startedAt: params.card.startedAt ?? null,
            completedAt: params.card.completedAt ?? null,
            ...(params.card.execution !== undefined ? { execution: params.card.execution } : {}),
          },
        });
        replaceCard(state, normalizeCardPayload(rollbackPayload) ?? params.card);
      } catch {
        replaceCard(state, params.card);
      }
    }
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
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  const sessionKey = workboardCardSessionKey(params.card);
  const task = state.tasksByCardId.get(params.card.id);
  const cardTaskId = normalizeString(params.card.taskId);
  const taskId = cardTaskId && !state.missingTaskIds.has(cardTaskId) ? cardTaskId : task?.taskId;
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.dispatching ||
    state.busyCardIds.has(params.card.id) ||
    (!sessionKey && !taskId)
  ) {
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.busyCardIds.add(params.card.id);
  state.error = null;
  params.requestUpdate?.();
  try {
    let taskStopped = false;
    if (taskId && (!task || taskIsActive(task))) {
      try {
        const cancelled = await cancelWorkboardTaskRun({
          client: params.client,
          taskId,
        });
        if (cancelled.missing) {
          state.missingTaskIds.add(taskId);
          if (task?.taskId === taskId || task?.id === taskId) {
            state.tasksByCardId.delete(params.card.id);
          }
          taskStopped = !sessionKey;
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
        if (!isMissingTaskLookupError(error, taskId)) {
          throw error;
        }
        state.missingTaskIds.add(taskId);
        if (task?.taskId === taskId || task?.id === taskId) {
          state.tasksByCardId.delete(params.card.id);
        }
        taskStopped = !sessionKey;
      }
    }
    let sessionAborted = false;
    if (sessionKey) {
      try {
        sessionAborted = await abortWorkboardSessionRun({
          client: params.client,
          sessionKey,
          runId: workboardCardRunId(params.card),
        });
      } catch (error) {
        if (!taskStopped) {
          throw error;
        }
      }
    }
    if (!taskStopped && !sessionAborted) {
      return;
    }
    const payload = await params.client.request("workboard.cards.update", {
      id: params.card.id,
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
    replaceCard(state, normalizeCardPayload(payload));
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.busyCardIds.delete(params.card.id);
    params.requestUpdate?.();
  }
}
