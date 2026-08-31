import path from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import type { TasksListResult } from "../../packages/gateway-protocol/src/index.js";
import { writeConfigFile } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { configureTaskRegistryRuntime } from "../tasks/task-registry.store.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  onceMessage,
  openWs,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const BROWSER_ORIGIN = "https://control.example.com";
const TASK_COUNT = 10_000;
const OWNED_SESSION_KEY = "agent:main:tasks-owned";
const FOREIGN_SESSION_KEY = "agent:main:tasks-foreign";

type RpcResponse<T> = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: T;
  error?: { message?: string };
};

function sendRpc<T>(
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

function taskUpdatedAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt;
}

function expectedTaskIds(tasks: Iterable<TaskRecord>, offset: number, limit: number): string[] {
  return [...tasks]
    .toSorted(
      (left, right) =>
        taskUpdatedAt(right) - taskUpdatedAt(left) || left.taskId.localeCompare(right.taskId),
    )
    .slice(offset, offset + limit)
    .map((task) => task.taskId);
}

function createTaskSnapshot(): Map<string, TaskRecord> {
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

afterAll(() => {
  resetTaskRegistryForTests({ persist: false });
});

describe("tasks.list Gateway performance", () => {
  test("keeps authenticated task pages bounded without blocking other RPCs", async () => {
    const adminProfile = ensureProfileForEmail("admin@example.com");
    const viewerProfile = ensureProfileForEmail("viewer@example.com");
    const foreignProfile = ensureProfileForEmail("foreign@example.com");
    setUserProfileRole(adminProfile.id, "maintainer");
    setUserProfileRole(viewerProfile.id, "restricted");
    const auth = {
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
              sessions: { others: "none" },
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

    const tasks = createTaskSnapshot();
    const adminExpected = expectedTaskIds(tasks.values(), 13, 7);
    const ownedTasks = [...tasks.values()].filter(
      (task) => task.requesterSessionKey === OWNED_SESSION_KEY,
    );
    const viewerExpected = expectedTaskIds(ownedTasks, 10, 25);

    try {
      await withGatewayServer(async ({ port }) => {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: OWNED_SESSION_KEY },
          {
            sessionId: "session-owned",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: viewerProfile.id },
            visibility: "shared",
          },
        );
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: FOREIGN_SESSION_KEY },
          {
            sessionId: "session-foreign",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: foreignProfile.id },
            visibility: "shared",
          },
        );
        resetTaskRegistryForTests({ persist: false });
        let onSnapshotLoad: (() => void) | undefined;
        configureTaskRegistryRuntime({
          store: {
            loadSnapshot: () => {
              onSnapshotLoad?.();
              return { tasks, deliveryStates: new Map() };
            },
            saveSnapshot: () => {},
          },
        });

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
        const healthClient = await connect("admin@example.com", ["operator.admin"], "admin-health");
        const viewer = await connect("viewer@example.com", ["operator.read"]);
        const sortedInputLengths: number[] = [];
        const originalToSorted = Array.prototype.toSorted;
        const sortSpy = vi.spyOn(Array.prototype, "toSorted").mockImplementation(function <T>(
          this: T[],
          compareFn?: (left: T, right: T) => number,
        ): T[] {
          const first = this[0];
          if (first && typeof first === "object" && "taskId" in first) {
            sortedInputLengths.push(this.length);
          }
          return Reflect.apply(originalToSorted, this, [compareFn]) as T[];
        });
        try {
          const completionOrder: string[] = [];
          let healthPromise: Promise<RpcResponse<Record<string, unknown>>> | undefined;
          onSnapshotLoad = () => {
            healthPromise = sendRpc<Record<string, unknown>>(healthClient, "health", "health").then(
              (response) => {
                completionOrder.push("health");
                return response;
              },
            );
          };
          const restrictedPromise = sendRpc<TasksListResult>(viewer, "tasks-owned", "tasks.list", {
            cursor: "10",
            limit: 25,
          }).then((response) => {
            completionOrder.push("tasks.list");
            return response;
          });
          const restricted = await restrictedPromise;
          const health = await healthPromise;

          expect(health?.ok).toBe(true);
          expect(restricted.ok, JSON.stringify(restricted.error)).toBe(true);
          expect(restricted.payload?.tasks.map((task) => task.id)).toEqual(viewerExpected);
          expect(restricted.payload?.tasks).toHaveLength(25);
          expect(
            restricted.payload?.tasks.every((task) => task.sessionKey === OWNED_SESSION_KEY),
          ).toBe(true);
          expect(restricted.payload?.nextCursor).toBe("35");
          expect(completionOrder[0]).toBe("health");
          expect(Math.max(0, ...sortedInputLengths)).toBeLessThanOrEqual(35);

          sortedInputLengths.length = 0;
          const list = await sendRpc<TasksListResult>(admin, "tasks-list", "tasks.list", {
            cursor: "13",
            limit: 7,
          });
          expect(list.ok, JSON.stringify(list.error)).toBe(true);
          expect(list.payload?.tasks.map((task) => task.id)).toEqual(adminExpected);
          expect(list.payload?.nextCursor).toBe("20");
          expect(Math.max(0, ...sortedInputLengths)).toBeLessThanOrEqual(20);
        } finally {
          sortSpy.mockRestore();
          admin.close();
          healthClient.close();
          viewer.close();
          resetTaskRegistryForTests({ persist: false });
        }
      });
    } finally {
      invalidateOperatorRolePolicy(adminProfile.id);
      invalidateOperatorRolePolicy(viewerProfile.id);
    }
  }, 60_000);
});
