import { expect, it, vi } from "vitest";
import type { CronServiceState } from "../cron/service/state.js";
import { tryFinishCronTaskRunWithoutHistory } from "../cron/service/task-runs.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import {
  createTaskRecord,
  markTaskLostById,
  markTaskTerminalById,
} from "../tasks/task-registry.js";
import { getTaskRegistryObservers } from "../tasks/task-registry.store.js";
import type { TaskEventPayload } from "./server-methods/task-summary.js";
import { TerminalSessionManager } from "./terminal/session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
  makeFakePty,
  taskAgentOwner,
} from "./terminal/session-manager.test-helpers.js";

type StartSubscriptions =
  typeof import("./server-runtime-subscriptions.js").startGatewayEventSubscriptions;
type SubscriptionParams = Parameters<StartSubscriptions>[0];
type Subscriptions = ReturnType<StartSubscriptions>;

export function registerTaskTerminalSubscriptionTests(params: {
  startGatewayEventSubscriptions: StartSubscriptions;
  createParams: () => SubscriptionParams;
  waitForFast: <T>(
    callback: () => T | Promise<T>,
    options?: { timeout?: number; interval?: number },
  ) => Promise<T>;
  setUnsubs: (subscriptions: Subscriptions) => void;
  mockLog: SubsystemLogger;
}) {
  it.each(["succeeded", "failed", "cancelled", "timed_out", "lost"] as const)(
    "closes task-run terminals exactly once for a %s transition",
    async (status) => {
      const closeTaskSessions = vi.fn(() => 1);
      params.setUnsubs(
        params.startGatewayEventSubscriptions({
          ...params.createParams(),
          terminalSessions: { closeTaskSessions },
        }),
      );
      await params.waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());

      const task = createTaskRecord({
        runtime: "cron",
        requesterSessionKey: "",
        ownerKey: "",
        scopeKind: "system",
        task: `${status} cron task`,
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
      });
      if (!task) {
        throw new Error("expected task record");
      }
      const terminalize = () => {
        if (status === "lost") {
          markTaskLostById({ taskId: task.taskId, endedAt: 2_000 });
          return;
        }
        markTaskTerminalById({ taskId: task.taskId, status, endedAt: 2_000 });
      };

      terminalize();
      terminalize();

      expect(closeTaskSessions).toHaveBeenCalledOnce();
      expect(closeTaskSessions).toHaveBeenCalledWith(task.taskId);
    },
  );

  it("closes a completed cron task terminal while preserving a conversation terminal", async () => {
    const taskPty = makeFakePty();
    const persistentPty = makeFakePty();
    const ptys = [taskPty, persistentPty];
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => ptys.shift() ?? makeFakePty(),
    });
    params.setUnsubs(
      params.startGatewayEventSubscriptions({
        ...params.createParams(),
        terminalSessions: manager,
      }),
    );
    await params.waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());

    const runId = "cron:job-1:run-1";
    const runSessionKey = "agent:main:cron:job-1:run:run-1";
    const task = createTaskRecord({
      runtime: "cron",
      requesterSessionKey: "",
      ownerKey: "",
      scopeKind: "system",
      childSessionKey: runSessionKey,
      runId,
      task: "Cron task",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
    if (!task) {
      throw new Error("expected task record");
    }
    const taskOpen = await manager.open(
      baseOpenRequest({
        owner: taskAgentOwner(runSessionKey, task.taskId),
      }),
    );
    const persistentOwner = agentTerminalOwner("agent:main:main");
    const persistentOpen = await manager.open(baseOpenRequest({ owner: persistentOwner }));
    if (!taskOpen.ok || !persistentOpen.ok) {
      throw new Error("expected terminal sessions");
    }

    tryFinishCronTaskRunWithoutHistory(
      { deps: { log: params.mockLog } } as unknown as CronServiceState,
      {
        taskRunId: runId,
        status: "ok",
        endedAt: 2_000,
        childSessionKey: runSessionKey,
      },
    );

    expect(taskPty.killed).toBe(true);
    expect(persistentPty.killed).toBe(false);
    expect(manager.size).toBe(1);
    expect(manager.listAgent(persistentOwner)).toHaveLength(1);
  });

  it("closes task-run terminals only after the authoritative task becomes terminal", async () => {
    const events: string[] = [];
    const closeTaskSessions = vi.fn((taskId: string) => {
      events.push(`terminal:${taskId}`);
      return 1;
    });
    const broadcast = vi.fn<SubscriptionParams["broadcast"]>((event, payload) => {
      if (event === "task" && (payload as TaskEventPayload).action === "upserted") {
        const taskPayload = payload as Extract<TaskEventPayload, { action: "upserted" }>;
        events.push(`task:${taskPayload.task.status}`);
      }
    });
    params.setUnsubs(
      params.startGatewayEventSubscriptions({
        ...params.createParams(),
        broadcast,
        terminalSessions: { closeTaskSessions },
      }),
    );
    await params.waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());

    const runSessionKey = "agent:main:cron:job-1:run:run-1";
    const task = createTaskRecord({
      runtime: "cron",
      requesterSessionKey: "",
      ownerKey: "",
      scopeKind: "system",
      childSessionKey: runSessionKey,
      task: "Cron task",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
    if (!task) {
      throw new Error("expected task record");
    }
    expect(closeTaskSessions).not.toHaveBeenCalled();
    expect(events).toEqual(["task:running"]);

    markTaskTerminalById({ taskId: task.taskId, status: "succeeded", endedAt: 2_000 });
    expect(closeTaskSessions).toHaveBeenCalledOnce();
    expect(closeTaskSessions).toHaveBeenCalledWith(task.taskId);
    expect(events).toEqual(["task:running", "task:completed", `terminal:${task.taskId}`]);

    markTaskTerminalById({ taskId: task.taskId, status: "succeeded", endedAt: 2_001 });
    expect(closeTaskSessions).toHaveBeenCalledOnce();
  });

  it("keeps a replacement gateway's task observer when a stale unsub runs late", async () => {
    const staleBroadcast = vi.fn<SubscriptionParams["broadcast"]>();
    const staleSubs = params.startGatewayEventSubscriptions({
      ...params.createParams(),
      broadcast: staleBroadcast,
    });
    await params.waitForFast(() => expect(getTaskRegistryObservers()).not.toBeNull());
    const staleObservers = getTaskRegistryObservers();

    const replacementBroadcast = vi.fn<SubscriptionParams["broadcast"]>();
    params.setUnsubs(
      params.startGatewayEventSubscriptions({
        ...params.createParams(),
        broadcast: replacementBroadcast,
      }),
    );
    await params.waitForFast(() => {
      const current = getTaskRegistryObservers();
      expect(current).not.toBeNull();
      expect(current).not.toBe(staleObservers);
    });

    await staleSubs.taskUnsub();
    await staleSubs.agentUnsub();
    staleSubs.heartbeatUnsub();
    staleSubs.transcriptUnsub();
    staleSubs.lifecycleUnsub();
    expect(getTaskRegistryObservers()).not.toBeNull();

    createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "After stale dispose",
      status: "queued",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
    expect(replacementBroadcast.mock.calls.some(([event]) => event === "task")).toBe(true);
    expect(staleBroadcast.mock.calls.some(([event]) => event === "task")).toBe(false);
  });
}
