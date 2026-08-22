import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import { renderBackgroundTasksRail } from "./chat-background-tasks-render.ts";
import { renderBackgroundTasksStatusRow } from "./chat-background-tasks-status.ts";
import {
  createBackgroundTasksProps,
  handleBackgroundTasksEvent,
  type BackgroundTasksHost,
} from "./chat-background-tasks.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import { deriveSubagentActivity } from "./chat-subagent-activity.ts";

function flushAsync() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function makeTask(overrides: Partial<TaskSummary> & { id: string }): TaskSummary {
  return {
    taskId: overrides.id,
    status: "running",
    runtime: "subagent",
    agentId: "main",
    title: "Map codebase",
    sessionKey: "agent:main:current",
    createdAt: 1_000,
    updatedAt: 2_000,
    startedAt: 1_500,
    ...overrides,
  };
}

function createHost(options?: {
  request?: (method: string, params?: unknown) => Promise<unknown>;
  connected?: boolean;
}): {
  host: BackgroundTasksHost;
  request: ReturnType<typeof vi.fn>;
  requestUpdate: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(
    options?.request ??
      ((method: string) => {
        if (method === "tasks.list") {
          return Promise.resolve({ tasks: [] });
        }
        return Promise.resolve({});
      }),
  );
  const requestUpdate = vi.fn();
  const host: BackgroundTasksHost = {
    sessionKey: "agent:main:current",
    client: { request } as unknown as GatewayBrowserClient,
    connected: options?.connected ?? true,
    hello: null,
    requestUpdate,
  };
  return { host, request, requestUpdate };
}

function makeProps(overrides: Partial<BackgroundTasksProps> = {}): BackgroundTasksProps {
  return {
    sessionKey: "agent:main:current",
    statusRowId: "chat-tasks-status-test",
    collapsed: true,
    narrowLayout: false,
    connected: true,
    canCancel: false,
    loading: false,
    error: null,
    tasks: null,
    activeCount: 0,
    subagentActivity: deriveSubagentActivity({
      tasks: [],
      sessionKey: "agent:main:current",
      terminalObservedAtByTask: new Map(),
      canonicalizeSessionKey: (sessionKey) => sessionKey ?? "",
    }),
    cancellingTaskIds: new Set(),
    finishedCollapsed: false,
    taskDetails: new Map(),
    taskDetailErrors: new Map(),
    taskDetailLoadingIds: new Set(),
    onToggleCollapsed: () => {},
    onToggleFinished: () => {},
    onRefresh: () => {},
    onCancel: () => {},
    ...overrides,
  };
}

function renderTaskRail(overrides: Partial<BackgroundTasksProps>) {
  const container = document.createElement("div");
  document.body.append(container);
  render(
    html`${renderBackgroundTasksRail(
      makeProps({
        collapsed: false,
        tasks: [],
        ...overrides,
      }),
    )}`,
    container,
  );
  return container;
}

function renderStatusRow(overrides: Partial<BackgroundTasksProps>) {
  const container = document.createElement("div");
  document.body.append(container);
  const props = makeProps(overrides);
  if (!overrides.subagentActivity) {
    props.subagentActivity = deriveSubagentActivity({
      tasks: props.tasks ?? [],
      sessionKey: props.sessionKey,
      terminalObservedAtByTask: new Map(),
      canonicalizeSessionKey: (sessionKey) => sessionKey ?? "",
    });
  }
  render(html`${renderBackgroundTasksStatusRow(props)}`, container);
  return container;
}

it("uses the shared surface empty state when no background tasks exist", async () => {
  const container = renderTaskRail({ tasks: [] });
  const empty = container.querySelector("openclaw-panel-empty-state");
  await empty?.updateComplete;

  expect(empty?.shadowRoot?.querySelector(".empty-state__title")?.textContent).toBe("Tasks");
  expect(empty?.querySelector("svg")).not.toBeNull();
  expect(container.querySelector(".chat-tasks-rail__scroll")?.hasAttribute("hidden")).toBe(true);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("background tasks rail state", () => {
  it("redacts secrets in task list failures", async () => {
    const { host } = createHost({
      request: () => Promise.reject(new Error("OPENAI_API_KEY=sk-1234567890abcdef")),
    });

    createBackgroundTasksProps(host);
    await flushAsync();

    const props = createBackgroundTasksProps(host);
    expect(props.error).toBe("OPENAI_API_KEY=sk-123...cdef");
    const rail = renderTaskRail({ ...props, collapsed: false });
    expect(rail.textContent).toContain("OPENAI_API_KEY=sk-123...cdef");
    expect(rail.textContent).not.toContain("sk-1234567890abcdef");
  });

  it("loads session-scoped tasks eagerly while the rail is collapsed", async () => {
    const { host, request } = createHost({
      request: (method, params) => {
        expect(method).toBe("tasks.list");
        expect((params as { sessionKey?: string }).sessionKey).toBe("agent:main:current");
        return Promise.resolve({ tasks: [makeTask({ id: "task-1" })] });
      },
    });

    expect(createBackgroundTasksProps(host).collapsed).toBe(true);
    await flushAsync();

    const props = createBackgroundTasksProps(host);
    expect(props.collapsed).toBe(true);
    expect(props.finishedCollapsed).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(props.tasks?.map((task) => task.id)).toEqual(["task-1"]);
    expect(props.activeCount).toBe(1);
  });

  it("keeps the later recent page's equally current running progress", async () => {
    const recent = makeTask({
      id: "task-1",
      toolUseCount: 2,
      lastToolName: "write",
      progressSummary: "Finishing the concurrent task report",
    });
    const active = makeTask({
      id: "task-1",
      toolUseCount: 2,
      lastToolName: "write",
      progressSummary: "Preparing the concurrent task report",
    });
    const { host, request } = createHost({
      request: (method, params) => {
        expect(method).toBe("tasks.list");
        const status = (params as { status?: string[] }).status;
        return Promise.resolve({ tasks: [status ? active : recent] });
      },
    });

    createBackgroundTasksProps(host);
    await flushAsync();

    expect(request.mock.calls[0]?.[1]).toMatchObject({ status: ["queued", "running"] });
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("status");
    expect(createBackgroundTasksProps(host).tasks).toEqual([recent]);
  });

  it("loads the snapshot when a task event arrives before any load", async () => {
    const { host, request } = createHost({
      connected: false,
      request: () => Promise.resolve({ tasks: [makeTask({ id: "task-1" })] }),
    });
    createBackgroundTasksProps(host);
    expect(request).not.toHaveBeenCalled();

    host.connected = true;
    handleBackgroundTasksEvent(host, {
      action: "upserted",
      task: makeTask({ id: "task-1" }),
    });
    await flushAsync();

    expect(request).toHaveBeenCalledTimes(2);
    const props = createBackgroundTasksProps(host);
    expect(props.tasks?.map((task) => task.id)).toEqual(["task-1"]);
  });

  it("keeps expansion across session switches and reloads the new scope", async () => {
    const { host, request } = createHost();
    createBackgroundTasksProps(host).onToggleCollapsed();
    createBackgroundTasksProps(host);
    await flushAsync();

    host.sessionKey = "agent:main:another-thread";
    const props = createBackgroundTasksProps(host);
    expect(props.collapsed).toBe(false);
    expect(props.sessionKey).toBe("agent:main:another-thread");
    expect(props.tasks).toBeNull();
    await flushAsync();
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
      sessionKey: "agent:main:another-thread",
    });
  });

  it("surfaces cancellation refusals through the rail props", async () => {
    const running = makeTask({ id: "task-1" });
    const { host } = createHost({
      request: (method) =>
        method === "tasks.list"
          ? Promise.resolve({ tasks: [running] })
          : Promise.resolve({
              found: true,
              cancelled: false,
              reason: "already finished: OPENAI_API_KEY=sk-1234567890abcdef",
            }),
    });
    const auth = { role: "operator" as const, scopes: ["operator.write"] };
    host.hello = { type: "hello-ok", protocol: 4, auth };
    createBackgroundTasksProps(host).onToggleCollapsed();
    await flushAsync();

    createBackgroundTasksProps(host).onCancel("task-1");
    await flushAsync();

    const props = createBackgroundTasksProps(host);
    expect(props.error).toBe("already finished: OPENAI_API_KEY=sk-123...cdef");
    expect(props.cancellingTaskIds.has("task-1")).toBe(false);
  });

  it("redacts secrets in cancellation failures", async () => {
    const running = makeTask({ id: "task-1" });
    const { host } = createHost({
      request: (method) =>
        method === "tasks.list"
          ? Promise.resolve({ tasks: [running] })
          : Promise.reject(new Error("OPENAI_API_KEY=sk-1234567890abcdef")),
    });
    host.hello = {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: ["operator.write"] },
    };
    createBackgroundTasksProps(host);
    await flushAsync();

    createBackgroundTasksProps(host).onCancel("task-1");
    await flushAsync();

    expect(createBackgroundTasksProps(host).error).toBe("OPENAI_API_KEY=sk-123...cdef");
  });

  it("routes row selection to the task panel and loads its bounded prompt on demand", async () => {
    const running = makeTask({
      id: "task-1",
      taskId: "runtime-task-1",
      progressSummary: "Reading files",
    });
    const { host, request } = createHost({
      request: (method) =>
        method === "tasks.get"
          ? Promise.resolve({ task: { ...running, prompt: "Audit the background task UI" } })
          : Promise.resolve({ tasks: [running] }),
    });
    createBackgroundTasksProps(host);
    await flushAsync();

    const onOpenTaskDetail = vi.fn();
    const selected = createBackgroundTasksProps(host, {
      openTaskId: running.id,
      onOpenTaskDetail,
    });
    selected.onOpenTaskDetail?.(running);
    expect(onOpenTaskDetail).toHaveBeenCalledWith(running);
    expect(selected.openTaskId).toBe(running.id);
    expect(request).not.toHaveBeenCalledWith("tasks.get", expect.anything());

    selected.onLoadDetail?.(running);
    await flushAsync();

    expect(request).toHaveBeenCalledWith("tasks.get", { taskId: "task-1" });
    const props = createBackgroundTasksProps(host);
    expect(props.taskDetails.get("task-1")?.prompt).toBe("Audit the background task UI");
  });

  it("lets reopening a task retry a failed detail lookup", async () => {
    const running = makeTask({ id: "task-1" });
    let failLookup = true;
    const { host, request } = createHost({
      request: (method) => {
        if (method !== "tasks.get") {
          return Promise.resolve({ tasks: [running] });
        }
        return failLookup
          ? Promise.reject(new Error("lookup blew up: OPENAI_API_KEY=sk-1234567890abcdef"))
          : Promise.resolve({ task: { ...running, prompt: "Recovered prompt" } });
      },
    });
    createBackgroundTasksProps(host);
    await flushAsync();

    createBackgroundTasksProps(host, { onOpenTaskDetail: () => {} }).onLoadDetail?.(running);
    await flushAsync();
    expect(createBackgroundTasksProps(host).taskDetailErrors.get("task-1")).toBe(
      "lookup blew up: OPENAI_API_KEY=sk-123...cdef",
    );

    // Selection clears the recorded error so the panel's render-driven load
    // (which must skip errored tasks to avoid a retry loop) can run again.
    failLookup = false;
    const reopened = createBackgroundTasksProps(host, { onOpenTaskDetail: () => {} });
    reopened.onOpenTaskDetail?.(running);
    const afterReopen = createBackgroundTasksProps(host, { onOpenTaskDetail: () => {} });
    expect(afterReopen.taskDetailErrors.has("task-1")).toBe(false);
    afterReopen.onLoadDetail?.(running);
    await flushAsync();

    expect(request).toHaveBeenCalledWith("tasks.get", { taskId: "task-1" });
    expect(createBackgroundTasksProps(host).taskDetails.get("task-1")?.prompt).toBe(
      "Recovered prompt",
    );
  });

  it("promotes a newer detail snapshot into the grouped task list", async () => {
    const running = makeTask({ id: "task-1", status: "running", updatedAt: 2_000 });
    const completed = makeTask({
      id: "task-1",
      status: "completed",
      updatedAt: 3_000,
      terminalSummary: "Finished in lookup",
      prompt: "Review the task",
    });
    const { host } = createHost({
      request: (method) =>
        method === "tasks.get"
          ? Promise.resolve({ task: completed })
          : Promise.resolve({ tasks: [running] }),
    });
    createBackgroundTasksProps(host);
    await flushAsync();

    createBackgroundTasksProps(host).onLoadDetail?.(running);
    await flushAsync();

    const props = createBackgroundTasksProps(host);
    expect(props.tasks?.map((task) => [task.id, task.status])).toEqual([["task-1", "completed"]]);
    expect(props.taskDetails.get("task-1")?.terminalSummary).toBe("Finished in lookup");
  });

  it("does not replace a newer detail snapshot with a stale list refresh", async () => {
    const running = makeTask({ id: "task-1", status: "running", updatedAt: 2_000 });
    const completed = makeTask({
      id: "task-1",
      status: "completed",
      updatedAt: 3_000,
      terminalSummary: "Finished in lookup",
      prompt: "Review the task",
    });
    let listCall = 0;
    let resolveActive: ((value: unknown) => void) | undefined;
    let resolveRecent: ((value: unknown) => void) | undefined;
    const active = new Promise<unknown>((resolve) => {
      resolveActive = resolve;
    });
    const recent = new Promise<unknown>((resolve) => {
      resolveRecent = resolve;
    });
    const { host } = createHost({
      request: (method) => {
        if (method === "tasks.get") {
          return Promise.resolve({ task: completed });
        }
        listCall += 1;
        if (listCall <= 2) {
          return Promise.resolve({ tasks: [running] });
        }
        return listCall === 3 ? active : recent;
      },
    });
    createBackgroundTasksProps(host);
    await flushAsync();

    createBackgroundTasksProps(host).onRefresh();
    createBackgroundTasksProps(host).onLoadDetail?.(running);
    await flushAsync();
    resolveActive?.({ tasks: [running] });
    resolveRecent?.({ tasks: [running] });
    await flushAsync();

    const props = createBackgroundTasksProps(host);
    expect(props.tasks?.map((task) => [task.id, task.status])).toEqual([["task-1", "completed"]]);
    expect(props.taskDetails.get("task-1")).toMatchObject({
      status: "completed",
      prompt: "Review the task",
      terminalSummary: "Finished in lookup",
    });
  });

  it("does not resurrect a task deleted while its detail lookup is pending", async () => {
    const running = makeTask({ id: "task-1" });
    let resolveDetail: ((value: unknown) => void) | undefined;
    const detail = new Promise<unknown>((resolve) => {
      resolveDetail = resolve;
    });
    const { host } = createHost({
      request: (method) =>
        method === "tasks.get" ? detail : Promise.resolve({ tasks: [running] }),
    });
    createBackgroundTasksProps(host);
    await flushAsync();

    createBackgroundTasksProps(host).onLoadDetail?.(running);
    handleBackgroundTasksEvent(host, { action: "deleted", taskId: "task-1" });
    resolveDetail?.({ task: { ...running, prompt: "Deleted task prompt" } });
    await flushAsync();

    const props = createBackgroundTasksProps(host);
    expect(props.tasks).toEqual([]);
    expect(props.taskDetails.has("task-1")).toBe(false);
  });
});

describe("background tasks rail events", () => {
  async function loadedHost(tasks: TaskSummary[]) {
    const { host, request } = createHost({
      request: () => Promise.resolve({ tasks }),
    });
    createBackgroundTasksProps(host).onToggleCollapsed();
    await flushAsync();
    return { host, request };
  }

  it("applies matching upserts and drops deletions", async () => {
    const { host } = await loadedHost([makeTask({ id: "task-1" })]);

    handleBackgroundTasksEvent(host, {
      action: "upserted",
      task: makeTask({ id: "task-2", status: "completed", updatedAt: 9_000 }),
    });
    let props = createBackgroundTasksProps(host);
    expect(props.tasks?.map((task) => task.id)).toEqual(["task-2", "task-1"]);

    handleBackgroundTasksEvent(host, { action: "deleted", taskId: "task-1" });
    props = createBackgroundTasksProps(host);
    expect(props.tasks?.map((task) => task.id)).toEqual(["task-2"]);
  });

  it("applies an equally current authoritative terminal event correction", async () => {
    const completed = makeTask({
      id: "task-1",
      status: "completed",
      updatedAt: 2_000,
      terminalSummary: "Previous terminal details",
    });
    const correction = makeTask({
      id: "task-1",
      status: "completed",
      updatedAt: 2_000,
      terminalSummary: "Authoritative terminal details",
    });
    const { host } = await loadedHost([completed]);

    handleBackgroundTasksEvent(host, { action: "upserted", task: correction });

    expect(createBackgroundTasksProps(host).tasks).toEqual([correction]);
  });

  it("does not roll back running tool activity from an equally current event", async () => {
    const progress = makeTask({
      id: "task-1",
      updatedAt: 2_000,
      toolUseCount: 2,
      lastToolName: "write",
    });
    const stale = makeTask({
      id: "task-1",
      updatedAt: 2_000,
      toolUseCount: 1,
      lastToolName: "read",
    });
    const { host } = await loadedHost([progress]);

    handleBackgroundTasksEvent(host, { action: "upserted", task: stale });

    expect(createBackgroundTasksProps(host).tasks).toEqual([progress]);
  });

  it("preserves an opened prompt when a terminal event corrects its output", async () => {
    const completed = makeTask({
      id: "task-1",
      status: "completed",
      updatedAt: 2_000,
      terminalSummary: "Previous terminal details",
    });
    const prompt = "Inspect the concurrent task owner";
    const correction = makeTask({
      id: "task-1",
      status: "completed",
      updatedAt: 2_000,
      terminalSummary: "Authoritative terminal details",
    });
    const { host } = createHost({
      request: (method) =>
        method === "tasks.get"
          ? Promise.resolve({ task: { ...completed, prompt } })
          : Promise.resolve({ tasks: [completed] }),
    });
    createBackgroundTasksProps(host);
    await flushAsync();
    createBackgroundTasksProps(host).onLoadDetail?.(completed);
    await flushAsync();

    handleBackgroundTasksEvent(host, { action: "upserted", task: correction });

    const props = createBackgroundTasksProps(host);
    expect(props.tasks?.[0]?.terminalSummary).toBe("Authoritative terminal details");
    expect(props.taskDetails.get("task-1")).toMatchObject({
      prompt,
      terminalSummary: "Authoritative terminal details",
    });
  });

  it("ignores upserts for other sessions, including the same agent", async () => {
    const { host } = await loadedHost([makeTask({ id: "task-1" })]);

    handleBackgroundTasksEvent(host, {
      action: "upserted",
      task: makeTask({ id: "task-2", sessionKey: "agent:main:another-thread" }),
    });

    const props = createBackgroundTasksProps(host);
    expect(props.tasks?.map((task) => task.id)).toEqual(["task-1"]);
  });

  it("matches tasks through their owner key like the gateway filter", async () => {
    const { host } = await loadedHost([makeTask({ id: "task-1" })]);

    handleBackgroundTasksEvent(host, {
      action: "upserted",
      task: {
        ...makeTask({ id: "task-owner", updatedAt: 9_000 }),
        ownerKey: "agent:main:current",
        sessionKey: "agent:main:child-task",
      },
    });

    const props = createBackgroundTasksProps(host);
    expect(props.tasks?.map((task) => task.id)).toEqual(["task-owner", "task-1"]);
  });

  it("refetches after a registry restore", async () => {
    const { host, request } = await loadedHost([makeTask({ id: "task-1" })]);
    const callsBefore = request.mock.calls.length;

    handleBackgroundTasksEvent(host, { action: "restored" });
    await flushAsync();

    expect(request.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("does not replace a newer lookup snapshot with a stale event", async () => {
    const running = makeTask({ id: "task-1", status: "running", updatedAt: 1_000 });
    const completed = makeTask({
      id: "task-1",
      status: "completed",
      updatedAt: 3_000,
      terminalSummary: "Lookup completed",
      prompt: "Review the task",
    });
    const { host } = createHost({
      request: (method) =>
        method === "tasks.get"
          ? Promise.resolve({ task: completed })
          : Promise.resolve({ tasks: [running] }),
    });
    createBackgroundTasksProps(host);
    await flushAsync();
    createBackgroundTasksProps(host).onLoadDetail?.(running);
    await flushAsync();

    handleBackgroundTasksEvent(host, {
      action: "upserted",
      task: makeTask({ id: "task-1", status: "running", updatedAt: 2_000 }),
    });

    const props = createBackgroundTasksProps(host);
    expect(props.tasks?.[0]?.status).toBe("completed");
    expect(props.taskDetails.get("task-1")).toMatchObject({
      status: "completed",
      prompt: "Review the task",
      terminalSummary: "Lookup completed",
    });
  });
});

describe("background tasks rail rendering", () => {
  it("routes every task runtime to the panel and highlights the open task", () => {
    const onCancel = vi.fn();
    const onOpenTaskDetail = vi.fn();
    const container = renderTaskRail({
      canCancel: true,
      openTaskId: "task-2",
      tasks: [
        makeTask({
          id: "task-1",
          taskId: "runtime-task-1",
          childSessionKey: "agent:main:subagent:abc",
        }),
        makeTask({
          id: "task-2",
          status: "completed",
          runtime: "cli",
          title: "Finished work",
          sessionKey: "agent:main:cli:finished",
        }),
      ],
      onCancel,
      onOpenTaskDetail,
    });

    const rows = container.querySelectorAll(".chat-tasks-rail__task");
    expect(rows.length).toBe(2);

    const stop = container.querySelector<HTMLButtonElement>(".chat-tasks-rail__task-stop");
    expect(stop).not.toBeNull();
    stop?.click();
    expect(onCancel).toHaveBeenCalledWith("task-1");
    expect(onOpenTaskDetail).not.toHaveBeenCalled();

    const cliTask = container.querySelector('[data-task-id="task-2"]');
    expect(cliTask?.classList.contains("chat-tasks-rail__task--open")).toBe(true);
    expect(cliTask?.getAttribute("aria-current")).toBe("true");
    cliTask?.querySelector<HTMLButtonElement>(".chat-tasks-rail__task-open")?.click();
    expect(onOpenTaskDetail).toHaveBeenCalledWith(expect.objectContaining({ id: "task-2" }));
  });

  it("shows live tool activity for running tasks and duration for finished tasks", () => {
    const container = renderTaskRail({
      tasks: [
        makeTask({ id: "task-1", toolUseCount: 12, lastToolName: "read" }),
        makeTask({
          id: "task-2",
          status: "completed",
          startedAt: 1_000,
          endedAt: 66_000,
          updatedAt: 70_000,
          toolUseCount: 1,
        }),
      ],
    });

    const running = container.querySelector('[data-task-id="task-1"]');
    expect(running?.textContent).toContain("12 tool uses");
    expect(running?.textContent).toContain("read");
    expect(running?.querySelector("openclaw-elapsed-time")).not.toBeNull();

    const finished = container.querySelector('[data-task-id="task-2"]');
    expect(finished?.textContent).toContain("1 tool use");
    expect(finished?.textContent).toContain("1m 5s");
    expect(finished?.querySelector("openclaw-elapsed-time")).toBeNull();
  });

  it("collapses the finished section", () => {
    const container = renderTaskRail({
      tasks: [makeTask({ id: "task-2", status: "completed" })],
      finishedCollapsed: true,
    });

    expect(container.querySelectorAll(".chat-tasks-rail__task").length).toBe(0);
    expect(
      container.querySelector<HTMLButtonElement>(".chat-tasks-rail__section-toggle"),
    ).not.toBeNull();
  });
});

describe("running-tasks status row", () => {
  const makeAggregateTask = (overrides: Partial<TaskSummary> & { id: string }) =>
    makeTask({ ...overrides, runtime: "cli" });

  it("ticks from the oldest active start and counts only active tasks", () => {
    const container = renderStatusRow({
      tasks: [
        makeAggregateTask({ id: "t1", startedAt: 9_000 }),
        makeAggregateTask({
          id: "t2",
          status: "queued",
          startedAt: undefined,
          createdAt: 4_000,
        }),
        makeAggregateTask({ id: "t3", status: "completed", startedAt: 100 }),
      ],
    });

    const elapsed = container.querySelector<HTMLElement & { startMs: number | null }>(
      "openclaw-elapsed-time",
    );
    expect(elapsed?.startMs).toBe(4_000);
    expect(
      container.querySelector<HTMLButtonElement>(".chat-tasks-status__link")?.textContent?.trim(),
    ).toBe("2 running tasks");
  });

  it("renders count, ticking elapsed time, and opens the collapsed rail", () => {
    const onToggleCollapsed = vi.fn();
    const container = renderStatusRow({
      tasks: [makeAggregateTask({ id: "t1", startedAt: 9_000 })],
      onToggleCollapsed,
    });

    const row = container.querySelector(".chat-tasks-status");
    expect(row).not.toBeNull();
    expect(row?.querySelector("openclaw-elapsed-time")).not.toBeNull();
    const liveStatus = row?.querySelector('[role="status"]');
    expect(liveStatus?.textContent?.trim()).toBe("1 running task");
    expect(liveStatus?.querySelector("openclaw-elapsed-time")).toBeNull();
    const link = row?.querySelector<HTMLButtonElement>(".chat-tasks-status__link");
    expect(link?.textContent?.trim()).toBe("1 running task");
    link?.click();
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("pluralizes the label and leaves an open rail alone", () => {
    const onToggleCollapsed = vi.fn();
    const container = renderStatusRow({
      collapsed: false,
      tasks: [makeAggregateTask({ id: "t1" }), makeAggregateTask({ id: "t2", status: "queued" })],
      onToggleCollapsed,
    });

    const link = container.querySelector<HTMLButtonElement>(".chat-tasks-status__link");
    expect(link?.textContent?.trim()).toBe("2 running tasks");
    link?.click();
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });

  it("anchors a hover preview of the latest tasks, active first, capped at five", () => {
    const container = renderStatusRow({
      tasks: [
        makeAggregateTask({ id: "a1", title: "Active one", updatedAt: 9_000 }),
        makeAggregateTask({
          id: "a2",
          status: "queued",
          title: "Queued two",
          updatedAt: 8_000,
        }),
        makeAggregateTask({
          id: "f1",
          status: "completed",
          title: "Finished one",
          updatedAt: 7_000,
        }),
        makeAggregateTask({
          id: "f2",
          status: "failed",
          title: "Finished two",
          updatedAt: 6_000,
        }),
        makeAggregateTask({
          id: "f3",
          status: "completed",
          title: "Finished three",
          updatedAt: 5_000,
        }),
        makeAggregateTask({
          id: "f4",
          status: "completed",
          title: "Finished four",
          updatedAt: 4_000,
        }),
      ],
    });

    const preview = container.querySelector("openclaw-tooltip.chat-tasks-status__preview");
    expect(preview?.firstElementChild?.classList.contains("chat-tasks-status__link")).toBe(true);
    expect(container.querySelector(".chat-tasks-status")?.id).toBe("chat-tasks-status-test");
    expect(preview?.querySelector('.chat-tasks-preview[slot="content"]')).not.toBeNull();
    const titles = [...container.querySelectorAll(".chat-tasks-preview__title")].map((el) =>
      el.textContent?.trim(),
    );
    expect(titles).toEqual([
      "Active one",
      "Queued two",
      "Finished one",
      "Finished two",
      "Finished three",
    ]);
    expect(container.querySelector(".chat-tasks-preview__more")?.textContent?.trim()).toBe(
      "+1 more",
    );
  });

  it("sizes the preview to the task list without an overflow line", () => {
    const container = renderStatusRow({
      tasks: [makeAggregateTask({ id: "t1", title: "Only task" })],
    });

    expect(container.querySelectorAll(".chat-tasks-preview__row").length).toBe(1);
    expect(container.querySelector(".chat-tasks-preview__more")).toBeNull();
  });

  it("renders nothing without active tasks", () => {
    const container = renderStatusRow({
      tasks: [makeAggregateTask({ id: "t1", status: "completed" })],
    });
    expect(container.querySelector(".chat-tasks-status")).toBeNull();
  });

  it("hides the stale snapshot while disconnected", () => {
    const container = renderStatusRow({
      connected: false,
      tasks: [makeAggregateTask({ id: "t1" })],
    });
    expect(container.querySelector(".chat-tasks-status")).toBeNull();
  });
});
