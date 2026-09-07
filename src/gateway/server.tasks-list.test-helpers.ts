import path from "node:path";
import { expect } from "vitest";
import { writeConfigFile } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  onceMessage,
  openWs,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

const BROWSER_ORIGIN = "https://control.example.com";
export const TASK_COUNT = 10_000;
export const OWNED_SESSION_KEY = "agent:main:tasks-owned";
export const FOREIGN_SESSION_KEY = "agent:main:tasks-foreign";

export type RpcResponse<T extends Record<string, unknown>> = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: T;
  error?: { code?: string; message?: string; retryable?: boolean; retryAfterMs?: number };
  [key: string]: unknown;
};

export function sendRpc<T extends Record<string, unknown>>(
  ws: Awaited<ReturnType<typeof openWs>>,
  id: string,
  method: string,
  params?: unknown,
): Promise<RpcResponse<T>> {
  const response = onceMessage<RpcResponse<T>>(
    ws,
    (message) => message.type === "res" && message.id === id,
    60_000,
  );
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return response;
}

export async function expectCursorRejected(
  ws: Awaited<ReturnType<typeof openWs>>,
  id: string,
  params: Record<string, unknown>,
) {
  const response = await sendRpc<Record<string, unknown>>(ws, id, "tasks.list", params);
  expect(response).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: expect.stringContaining("restart pagination") },
  });
}

function taskUpdatedAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt;
}

export function expectedTaskIds(
  tasks: Iterable<TaskRecord>,
  offset: number,
  limit: number,
): string[] {
  return [...tasks]
    .toSorted(
      (left, right) =>
        taskUpdatedAt(right) - taskUpdatedAt(left) || left.taskId.localeCompare(right.taskId),
    )
    .slice(offset, offset + limit)
    .map((task) => task.taskId);
}

export function createTaskSnapshot(): Map<string, TaskRecord> {
  const tasks = new Map<string, TaskRecord>();
  for (let index = 0; index < TASK_COUNT; index += 1) {
    const taskId = `task-${String(index).padStart(5, "0")}`;
    const requesterSessionKey = index % 2 === 0 ? OWNED_SESSION_KEY : FOREIGN_SESSION_KEY;
    tasks.set(taskId, {
      taskId,
      runtime: "cli",
      requesterSessionKey,
      requesterAgentId: "main",
      ownerKey: requesterSessionKey,
      scopeKind: "session",
      runId: `run-${index}`,
      task: `Task ${index}`,
      status: "succeeded",
      deliveryStatus: "not_applicable",
      notifyPolicy: "done_only",
      createdAt: 0,
      startedAt: 0,
      lastEventAt: Math.floor(((index * 7_919) % TASK_COUNT) / 4),
    });
  }
  return tasks;
}

export async function withAuthenticatedTaskGateway(
  initializeTasks: () => void,
  fn: (clients: {
    admin: Awaited<ReturnType<typeof openWs>>;
    viewer: Awaited<ReturnType<typeof openWs>>;
  }) => Promise<void>,
): Promise<void> {
  const adminProfile = ensureProfileForEmail("admin@example.com");
  const viewerProfile = ensureProfileForEmail("viewer@example.com");
  const foreignProfile = ensureProfileForEmail("foreign@example.com");
  setUserProfileRole(adminProfile.id, "maintainer");
  setUserProfileRole(viewerProfile.id, "restricted");
  const auth: GatewayAuthConfig = {
    mode: "trusted-proxy" as const,
    identityScopes: {
      "admin@example.com": ["operator.admin"],
      "viewer@example.com": ["operator.read"],
    },
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
  };
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [BROWSER_ORIGIN] };
  await writeConfigFile({
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1"],
      roles: {
        default: "restricted",
        definitions: {
          restricted: {
            sessions: { others: "view" },
            agents: "*",
            scopes: ["operator.read"],
          },
          maintainer: {
            sessions: { others: "write" },
            agents: "*",
            scopes: ["operator.admin"],
          },
        },
      },
      controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
    },
  });

  try {
    await withGatewayServer(async ({ port }) => {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: OWNED_SESSION_KEY },
        {
          sessionId: "session-owned",
          lifecycleRevision: "owned-generation",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: viewerProfile.id },
          visibility: "shared",
        },
      );
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: FOREIGN_SESSION_KEY },
        {
          sessionId: "session-foreign",
          lifecycleRevision: "foreign-generation",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: foreignProfile.id },
          visibility: "shared",
        },
      );
      initializeTasks();
      const stateDir = process.env.OPENCLAW_STATE_DIR;
      if (!stateDir) {
        throw new Error("OPENCLAW_STATE_DIR is required for the Gateway proof");
      }
      const connect = async (email: string, scopes: string[], identityLabel = email) => {
        const ws = await openWs(port, {
          origin: BROWSER_ORIGIN,
          "x-forwarded-for": "203.0.113.50",
          "x-forwarded-proto": "https",
          "x-forwarded-user": email,
        });
        const connected = await connectReq(ws, {
          skipDefaultAuth: true,
          prePairDevice: true,
          scopes,
          client: CONTROL_UI_CLIENT,
          deviceIdentityPath: path.join(stateDir, `${identityLabel}.sqlite`),
          browserOrigin: BROWSER_ORIGIN,
        });
        expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
        return ws;
      };
      const admin = await connect("admin@example.com", ["operator.admin"]);
      const viewer = await connect("viewer@example.com", ["operator.read"]);
      try {
        await fn({ admin, viewer });
      } finally {
        admin.close();
        viewer.close();
        resetTaskRegistryForTests({ persist: false });
      }
    });
  } finally {
    invalidateOperatorRolePolicy(adminProfile.id);
    invalidateOperatorRolePolicy(viewerProfile.id);
  }
}
