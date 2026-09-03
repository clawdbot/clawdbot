import path from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import {
  TASKS_LIST_CURSOR_MAX_LENGTH,
  type TasksListResult,
} from "../../packages/gateway-protocol/src/index.js";
import { writeConfigFile } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import {
  createTaskRecord,
  deleteTaskRecordById,
  listTaskRecordsUnsorted,
  markTaskTerminalById,
} from "../tasks/runtime-internal.js";
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

type RpcResponse<T extends Record<string, unknown>> = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: T;
  error?: { code?: string; message?: string };
  [key: string]: unknown;
};

function sendRpc<T extends Record<string, unknown>>(
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

async function expectCursorRejected(
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

    const tasks = createTaskSnapshot();
    const ownedTasks = [...tasks.values()].filter(
      (task) => task.requesterSessionKey === OWNED_SESSION_KEY,
    );
    const initialOwnedPage = expectedTaskIds(ownedTasks, 10, 25);
    const deletedTaskId = initialOwnedPage[0];
    const updatedTask = ownedTasks.find((task) => !initialOwnedPage.includes(task.taskId));
    if (!deletedTaskId || !updatedTask) {
      throw new Error("expected selected and unselected owned task fixtures");
    }

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
          let mutationsApplied = false;
          onSnapshotLoad = () => {
            setImmediate(() => {
              const updated = markTaskTerminalById({
                taskId: updatedTask.taskId,
                status: "succeeded",
                endedAt: TASK_COUNT + 1,
                lastEventAt: TASK_COUNT + 1,
              });
              const deleted = deleteTaskRecordById(deletedTaskId);
              const created = createTaskRecord({
                runtime: "cli",
                requesterSessionKey: OWNED_SESSION_KEY,
                requesterAgentId: "main",
                ownerKey: OWNED_SESSION_KEY,
                scopeKind: "session",
                runId: "run-created-during-scan",
                task: "Created during scan",
                status: "running",
                deliveryStatus: "pending",
                lastEventAt: TASK_COUNT + 2,
              });
              mutationsApplied = updated !== null && deleted && created !== null;
            });
          };
          const listPromise = sendRpc<TasksListResult>(admin, "tasks-list", "tasks.list", {
            limit: 7,
          });
          const list = await listPromise;

          const listMaxSortedInput = Math.max(0, ...sortedInputLengths);
          const currentTasks = listTaskRecordsUnsorted();
          const adminExpected = expectedTaskIds(currentTasks, 0, 7);
          expect(mutationsApplied).toBe(true);
          expect(list.ok, JSON.stringify(list.error)).toBe(true);
          expect(list.payload?.tasks.map((task) => task.id)).toEqual(adminExpected);
          expect(list.payload?.nextCursor).toEqual(expect.any(String));
          expect(listMaxSortedInput).toBeLessThanOrEqual(7);
          const cursor = list.payload?.nextCursor;
          if (!cursor) {
            throw new Error("expected an admin task cursor");
          }
          const tamperedCursor = cursor.split(".");
          tamperedCursor[1] = "1";
          await expectCursorRejected(admin, "tasks-offset-mismatch", {
            cursor: tamperedCursor.join("."),
            limit: 7,
          });
          expect(deleteTaskRecordById(updatedTask.taskId)).toBe(true);
          const revisionCursor = cursor.split(".");
          revisionCursor[2] = String(Number(revisionCursor[2]) + 1);
          await expectCursorRejected(admin, "tasks-revision-mismatch", {
            cursor: revisionCursor.join("."),
            limit: 7,
          });
          await expectCursorRejected(admin, "tasks-status-mismatch", {
            cursor,
            limit: 7,
            status: "running",
          });
          await expectCursorRejected(admin, "tasks-agent-mismatch", {
            agentId: "worker",
            cursor,
            limit: 7,
          });
          await expectCursorRejected(viewer, "tasks-connection-mismatch", { cursor, limit: 7 });
          await expectCursorRejected(admin, "tasks-noncanonical", {
            cursor: `${cursor}=`,
            limit: 7,
          });
          await expectCursorRejected(admin, "tasks-oversized", {
            cursor: "x".repeat(TASKS_LIST_CURSOR_MAX_LENGTH + 1),
            limit: 7,
          });
          const sessionPage = await sendRpc<TasksListResult>(
            admin,
            "tasks-session-page",
            "tasks.list",
            { limit: 1, sessionKey: OWNED_SESSION_KEY },
          );
          const sessionCursor = sessionPage.payload?.nextCursor;
          if (!sessionCursor) {
            throw new Error("expected a session task cursor");
          }
          await expectCursorRejected(admin, "tasks-session-mismatch", {
            cursor: sessionCursor,
            limit: 1,
            sessionKey: FOREIGN_SESSION_KEY,
          });

          const viewerExpected = expectedTaskIds(
            listTaskRecordsUnsorted().filter(
              (task) => task.requesterSessionKey === OWNED_SESSION_KEY,
            ),
            0,
            25,
          );
          sortedInputLengths.length = 0;
          const accessOrder: string[] = [];
          const visibilityPromise = new Promise<RpcResponse<Record<string, unknown>>>(
            (resolve, reject) => {
              setTimeout(() => {
                void sendRpc<Record<string, unknown>>(
                  admin,
                  "session-visibility",
                  "session.visibility.set",
                  {
                    sessionKey: FOREIGN_SESSION_KEY,
                    agentId: "main",
                    visibility: "draft",
                  },
                ).then((response) => {
                  accessOrder.push("visibility");
                  resolve(response);
                }, reject);
              }, 50);
            },
          );
          const restrictedPromise = sendRpc<TasksListResult>(viewer, "tasks-owned", "tasks.list", {
            limit: 25,
          }).then((response) => {
            accessOrder.push("tasks.list");
            return response;
          });
          const [restricted, visibility] = await Promise.all([
            restrictedPromise,
            visibilityPromise,
          ]);
          expect(visibility.ok, JSON.stringify(visibility.error)).toBe(true);
          expect(restricted.ok, JSON.stringify(restricted.error)).toBe(true);
          expect(restricted.payload?.tasks.map((task) => task.id)).toEqual(viewerExpected);
          expect(restricted.payload?.tasks).toHaveLength(25);
          expect(
            restricted.payload?.tasks.every((task) => task.sessionKey === OWNED_SESSION_KEY),
          ).toBe(true);
          expect(restricted.payload?.nextCursor).toEqual(expect.any(String));
          expect(accessOrder[0]).toBe("visibility");
          expect(Math.max(0, ...sortedInputLengths)).toBeLessThanOrEqual(25);
          const accessCursor = sessionCursor.split(".");
          accessCursor[3] = String(Number(accessCursor[3]) + 1);
          await expectCursorRejected(admin, "tasks-access-revision", {
            cursor: accessCursor.join("."),
            limit: 1,
            sessionKey: OWNED_SESSION_KEY,
          });

          const churnTasks = createTaskSnapshot();
          const churnTaskId = churnTasks.keys().next().value;
          if (!churnTaskId) {
            throw new Error("expected a task churn fixture");
          }
          resetTaskRegistryForTests({ persist: false });
          let taskChurnActive = true;
          let taskChurnStarted = false;
          let taskChurnRevision = 0;
          const churnTask = () => {
            if (!taskChurnActive) {
              return;
            }
            taskChurnRevision += 1;
            markTaskTerminalById({
              taskId: churnTaskId,
              status: "succeeded",
              endedAt: TASK_COUNT + 100 + taskChurnRevision,
            });
            setImmediate(churnTask);
          };
          configureTaskRegistryRuntime({
            store: {
              loadSnapshot: () => {
                if (!taskChurnStarted) {
                  taskChurnStarted = true;
                  setImmediate(churnTask);
                }
                return { tasks: churnTasks, deliveryStates: new Map() };
              },
              saveSnapshot: () => {},
            },
          });
          const unstableRegistry = await sendRpc<Record<string, unknown>>(
            admin,
            "tasks-unstable-registry",
            "tasks.list",
            { limit: 1 },
          );
          taskChurnActive = false;
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(taskChurnRevision).toBeGreaterThanOrEqual(3);
          expect(unstableRegistry).toMatchObject({
            ok: false,
            error: { code: "UNAVAILABLE", message: expect.stringContaining("retry") },
          });

          const accessTasks = new Map([...createTaskSnapshot()].slice(0, 1_000));
          resetTaskRegistryForTests({ persist: false });
          configureTaskRegistryRuntime({
            store: {
              loadSnapshot: () => ({ tasks: accessTasks, deliveryStates: new Map() }),
              saveSnapshot: () => {},
            },
          });
          let accessChurnActive = true;
          let accessMutationCount = 0;
          const accessChurn = async () => {
            while (true) {
              if (!accessChurnActive) {
                return;
              }
              const nextVisibility = accessMutationCount % 2 === 0 ? "shared" : "draft";
              const response = await sendRpc<Record<string, unknown>>(
                admin,
                `visibility-churn-${accessMutationCount}`,
                "session.visibility.set",
                {
                  sessionKey: FOREIGN_SESSION_KEY,
                  agentId: "main",
                  visibility: nextVisibility,
                },
              );
              if (!response.ok) {
                throw new Error(`visibility churn failed: ${response.error?.message}`);
              }
              accessMutationCount += 1;
            }
          };
          const accessChurnPromise = accessChurn();
          const unstableAccess = await sendRpc<Record<string, unknown>>(
            viewer,
            "tasks-unstable-access",
            "tasks.list",
            { limit: 1 },
          );
          accessChurnActive = false;
          await accessChurnPromise;
          expect(accessMutationCount).toBeGreaterThanOrEqual(3);
          expect(unstableAccess).toMatchObject({
            ok: false,
            error: { code: "UNAVAILABLE", message: expect.stringContaining("retry") },
          });
        } finally {
          sortSpy.mockRestore();
          admin.close();
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
