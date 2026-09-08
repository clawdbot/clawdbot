import { afterAll, expect, test } from "vitest";
import type { TasksListResult } from "../../../../packages/gateway-protocol/src/index.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { listTaskRecordsUnsorted } from "../../../tasks/runtime-internal.js";
import { configureTaskRegistryRuntime } from "../../../tasks/task-registry.store.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-runtime.test-helpers.js";
import { createInMemoryTaskRegistryStore } from "../../../test-utils/task-registry-store.js";
import { installGatewayTestHooks } from "../../server.auth.test-helpers.js";
import {
  createTaskSnapshot,
  expectedTaskIds,
  expectCursorRejected,
  FOREIGN_SESSION_KEY,
  type RpcResponse,
  sendRpc,
  TASK_COUNT,
  withAuthenticatedTaskGateway,
} from "../../server.tasks-list.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

afterAll(() => {
  resetTaskRegistryForTests({ persist: false });
});

test("preserves task pagination during metadata patches but invalidates new requester access", async () => {
  const initializeTasks = () => {
    resetTaskRegistryForTests({ persist: false });
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot: () => ({
          tasks: new Map([...createTaskSnapshot()].slice(0, 256)),
          deliveryStates: new Map(),
        }),
      },
    });
  };
  await withAuthenticatedTaskGateway(initializeTasks, async ({ admin, viewer }) => {
    const metadataPage = await sendRpc<TasksListResult>(
      viewer,
      "tasks-before-label",
      "tasks.list",
      { limit: 7 },
    );
    expect(metadataPage.ok, JSON.stringify(metadataPage.error)).toBe(true);
    const metadataCursor = metadataPage.payload?.nextCursor;
    if (!metadataCursor) {
      throw new Error("expected a task cursor before the label change");
    }
    const foreignScope = { agentId: "main", sessionKey: FOREIGN_SESSION_KEY };
    const accessFields = (entry: ReturnType<typeof loadSessionEntry>) => ({
      sessionId: entry?.sessionId,
      lifecycleRevision: entry?.lifecycleRevision,
      createdActor: entry?.createdActor,
      visibility: entry?.visibility,
      incognito: entry?.incognito,
    });
    const beforeLabel = loadSessionEntry(foreignScope);
    expect(beforeLabel?.sessionId).toBe("session-foreign");
    let metadataMutationCount = 0;
    const changeLabel = async () => {
      const label = `Task metadata ${metadataMutationCount++}`;
      const changed = await sendRpc<Record<string, unknown>>(
        admin,
        `label-change-${metadataMutationCount}`,
        "sessions.patch",
        {
          key: FOREIGN_SESSION_KEY,
          agentId: "main",
          expectedSessionId: "session-foreign",
          label,
        },
      );
      expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
      const afterLabel = loadSessionEntry(foreignScope);
      expect(afterLabel?.label).toBe(label);
      expect(accessFields(afterLabel)).toEqual(accessFields(beforeLabel));
    };
    await changeLabel();
    const categoryChange = await sendRpc<Record<string, unknown>>(
      admin,
      "register-task-category",
      "sessions.patch",
      {
        key: FOREIGN_SESSION_KEY,
        agentId: "main",
        expectedSessionId: "session-foreign",
        category: "Task metadata category",
      },
    );
    expect(categoryChange.ok, JSON.stringify(categoryChange.error)).toBe(true);
    expect(accessFields(loadSessionEntry(foreignScope))).toEqual(accessFields(beforeLabel));
    const afterLabel = await sendRpc<TasksListResult>(viewer, "tasks-after-label", "tasks.list", {
      cursor: metadataCursor,
      limit: 7,
    });
    expect(afterLabel.ok, JSON.stringify(afterLabel.error)).toBe(true);
    expect(afterLabel.payload?.tasks.map((task) => task.id)).toEqual(
      expectedTaskIds(listTaskRecordsUnsorted(), 7, 7),
    );

    let metadataChurnActive = true;
    const metadataChurn = (async () => {
      while (true) {
        if (!metadataChurnActive) {
          return;
        }
        await changeLabel();
      }
    })();
    let duringLabels: RpcResponse<TasksListResult>;
    try {
      duringLabels = await sendRpc<TasksListResult>(viewer, "tasks-during-labels", "tasks.list", {
        limit: 7,
      });
    } finally {
      metadataChurnActive = false;
      await metadataChurn;
    }
    expect(metadataMutationCount).toBeGreaterThan(1);
    expect(duringLabels.ok, JSON.stringify(duringLabels.error)).toBe(true);
    expect(duringLabels.payload?.tasks.map((task) => task.id)).toEqual(
      expectedTaskIds(listTaskRecordsUnsorted(), 0, 7),
    );

    const metadataTasks = listTaskRecordsUnsorted();
    const missingSessionKey = "agent:main:tasks-missing";
    const missingSessionTask: TaskRecord = {
      ...metadataTasks[0]!,
      taskId: "task-missing-requester",
      requesterSessionKey: missingSessionKey,
      ownerKey: missingSessionKey,
      lastEventAt: TASK_COUNT + 100,
    };
    resetTaskRegistryForTests({ persist: false });
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot: () => ({
          tasks: new Map([...metadataTasks, missingSessionTask].map((task) => [task.taskId, task])),
          deliveryStates: new Map(),
        }),
      },
    });
    const beforeCreation = await sendRpc<TasksListResult>(
      viewer,
      "tasks-before-requester-created",
      "tasks.list",
      { limit: 1 },
    );
    expect(beforeCreation.ok, JSON.stringify(beforeCreation.error)).toBe(true);
    expect(beforeCreation.payload?.tasks[0]?.id).not.toBe(missingSessionTask.taskId);
    const creationCursor = beforeCreation.payload?.nextCursor;
    if (!creationCursor) {
      throw new Error("expected a cursor before requester-session creation");
    }
    const createdSession = await sendRpc<Record<string, unknown>>(
      admin,
      "create-task-requester-with-patch",
      "sessions.patch",
      { key: missingSessionKey, agentId: "main", label: "Created task requester" },
    );
    expect(createdSession.ok, JSON.stringify(createdSession.error)).toBe(true);
    await expectCursorRejected(viewer, "tasks-created-requester-cursor", {
      cursor: creationCursor,
      limit: 1,
    });
    const afterCreation = await sendRpc<TasksListResult>(
      viewer,
      "tasks-after-requester-created",
      "tasks.list",
      { limit: 1 },
    );
    expect(afterCreation.ok, JSON.stringify(afterCreation.error)).toBe(true);
    expect(afterCreation.payload?.tasks[0]?.id).toBe(missingSessionTask.taskId);
  });
}, 60_000);
