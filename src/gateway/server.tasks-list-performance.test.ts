import { afterAll, describe, expect, test, vi } from "vitest";
import {
  TASKS_LIST_CURSOR_MAX_LENGTH,
  type TasksListResult,
} from "../../packages/gateway-protocol/src/index.js";
import {
  createTaskRecord,
  deleteTaskRecordById,
  listTaskRecordsUnsorted,
  markTaskTerminalById,
} from "../tasks/runtime-internal.js";
import { configureTaskRegistryRuntime } from "../tasks/task-registry.store.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import { installGatewayTestHooks } from "./server.auth.test-helpers.js";
import {
  createTaskSnapshot,
  expectedTaskIds,
  expectCursorRejected,
  FOREIGN_SESSION_KEY,
  OWNED_SESSION_KEY,
  type RpcResponse,
  sendRpc,
  TASK_COUNT,
  withAuthenticatedTaskGateway,
} from "./server.tasks-list.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

afterAll(() => {
  resetTaskRegistryForTests({ persist: false });
});

describe("tasks.list Gateway performance", () => {
  test("keeps authenticated task pages bounded without blocking other RPCs", async () => {
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

    let onSnapshotLoad: (() => void) | undefined;
    const initializeTasks = () => {
      resetTaskRegistryForTests({ persist: false });
      configureTaskRegistryRuntime({
        store: {
          ...createInMemoryTaskRegistryStore(),
          loadSnapshot: () => {
            onSnapshotLoad?.();
            return { tasks, deliveryStates: new Map() };
          },
        },
      });
    };
    await withAuthenticatedTaskGateway(initializeTasks, async ({ admin, viewer }) => {
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
        const [restricted, visibility] = await Promise.all([restrictedPromise, visibilityPromise]);
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

        const convergingTasks = createTaskSnapshot();
        const convergingTaskId = convergingTasks.keys().next().value;
        if (!convergingTaskId) {
          throw new Error("expected a converging task fixture");
        }
        resetTaskRegistryForTests({ persist: false });
        let convergingChurnStarted = false;
        let convergingRevision = 0;
        const convergingRevisionTarget = 1;
        const convergeTaskRegistry = () => {
          if (convergingRevision >= convergingRevisionTarget) {
            return;
          }
          convergingRevision += 1;
          markTaskTerminalById({
            taskId: convergingTaskId,
            status: "succeeded",
            endedAt: TASK_COUNT + convergingRevision,
          });
          setImmediate(convergeTaskRegistry);
        };
        configureTaskRegistryRuntime({
          store: {
            ...createInMemoryTaskRegistryStore(),
            loadSnapshot: () => {
              if (!convergingChurnStarted) {
                convergingChurnStarted = true;
                setImmediate(convergeTaskRegistry);
              }
              return { tasks: convergingTasks, deliveryStates: new Map() };
            },
          },
        });
        const convergedRegistry = await sendRpc<TasksListResult>(
          admin,
          "tasks-converged-registry",
          "tasks.list",
          { limit: 1 },
        );
        expect(convergingRevision).toBe(convergingRevisionTarget);
        expect(convergedRegistry.ok, JSON.stringify(convergedRegistry.error)).toBe(true);
        expect(convergedRegistry.payload?.tasks).toHaveLength(1);

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
            ...createInMemoryTaskRegistryStore(),
            loadSnapshot: () => {
              if (!taskChurnStarted) {
                taskChurnStarted = true;
                setImmediate(churnTask);
              }
              return { tasks: churnTasks, deliveryStates: new Map() };
            },
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
          error: {
            code: "UNAVAILABLE",
            message: "Task activity did not stabilize. Wait a moment, then refresh Tasks.",
            retryable: true,
            retryAfterMs: 250,
          },
        });

        const scopedTasks = new Map(
          [...createTaskSnapshot()].slice(0, 65).map(([taskId, task], index) => {
            const requesterSessionKey = index === 0 ? OWNED_SESSION_KEY : FOREIGN_SESSION_KEY;
            return [taskId, { ...task, requesterSessionKey, ownerKey: requesterSessionKey }];
          }),
        );
        let scopedRevision = 0;
        let scopedChurn: ReturnType<typeof setImmediate> | undefined;
        const mutateUnrelatedTask = () => {
          scopedRevision += 1;
          markTaskTerminalById({
            taskId: "task-00064",
            status: "succeeded",
            endedAt: TASK_COUNT + scopedRevision,
          });
          scopedChurn = setImmediate(mutateUnrelatedTask);
        };
        resetTaskRegistryForTests({ persist: false });
        configureTaskRegistryRuntime({
          store: {
            ...createInMemoryTaskRegistryStore(),
            loadSnapshot: () => {
              scopedChurn = setImmediate(mutateUnrelatedTask);
              return { tasks: scopedTasks, deliveryStates: new Map() };
            },
          },
        });
        try {
          const scopedPage = await sendRpc<TasksListResult>(viewer, "tasks-scoped", "tasks.list", {
            sessionKey: OWNED_SESSION_KEY,
            agentId: "main",
            limit: 1,
          });
          expect(scopedPage.ok, JSON.stringify(scopedPage.error)).toBe(true);
          expect(scopedPage.payload?.tasks.map((task) => task.id)).toEqual(["task-00000"]);
          expect(scopedPage.payload?.nextCursor).toBeUndefined();
        } finally {
          clearImmediate(scopedChurn);
        }

        const accessTasks = new Map([...createTaskSnapshot()].slice(0, 1_000));
        resetTaskRegistryForTests({ persist: false });
        configureTaskRegistryRuntime({
          store: {
            ...createInMemoryTaskRegistryStore(),
            loadSnapshot: () => ({ tasks: accessTasks, deliveryStates: new Map() }),
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
          error: {
            code: "UNAVAILABLE",
            message: "Task activity did not stabilize. Wait a moment, then refresh Tasks.",
            retryable: true,
            retryAfterMs: 250,
          },
        });
      } finally {
        sortSpy.mockRestore();
      }
    });
  }, 60_000);
});
