import { afterEach, beforeEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createNextAcpTaskBackingDetail } from "./task-backing-authority.js";
import { createAcpTaskBackingDetailForTest } from "./task-backing-authority.test-support.js";
import { createTaskFlowForTask } from "./task-flow-registry.js";
import { publishTaskRecordAfterAtomicStore, updateTask } from "./task-registry-mutation.js";
import {
  deleteTaskRecordById,
  hasActiveTaskForChildSessionKey,
  listTaskRecordPage,
  listTasksForRelatedSessionKey,
} from "./task-registry-query.js";
import { createTaskRecord, linkTaskToFlowById } from "./task-registry-record-api.js";
import { reloadTaskRegistryFromStore } from "./task-registry-state.js";
import { configureTaskRegistryRuntime, getTaskRegistryStore } from "./task-registry.store.js";
import { upsertTaskRegistryRecordToSqlite } from "./task-registry.store.sqlite.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
});
afterEach(async () => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  await state.cleanup();
});

function createTask(params: Partial<Parameters<typeof createTaskRecord>[0]>) {
  const task = createTaskRecord({
    runtime: "cli",
    scopeKind: "session",
    ownerKey: "agent:main:owner",
    requesterSessionKey: "agent:main:requester",
    childSessionKey: "agent:main:child",
    status: "running",
    deliveryStatus: "not_applicable",
    task: "Indexed session task",
    ...params,
  });
  if (!task) {
    throw new Error("task creation failed");
  }
  return task;
}

async function taskIds(params: Omit<Parameters<typeof listTaskRecordPage>[0], "offset" | "limit">) {
  const result = await listTaskRecordPage({ ...params, offset: 0, limit: 100 });
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value.tasks.map((task) => task.taskId);
}

it("publishes requester membership through create, update, restore, atomic publication and delete", async () => {
  const task = createTask({});
  const originalKey = task.requesterSessionKey;
  expect(await taskIds({ sessionKey: originalKey })).toEqual([task.taskId]);
  expect(hasActiveTaskForChildSessionKey({ sessionKey: originalKey })).toBe(false);
  expect(hasActiveTaskForChildSessionKey({ sessionKey: task.childSessionKey! })).toBe(true);

  const store = getTaskRegistryStore();
  configureTaskRegistryRuntime({
    store: {
      ...store,
      upsertTaskWithDeliveryState: () => {
        throw new Error("fixture write rejected");
      },
    },
  });
  try {
    expect(updateTask(task.taskId, { requesterSessionKey: "agent:main:rejected" })).toBeNull();
    expect(await taskIds({ sessionKey: originalKey })).toEqual([task.taskId]);
    expect(await taskIds({ sessionKey: "agent:main:rejected" })).toEqual([]);
  } finally {
    configureTaskRegistryRuntime({ store });
  }

  const updated = updateTask(task.taskId, { requesterSessionKey: task.ownerKey });
  expect(updated).not.toBeNull();
  expect(await taskIds({ sessionKey: originalKey })).toEqual([]);
  expect(await taskIds({ sessionKey: task.ownerKey })).toEqual([task.taskId]);
  reloadTaskRegistryFromStore();
  expect(listTasksForRelatedSessionKey(task.ownerKey).map((row) => row.taskId)).toEqual([
    task.taskId,
  ]);

  const published = { ...task, requesterSessionKey: "agent:main:published" };
  upsertTaskRegistryRecordToSqlite(published);
  publishTaskRecordAfterAtomicStore(published);
  expect(await taskIds({ sessionKey: published.requesterSessionKey })).toEqual([task.taskId]);
  expect(await taskIds({ sessionKey: task.ownerKey })).toEqual([task.taskId]);
  expect(deleteTaskRecordById(task.taskId)).toBe(true);
  reloadTaskRegistryFromStore();
  for (const sessionKey of [
    originalKey,
    published.requesterSessionKey,
    task.ownerKey,
    task.childSessionKey!,
  ]) {
    expect(await taskIds({ sessionKey })).toEqual([]);
  }
});

it("keeps requester-only bare keys bound to their agent", async () => {
  const cfg = {
    session: { scope: "global" },
    agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
  } satisfies OpenClawConfig;
  const tasks = ["ops", "research"].map((requesterAgentId) =>
    createTask({ requesterSessionKey: "global", requesterAgentId }),
  );
  for (const [index, sessionAgentId] of ["ops", "research"].entries()) {
    expect(await taskIds({ cfg, sessionKey: "global", sessionAgentId })).toEqual([
      tasks[index]?.taskId,
    ]);
  }
  expect(
    await taskIds({ cfg, sessionKey: "global", sessionAgentId: "ops", agentId: "research" }),
  ).toEqual([]);
});

it("preserves owner-or-child ACP generation history when requester candidates are added", async () => {
  const key = "agent:main:watched";
  const records = [
    { childSessionKey: key, generation: 2 },
    { ownerKey: key, generation: 8 },
    { requesterSessionKey: key, generation: 100 },
    { generation: 200 },
  ].map(({ generation, ...keys }) => {
    const task = createTask({
      ...keys,
      runtime: "acp",
      runId: `run-${generation}`,
      detail: createAcpTaskBackingDetailForTest(`instance-${generation}`, generation),
    });
    const flow = createTaskFlowForTask({ task });
    if (!flow) {
      throw new Error("task flow creation failed");
    }
    expect(linkTaskToFlowById({ taskId: task.taskId, flowId: flow.flowId })).not.toBeNull();
    return task;
  });
  expect(new Set(await taskIds({ sessionKey: key }))).toEqual(
    new Set(records.slice(0, 3).map((task) => task.taskId)),
  );
  expect(
    createNextAcpTaskBackingDetail({ childSessionKey: key, instanceId: "next" }),
  ).toMatchObject({ generation: 9 });
  reloadTaskRegistryFromStore();
  expect(
    createNextAcpTaskBackingDetail({ childSessionKey: key, instanceId: "after-restore" }),
  ).toMatchObject({ generation: 9 });
  expect(deleteTaskRecordById(records[0]!.taskId)).toBe(true);
  expect(hasActiveTaskForChildSessionKey({ sessionKey: key })).toBe(false);
});
