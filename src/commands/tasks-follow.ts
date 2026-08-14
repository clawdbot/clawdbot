// Task-scoped CLI follow stream over the Gateway's bounded task and chat projections.

import { createHash, randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { TaskSummary } from "../../packages/gateway-protocol/src/index.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatLookupMiss } from "../cli/error-format.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveGatewayClientBootstrap } from "../gateway/client-bootstrap.js";
import { startGatewayClientWhenEventLoopReady } from "../gateway/client-start-readiness.js";
import { GatewayClient } from "../gateway/client.js";
import { redactSensitiveText } from "../logging/redact.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { reconcileTaskLookupToken } from "../tasks/task-registry.reconcile.js";
import { VERSION } from "../version.js";

const INITIAL_CONNECT_TIMEOUT_MS = 15_000;
const HISTORY_LIMIT = 20;
const HISTORY_MAX_CHARS = 20_000;
const MESSAGE_TEXT_MAX_CHARS = 1_000;
const MAX_REMEMBERED_EVENT_IDS = 2_048;

type FollowTaskEventKind =
  | "connection.disconnected"
  | "connection.gap"
  | "connection.reconnected"
  | "session.message"
  | "task.deleted"
  | "task.snapshot"
  | "task.update";

type FollowTaskEvent = {
  id: string;
  cursor: string;
  timestamp: string;
  taskId: string;
  runtime: string;
  kind: FollowTaskEventKind;
  gatewaySeq?: number;
  sessionKey?: string;
  state: Record<string, unknown>;
};

type TaskEventPayload =
  | { action: "upserted"; task: TaskSummary }
  | { action: "deleted"; taskId: string }
  | { action: "restored" };

type ChatHistoryResult = {
  messages?: unknown[];
};

type TasksGetResult = {
  task?: TaskSummary;
};

function stableEventId(kind: FollowTaskEventKind, value: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
  return `${kind}:${digest}`;
}

function timestampToIso(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function truncateText(value: string): string {
  const sanitized = redactSensitiveText(sanitizeTerminalText(value), { mode: "tools" }).trim();
  if (sanitized.length <= MESSAGE_TEXT_MAX_CHARS) {
    return sanitized;
  }
  return truncateWithMarker(sanitized, MESSAGE_TEXT_MAX_CHARS, {
    marker: "…",
    reserve: 1,
    trimEnd: false,
  });
}

function normalizeTaskEventPayload(value: unknown): TaskEventPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.action === "restored") {
    return { action: "restored" };
  }
  if (value.action === "deleted" && typeof value.taskId === "string") {
    return { action: "deleted", taskId: value.taskId };
  }
  if (value.action !== "upserted" || !isRecord(value.task)) {
    return null;
  }
  const task = value.task as TaskSummary;
  return typeof task.id === "string" && typeof task.status === "string"
    ? { action: "upserted", task }
    : null;
}

function extractVisibleMessageText(message: Record<string, unknown>): string | undefined {
  const role = normalizeOptionalString(message.role);
  if (role !== "user" && role !== "assistant") {
    return undefined;
  }
  const content = message.content;
  if (typeof content === "string") {
    return truncateText(content) || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((block) => {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
        return [];
      }
      return [block.text];
    })
    .join("\n");
  return truncateText(text) || undefined;
}

function readMessageMetadata(message: Record<string, unknown>): {
  id?: string;
  seq?: number;
  timestamp?: unknown;
} {
  const openClawMetadata = message["__openclaw"];
  const metadata = isRecord(openClawMetadata) ? openClawMetadata : undefined;
  return {
    ...(typeof metadata?.id === "string" ? { id: metadata.id } : {}),
    ...(typeof metadata?.seq === "number" ? { seq: metadata.seq } : {}),
    timestamp: metadata?.recordTimestampMs ?? message.timestamp,
  };
}

function projectHistoryEvents(task: TaskSummary, messages: unknown[]): FollowTaskEvent[] {
  const sessionKey = normalizeOptionalString(task.childSessionKey);
  if (!sessionKey) {
    return [];
  }
  const events: FollowTaskEvent[] = [];
  for (const candidate of messages) {
    if (!isRecord(candidate)) {
      continue;
    }
    const text = extractVisibleMessageText(candidate);
    const role = normalizeOptionalString(candidate.role);
    if (!text || (role !== "user" && role !== "assistant")) {
      continue;
    }
    const metadata = readMessageMetadata(candidate);
    const identity = {
      taskId: task.id,
      sessionKey,
      role,
      seq: metadata.seq,
      messageId: metadata.id,
      text,
    };
    const id = stableEventId("session.message", identity);
    events.push({
      id,
      cursor: id,
      timestamp: timestampToIso(metadata.timestamp ?? task.updatedAt),
      taskId: task.id,
      runtime: task.runtime ?? task.kind ?? "unknown",
      kind: "session.message",
      sessionKey,
      state: {
        role,
        text,
        ...(metadata.seq !== undefined ? { seq: metadata.seq } : {}),
        ...(metadata.id ? { messageId: metadata.id } : {}),
      },
    });
  }
  return events;
}

function projectTaskEvent(
  task: TaskSummary,
  kind: "task.snapshot" | "task.update",
  gatewaySeq?: number,
): FollowTaskEvent {
  const state = {
    status: task.status,
    deliveryStatus: task.deliveryStatus ?? null,
    terminalOutcome: task.terminalOutcome ?? null,
    title: task.title ?? null,
    progressSummary: task.progressSummary ?? null,
    terminalSummary: task.terminalSummary ?? null,
    error: task.error ?? null,
    toolUseCount: task.toolUseCount ?? 0,
    lastToolName: task.lastToolName ?? null,
    lastActivity: task.lastActivity ?? null,
  };
  // Snapshot replay and live updates share an identity so reconnects cannot
  // make the same durable task version look like a new event.
  const id = stableEventId("task.update", {
    taskId: task.id,
    updatedAt: task.updatedAt,
    state,
  });
  return {
    id,
    cursor: id,
    timestamp: timestampToIso(task.updatedAt ?? task.endedAt ?? task.startedAt ?? task.createdAt),
    taskId: task.id,
    runtime: task.runtime ?? task.kind ?? "unknown",
    kind,
    ...(gatewaySeq !== undefined ? { gatewaySeq } : {}),
    ...(task.childSessionKey ? { sessionKey: task.childSessionKey } : {}),
    state,
  };
}

function isFollowTerminal(task: TaskSummary): boolean {
  const executionTerminal = ["completed", "failed", "cancelled", "timed_out"].includes(task.status);
  const deliveryTerminal = [
    "delivered",
    "dismissed",
    "failed",
    "not_applicable",
    "parent_missing",
  ].includes(task.deliveryStatus ?? "");
  return executionTerminal && deliveryTerminal;
}

function formatHumanEvent(event: FollowTaskEvent): string {
  const prefix = `${event.timestamp} [${event.kind}]`;
  if (event.kind === "session.message") {
    const role = normalizeOptionalString(event.state.role) ?? "message";
    const text = normalizeOptionalString(event.state.text) ?? "";
    return `${prefix} ${role}: ${text}`;
  }
  if (event.kind.startsWith("connection.")) {
    const message = normalizeOptionalString(event.state.message) ?? "Gateway connection changed";
    return `${prefix} ${message}`;
  }
  if (event.kind === "task.deleted") {
    return `${prefix} task record removed`;
  }
  const parts = [normalizeOptionalString(event.state.status) ?? "unknown"];
  const deliveryStatus = normalizeOptionalString(event.state.deliveryStatus);
  if (deliveryStatus) {
    parts.push(`delivery ${deliveryStatus}`);
  }
  const lastToolName = normalizeOptionalString(event.state.lastToolName);
  if (lastToolName) {
    parts.push(`tool ${lastToolName}`);
  }
  const detail = [
    event.state.error,
    event.state.terminalSummary,
    event.state.progressSummary,
    event.state.lastActivity,
  ]
    .map((value) => normalizeOptionalString(value))
    .find(Boolean);
  if (detail) {
    parts.push(detail);
  }
  return `${prefix} ${parts.join(" · ")}`;
}

function createFollowEvent(params: {
  kind: "connection.disconnected" | "connection.gap" | "connection.reconnected" | "task.deleted";
  taskId: string;
  runtime: string;
  generation: number;
  state: Record<string, unknown>;
}): FollowTaskEvent {
  const timestamp = new Date().toISOString();
  const id = stableEventId(params.kind, {
    taskId: params.taskId,
    generation: params.generation,
    state: params.state,
  });
  return {
    id,
    cursor: id,
    timestamp,
    taskId: params.taskId,
    runtime: params.runtime,
    kind: params.kind,
    state: params.state,
  };
}

/** Follows one durable task without mutating its execution or delivery state. */
export async function tasksFollowCommand(
  opts: { json?: boolean; lookup: string },
  runtime: RuntimeEnv,
): Promise<void> {
  const localTask = reconcileTaskLookupToken(opts.lookup);
  if (!localTask) {
    runtime.error(
      formatLookupMiss({
        noun: "Task",
        value: sanitizeTerminalText(opts.lookup),
        listCommand: "openclaw tasks list",
        valueLabel: "task id",
      }),
    );
    runtime.exit(1);
    return;
  }

  const taskId = localTask.taskId;
  const taskRuntime = localTask.runtime;
  const seenIds = new Set<string>();
  const seenOrder: string[] = [];
  let client: GatewayClient | undefined;
  let connected = false;
  let connectionGeneration = 0;
  let disconnectedGeneration: number | undefined;
  let done = false;
  let abortedByViewer = false;
  let processing = Promise.resolve();
  let resolveCompletion: (() => void) | undefined;
  let rejectCompletion: ((error: Error) => void) | undefined;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const emit = (event: FollowTaskEvent) => {
    if (seenIds.has(event.id)) {
      return;
    }
    seenIds.add(event.id);
    seenOrder.push(event.id);
    if (seenOrder.length > MAX_REMEMBERED_EVENT_IDS) {
      const oldest = seenOrder.shift();
      if (oldest) {
        seenIds.delete(oldest);
      }
    }
    if (opts.json) {
      writeRuntimeJson(runtime, event, 0);
    } else {
      runtime.log(formatHumanEvent(event));
    }
  };

  const finish = () => {
    if (done) {
      return;
    }
    done = true;
    resolveCompletion?.();
  };
  const fail = (error: unknown) => {
    if (done) {
      return;
    }
    done = true;
    rejectCompletion?.(error instanceof Error ? error : new Error(String(error)));
  };
  const enqueue = (operation: () => Promise<void>) => {
    processing = processing
      .then(async () => {
        if (!done) {
          await operation();
        }
      })
      .catch(fail);
  };

  const replayHistory = async (task: TaskSummary) => {
    const sessionKey = normalizeOptionalString(task.childSessionKey);
    if (!sessionKey || !client) {
      return;
    }
    const result = await client.request<ChatHistoryResult>("chat.history", {
      sessionKey,
      ...(task.agentId ? { agentId: task.agentId } : {}),
      limit: HISTORY_LIMIT,
      maxChars: HISTORY_MAX_CHARS,
    });
    for (const event of projectHistoryEvents(task, result.messages ?? [])) {
      emit(event);
    }
  };

  const replaySnapshot = async (kind: "task.snapshot" | "task.update", seq?: number) => {
    if (!client) {
      return;
    }
    const result = await client.request<TasksGetResult>("tasks.get", { taskId });
    if (!result.task) {
      throw new Error(`Gateway returned no task for ${taskId}`);
    }
    emit(projectTaskEvent(result.task, kind, seq));
    await replayHistory(result.task);
    if (isFollowTerminal(result.task)) {
      finish();
    }
  };

  const config = getRuntimeConfig();
  const bootstrap = await resolveGatewayClientBootstrap({ config, env: process.env });
  if (bootstrap.authFailureReason) {
    runtime.error(bootstrap.authFailureReason);
    runtime.exit(1);
    return;
  }

  const initialTimer = setTimeout(() => {
    fail(new Error(`Timed out connecting to the Gateway while following ${taskId}`));
  }, INITIAL_CONNECT_TIMEOUT_MS);
  const abortViewer = () => {
    abortedByViewer = true;
    finish();
  };
  process.once("SIGINT", abortViewer);

  try {
    client = new GatewayClient({
      url: bootstrap.url,
      token: bootstrap.auth.token,
      password: bootstrap.auth.password,
      tlsFingerprint: bootstrap.tlsFingerprint,
      preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs,
      ...(bootstrap.deviceAuthScope ? { deviceAuthScope: bootstrap.deviceAuthScope } : {}),
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      clientDisplayName: "openclaw-tasks-follow",
      clientVersion: VERSION,
      platform: process.platform,
      mode: GATEWAY_CLIENT_MODES.CLI,
      scopes: ["operator.read"],
      instanceId: randomUUID(),
      onHelloOk: () => {
        clearTimeout(initialTimer);
        connectionGeneration += 1;
        disconnectedGeneration = undefined;
        const reconnecting = connected;
        const generation = connectionGeneration;
        connected = true;
        enqueue(async () => {
          if (reconnecting) {
            emit(
              createFollowEvent({
                kind: "connection.reconnected",
                taskId,
                runtime: taskRuntime,
                generation,
                state: { message: "Gateway reconnected; replaying durable task state" },
              }),
            );
          }
          await replaySnapshot("task.snapshot");
        });
      },
      onEvent: (event) => {
        if (event.event !== "task") {
          return;
        }
        const payload = normalizeTaskEventPayload(event.payload);
        if (!payload) {
          return;
        }
        if (payload.action === "restored") {
          enqueue(async () => await replaySnapshot("task.snapshot", event.seq));
          return;
        }
        if (payload.action === "deleted") {
          if (payload.taskId !== taskId) {
            return;
          }
          enqueue(async () => {
            emit(
              createFollowEvent({
                kind: "task.deleted",
                taskId,
                runtime: taskRuntime,
                generation: connectionGeneration,
                state: { message: "Task record was removed before a final state was observed" },
              }),
            );
            throw new Error(`Task record removed while following ${taskId}`);
          });
          return;
        }
        if (payload.task.id !== taskId) {
          return;
        }
        enqueue(async () => {
          emit(projectTaskEvent(payload.task, "task.update", event.seq));
          await replayHistory(payload.task);
          if (isFollowTerminal(payload.task)) {
            finish();
          }
        });
      },
      onGap: (gap) => {
        enqueue(async () => {
          emit(
            createFollowEvent({
              kind: "connection.gap",
              taskId,
              runtime: taskRuntime,
              generation: connectionGeneration,
              state: {
                message: `Gateway event gap ${gap.expected}-${gap.received}; replaying durable task state`,
                expected: gap.expected,
                received: gap.received,
              },
            }),
          );
          await replaySnapshot("task.snapshot");
        });
      },
      onClose: (_code, reason) => {
        if (!done && connected && disconnectedGeneration !== connectionGeneration) {
          disconnectedGeneration = connectionGeneration;
          enqueue(async () => {
            emit(
              createFollowEvent({
                kind: "connection.disconnected",
                taskId,
                runtime: taskRuntime,
                generation: connectionGeneration,
                state: {
                  message: `Gateway disconnected${reason ? `: ${truncateText(reason)}` : ""}; reconnecting`,
                },
              }),
            );
          });
        }
      },
      onReconnectPaused: (info) => {
        fail(new Error(`Gateway reconnect paused: ${info.reason}`));
      },
    });

    const readiness = await startGatewayClientWhenEventLoopReady(client, { clientOptions: {} });
    if (!readiness.ready) {
      throw new Error(
        readiness.aborted
          ? "Gateway client start was aborted"
          : "Gateway event loop was not ready for task follow",
      );
    }
    await completion;
    if (!abortedByViewer) {
      await processing;
    }
  } catch (error) {
    if (abortedByViewer) {
      return;
    }
    runtime.error(
      redactSensitiveText(error instanceof Error ? error.message : String(error), {
        mode: "tools",
      }),
    );
    runtime.exit(1);
  } finally {
    clearTimeout(initialTimer);
    process.removeListener("SIGINT", abortViewer);
    await client?.stopAndWait().catch(() => client?.stop());
  }
}
