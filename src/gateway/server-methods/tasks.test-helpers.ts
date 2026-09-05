import { expectDefined } from "@openclaw/normalization-core";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { tasksHandlers } from "./tasks.js";
import type { GatewayClient, RespondFn } from "./types.js";

type TaskResponsePayload = {
  tasks?: Array<Record<string, unknown>>;
  task?: Record<string, unknown>;
  found?: boolean;
  cancelled?: boolean;
  nextCursor?: string;
  results?: Array<{ taskId?: string; ok?: boolean; reason?: string }>;
};

export function identifiedClient(
  scopes: string[],
  profileId = "viewer@example.com",
): GatewayClient {
  return {
    connId: `conn-${profileId}-${scopes.join("-")}`,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes,
    },
    authenticatedUserId: "viewer@example.com",
    authenticatedUserProfile: {
      profileId,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

export function captureRespond() {
  const calls: Parameters<RespondFn>[] = [];
  const respond: RespondFn = (...args) => {
    calls.push(args);
  };
  return { calls, respond };
}

export function createContext(config: Record<string, unknown> = {}) {
  return {
    getRuntimeConfig: () => config,
  } as never;
}

export function createSnapshotTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: "task-snapshot",
    runtime: "cli",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    runId: "run-snapshot",
    task: "Snapshot task",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt: 1_000,
    startedAt: 1_010,
    lastEventAt: 1_010,
    ...overrides,
  };
}

export async function runTaskHandler(
  method: "tasks.list" | "tasks.get" | "tasks.cancel" | "tasks.retry" | "tasks.dismiss",
  params: Record<string, unknown>,
  config: Record<string, unknown> = {},
  client: GatewayClient | null = null,
  context = createContext(config),
) {
  const { calls, respond } = captureRespond();
  await expectDefined(
    tasksHandlers[method],
    "tasksHandlers[method] test invariant",
  )({
    req: { type: "req", id: `req-${method}`, method },
    params,
    respond,
    context,
    client,
    isWebchatConnect: () => false,
  });
  return {
    calls,
    payload: calls[0]?.[1] as TaskResponsePayload | undefined,
  };
}
