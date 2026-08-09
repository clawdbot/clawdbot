import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import {
  createBackgroundTasksProps,
  handleBackgroundTasksEvent,
  type BackgroundTasksHost,
} from "./chat-background-tasks.ts";

function flushAsync() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function makeTask(overrides: Partial<TaskSummary> & { id: string }): TaskSummary {
  return {
    taskId: overrides.id,
    status: "running",
    runtime: "subagent",
    agentId: "main",
    title: "Investigate concurrent sessions",
    sessionKey: "agent:main:current",
    createdAt: 1_000,
    updatedAt: 2_000,
    startedAt: 1_500,
    ...overrides,
  };
}

async function refreshingHost(tasks: TaskSummary[], initial = false) {
  let resolveActive!: (value: { tasks: TaskSummary[] }) => void;
  let resolveRecent!: (value: { tasks: TaskSummary[] }) => void;
  let rejectActive!: (error: Error) => void;
  const active = new Promise<{ tasks: TaskSummary[] }>((resolve, reject) => {
    resolveActive = resolve;
    rejectActive = reject;
  });
  const recent = new Promise<{ tasks: TaskSummary[] }>((resolve) => {
    resolveRecent = resolve;
  });
  let deferRefresh = initial;
  let deferredListCalls = 0;
  let fallbackTasks = tasks;
  const request = vi.fn((method: string, params?: unknown) => {
    if (method === "tasks.cancel") {
      const taskId = (params as { taskId?: string })?.taskId;
      const cancelled = makeTask({
        id: taskId ?? "task-missing",
        status: "cancelled",
        updatedAt: 4_000,
      });
      return Promise.resolve({ found: true, cancelled: true, task: cancelled });
    }
    if (method !== "tasks.list" || !deferRefresh) {
      return Promise.resolve({ tasks: fallbackTasks });
    }
    if (++deferredListCalls > 2) {
      return Promise.resolve({ tasks: fallbackTasks });
    }
    return (params as { status?: readonly string[] })?.status ? active : recent;
  });
  const host: BackgroundTasksHost = {
    sessionKey: "agent:main:current",
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
    connectionEpoch: 1,
    hello: null,
    requestUpdate: vi.fn(),
  };
  createBackgroundTasksProps(host);
  if (!initial) {
    await flushAsync();
    deferRefresh = true;
    createBackgroundTasksProps(host).onRefresh();
  }
  return {
    host,
    request,
    resolveActive,
    resolveRecent,
    rejectActive,
    setFallbackTasks(next: TaskSummary[]) {
      fallbackTasks = next;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("background tasks concurrent snapshots", () => {
  it.each([
    {
      name: "a terminal event",
      stale: [makeTask({ id: "task-initial" })],
      event: {
        action: "upserted" as const,
        task: makeTask({ id: "task-initial", status: "completed", updatedAt: 3_000 }),
      },
      expected: [["task-initial", "completed"]],
    },
    {
      name: "a task deletion",
      stale: [makeTask({ id: "task-deleted" }), makeTask({ id: "task-retained" })],
      event: { action: "deleted" as const, taskId: "task-deleted" },
      expected: [["task-retained", "running"]],
    },
    {
      name: "a task creation",
      stale: [makeTask({ id: "task-existing" })],
      event: {
        action: "upserted" as const,
        task: makeTask({ id: "task-created", updatedAt: 3_000 }),
      },
      expected: [
        ["task-created", "running"],
        ["task-existing", "running"],
      ],
    },
  ])("replays $name during the initial load without a stale second load", async (test) => {
    const refresh = await refreshingHost(test.stale, true);
    expect(refresh.request).toHaveBeenCalledTimes(2);
    expect(createBackgroundTasksProps(refresh.host).tasks).toBeNull();

    handleBackgroundTasksEvent(refresh.host, test.event);
    handleBackgroundTasksEvent(refresh.host, {
      action: "upserted",
      task: makeTask({
        id: "task-other-session",
        sessionKey: "agent:main:other",
        updatedAt: 4_000,
      }),
    });
    refresh.resolveActive({ tasks: test.stale });
    refresh.resolveRecent({ tasks: test.stale });
    await flushAsync();
    await flushAsync();

    expect(refresh.request).toHaveBeenCalledTimes(2);
    expect(
      createBackgroundTasksProps(refresh.host).tasks?.map((task) => [task.id, task.status]),
    ).toEqual(test.expected);
  });

  it("retains a real terminal event when the initial task snapshot fails", async () => {
    const stale = [makeTask({ id: "task-snapshot-failed" })];
    const refresh = await refreshingHost(stale, true);

    handleBackgroundTasksEvent(refresh.host, {
      action: "upserted",
      task: makeTask({
        id: "task-snapshot-failed",
        status: "completed",
        updatedAt: 3_000,
        terminalSummary: "Completed despite snapshot failure",
      }),
    });
    refresh.rejectActive(new Error("Initial task snapshot unavailable"));
    refresh.resolveRecent({ tasks: stale });
    await flushAsync();

    const props = createBackgroundTasksProps(refresh.host);
    expect(props.error).toBe("Initial task snapshot unavailable");
    expect(props.tasks?.map((task) => [task.id, task.status])).toEqual([
      ["task-snapshot-failed", "completed"],
    ]);
    expect(refresh.request).toHaveBeenCalledTimes(2);
  });

  it("preserves all ten unopened task completions after both stale pages resolve", async () => {
    const tasks = Array.from({ length: 10 }, (_, index) => makeTask({ id: `task-${index}` }));
    const refresh = await refreshingHost(tasks);

    for (const [index, task] of tasks.entries()) {
      handleBackgroundTasksEvent(refresh.host, {
        action: "upserted",
        task: {
          ...task,
          status: "completed",
          updatedAt: 3_000 + index,
          terminalSummary: `Completed task ${index + 1}`,
        },
      });
    }
    refresh.resolveActive({ tasks });
    refresh.resolveRecent({ tasks });
    await flushAsync();

    const props = createBackgroundTasksProps(refresh.host);
    expect(props.tasks).toHaveLength(10);
    expect(new Set(props.tasks?.map((task) => task.id)).size).toBe(10);
    expect(props.tasks?.every((task) => task.status === "completed")).toBe(true);
    expect(props.tasks?.every((task) => task.terminalSummary?.startsWith("Completed task"))).toBe(
      true,
    );
    expect(props.taskDetails.size).toBe(0);
  });

  it("preserves successful cancellation while stale snapshot pages are in flight", async () => {
    const tasks = [makeTask({ id: "task-cancelled" })];
    const refresh = await refreshingHost(tasks);

    createBackgroundTasksProps(refresh.host).onCancel("task-cancelled");
    await flushAsync();
    expect(createBackgroundTasksProps(refresh.host).tasks?.[0]?.status).toBe("cancelled");

    refresh.resolveActive({ tasks });
    refresh.resolveRecent({ tasks });
    await flushAsync();

    expect(createBackgroundTasksProps(refresh.host).tasks?.[0]?.status).toBe("cancelled");
  });

  it("discards an in-flight snapshot after a same-client connection-epoch change", async () => {
    const stale = [makeTask({ id: "task-old-account" })];
    const replacement = [makeTask({ id: "task-new-account", updatedAt: 4_000 })];
    const refresh = await refreshingHost(stale, true);
    refresh.setFallbackTasks(replacement);
    refresh.host.connectionEpoch = 2;

    createBackgroundTasksProps(refresh.host);
    await flushAsync();
    expect(createBackgroundTasksProps(refresh.host).tasks?.map((task) => task.id)).toEqual([
      "task-new-account",
    ]);

    refresh.resolveActive({ tasks: stale });
    refresh.resolveRecent({ tasks: stale });
    await flushAsync();

    expect(createBackgroundTasksProps(refresh.host).tasks?.map((task) => task.id)).toEqual([
      "task-new-account",
    ]);
    expect(refresh.request).toHaveBeenCalledTimes(4);
  });
});
