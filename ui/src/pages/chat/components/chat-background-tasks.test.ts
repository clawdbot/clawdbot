import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { TaskSummary } from "../../../lib/tasks/data.ts";
import { renderBackgroundTasksStatusRow } from "./chat-background-tasks-status.ts";
import {
  createBackgroundTasksProps,
  handleBackgroundTasksEvent,
  renderBackgroundTasksRail,
  type BackgroundTasksHost,
  type BackgroundTasksProps,
} from "./chat-background-tasks.ts";

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

const openSession = { onOpenSession: () => {} };

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("background tasks rail state", () => {
  it("loads agent-scoped tasks eagerly while the rail is collapsed", async () => {
    const { host, request } = createHost({
      request: (method, params) => {
        expect(method).toBe("tasks.list");
        expect((params as { agentId?: string }).agentId).toBe("main");
        return Promise.resolve({ tasks: [makeTask({ id: "task-1" })] });
      },
    });

    expect(createBackgroundTasksProps(host, openSession).collapsed).toBe(true);
    await flushAsync();

    const props = createBackgroundTasksProps(host, openSession);
    expect(props.collapsed).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(props.tasks?.map((task) => task.id)).toEqual(["task-1"]);
  });

  it("loads the snapshot when a task event arrives before any load", async () => {
    const { host, request } = createHost({
      connected: false,
      request: () => Promise.resolve({ tasks: [makeTask({ id: "task-1" })] }),
    });
    createBackgroundTasksProps(host, openSession);
    expect(request).not.toHaveBeenCalled();

    host.connected = true;
    handleBackgroundTasksEvent(host, {
      action: "upserted",
      task: makeTask({ id: "task-1" }),
    });
    await flushAsync();

    expect(request).toHaveBeenCalledTimes(2);
    const props = createBackgroundTasksProps(host, openSession);
    expect(props.tasks?.map((task) => task.id)).toEqual(["task-1"]);
  });

  it("keeps expansion across agent switches and reloads the new scope", async () => {
    const { host, request } = createHost();
    createBackgroundTasksProps(host, openSession).onToggleCollapsed();
    createBackgroundTasksProps(host, openSession);
    await flushAsync();

    host.sessionKey = "agent:research:current";
    const props = createBackgroundTasksProps(host, openSession);
    expect(props.collapsed).toBe(false);
    expect(props.agentId).toBe("research");
    expect(props.tasks).toBeNull();
    await flushAsync();
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ agentId: "research" });
  });

  it("surfaces cancellation refusals through the rail props", async () => {
    const running = makeTask({ id: "task-1" });
    const { host } = createHost({
      request: (method) =>
        method === "tasks.list"
          ? Promise.resolve({ tasks: [running] })
          : Promise.resolve({ found: true, cancelled: false, reason: "already finished" }),
    });
    const auth = { role: "operator" as const, scopes: ["operator.write"] };
    host.hello = { type: "hello-ok", protocol: 4, auth };
    createBackgroundTasksProps(host, openSession).onToggleCollapsed();
    await flushAsync();

    createBackgroundTasksProps(host, openSession).onCancel("task-1");
    await flushAsync();

    const props = createBackgroundTasksProps(host, openSession);
    expect(props.error).toBe("already finished");
    expect(props.cancellingTaskIds.has("task-1")).toBe(false);
  });

  it("loads the bounded prompt when a task is opened", async () => {
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
    createBackgroundTasksProps(host, openSession);
    await flushAsync();

    createBackgroundTasksProps(host, openSession).onToggleTask(running);
    await flushAsync();

    expect(request).toHaveBeenCalledWith("tasks.get", { taskId: "task-1" });
    const props = createBackgroundTasksProps(host, openSession);
    expect(props.selectedTaskId).toBe("task-1");
    expect(props.taskDetails.get("task-1")?.prompt).toBe("Audit the background task UI");
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
    createBackgroundTasksProps(host, openSession);
    await flushAsync();

    createBackgroundTasksProps(host, openSession).onToggleTask(running);
    await flushAsync();

    const props = createBackgroundTasksProps(host, openSession);
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
    createBackgroundTasksProps(host, openSession);
    await flushAsync();

    createBackgroundTasksProps(host, openSession).onRefresh();
    createBackgroundTasksProps(host, openSession).onToggleTask(running);
    await flushAsync();
    resolveActive?.({ tasks: [running] });
    resolveRecent?.({ tasks: [running] });
    await flushAsync();

    const props = createBackgroundTasksProps(host, openSession);
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
    createBackgroundTasksProps(host, openSession);
    await flushAsync();

    createBackgroundTasksProps(host, openSession).onToggleTask(running);
    handleBackgroundTasksEvent(host, { action: "deleted", taskId: "task-1" });
    resolveDetail?.({ task: { ...running, prompt: "Deleted task prompt" } });
    await flushAsync();

    const props = createBackgroundTasksProps(host, openSession);
    expect(props.tasks).toEqual([]);
    expect(props.selectedTaskId).toBeNull();
    expect(props.taskDetails.has("task-1")).toBe(false);
  });
});

describe("background tasks rail events", () => {
  async function loadedHost(tasks: TaskSummary[]) {
    const { host, request } = createHost({
      request: () => Promise.resolve({ tasks }),
    });
    createBackgroundTasksProps(host, openSession).onToggleCollapsed();
    await flushAsync();
    return { host, request };
  }

  it("applies matching upserts and drops deletions", async () => {
    const { host } = await loadedHost([makeTask({ id: "task-1" })]);

    handleBackgroundTasksEvent(host, {
      action: "upserted",
      task: makeTask({ id: "task-2", status: "completed", updatedAt: 9_000 }),
    });
    let props = createBackgroundTasksProps(host, openSession);
    expect(props.tasks?.map((task) => task.id)).toEqual(["task-2", "task-1"]);

    handleBackgroundTasksEvent(host, { action: "deleted", taskId: "task-1" });
    props = createBackgroundTasksProps(host, openSession);
    expect(props.tasks?.map((task) => task.id)).toEqual(["task-2"]);
  });

  it("ignores upserts for other agents", async () => {
    const { host } = await loadedHost([makeTask({ id: "task-1" })]);

    handleBackgroundTasksEvent(host, {
      action: "upserted",
      task: makeTask({ id: "task-2", agentId: "other" }),
    });

    const props = createBackgroundTasksProps(host, openSession);
    expect(props.tasks?.map((task) => task.id)).toEqual(["task-1"]);
  });

  it("matches legacy tasks through their owner key like the gateway filter", async () => {
    const { host } = await loadedHost([makeTask({ id: "task-1" })]);

    handleBackgroundTasksEvent(host, {
      action: "upserted",
      task: {
        ...makeTask({ id: "task-owner", updatedAt: 9_000 }),
        agentId: undefined,
        ownerKey: "agent:main:owner",
      },
    });

    const props = createBackgroundTasksProps(host, openSession);
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
    createBackgroundTasksProps(host, openSession);
    await flushAsync();
    createBackgroundTasksProps(host, openSession).onToggleTask(running);
    await flushAsync();

    handleBackgroundTasksEvent(host, {
      action: "upserted",
      task: makeTask({ id: "task-1", status: "running", updatedAt: 2_000 }),
    });

    const props = createBackgroundTasksProps(host, openSession);
    expect(props.tasks?.[0]?.status).toBe("completed");
    expect(props.taskDetails.get("task-1")).toMatchObject({
      status: "completed",
      prompt: "Review the task",
      terminalSummary: "Lookup completed",
    });
  });
});

describe("background tasks rail rendering", () => {
  it("renders running and finished sections with stop and transcript actions", () => {
    const onCancel = vi.fn();
    const onOpenSession = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`${renderBackgroundTasksRail({
        agentId: "main",
        statusRowId: "chat-tasks-status-test",
        collapsed: false,
        narrowLayout: false,
        connected: true,
        canCancel: true,
        loading: false,
        error: null,
        tasks: [
          makeTask({
            id: "task-1",
            taskId: "runtime-task-1",
            childSessionKey: "agent:main:subagent:abc",
          }),
          makeTask({ id: "task-2", status: "completed", title: "Finished work" }),
        ],
        cancellingTaskIds: new Set(),
        finishedCollapsed: false,
        selectedTaskId: null,
        taskDetails: new Map(),
        taskDetailErrors: new Map(),
        taskDetailLoadingIds: new Set(),
        onToggleCollapsed: () => {},
        onToggleFinished: () => {},
        onRefresh: () => {},
        onCancel,
        onToggleTask: () => {},
        onOpenSession,
      })}`,
      container,
    );

    const rows = container.querySelectorAll(".chat-tasks-rail__task");
    expect(rows.length).toBe(2);

    const stop = container.querySelector<HTMLButtonElement>(".chat-tasks-rail__task-stop");
    expect(stop).not.toBeNull();
    stop?.click();
    expect(onCancel).toHaveBeenCalledWith("task-1");

    const transcript = container.querySelector<HTMLButtonElement>(
      ".chat-tasks-rail__task-transcript",
    );
    expect(transcript).not.toBeNull();
    transcript?.click();
    expect(onOpenSession).toHaveBeenCalledWith("agent:main:subagent:abc");
  });

  it("shows live tool activity for running tasks and duration for finished tasks", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`${renderBackgroundTasksRail({
        agentId: "main",
        statusRowId: "chat-tasks-status-test",
        collapsed: false,
        narrowLayout: false,
        connected: true,
        canCancel: false,
        loading: false,
        error: null,
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
        cancellingTaskIds: new Set(),
        finishedCollapsed: false,
        selectedTaskId: null,
        taskDetails: new Map(),
        taskDetailErrors: new Map(),
        taskDetailLoadingIds: new Set(),
        onToggleCollapsed: () => {},
        onToggleFinished: () => {},
        onRefresh: () => {},
        onCancel: () => {},
        onToggleTask: () => {},
        onOpenSession: () => {},
      })}`,
      container,
    );

    const running = container.querySelector('[data-task-id="task-1"]');
    expect(running?.textContent).toContain("12 tool uses");
    expect(running?.textContent).toContain("read");
    expect(running?.querySelector("openclaw-elapsed-time")).not.toBeNull();

    const finished = container.querySelector('[data-task-id="task-2"]');
    expect(finished?.textContent).toContain("1 tool use");
    expect(finished?.textContent).toContain("1m 5s");
    expect(finished?.querySelector("openclaw-elapsed-time")).toBeNull();
  });

  it("opens a task inspector with prompt and output", () => {
    const onToggleTask = vi.fn();
    const task = makeTask({
      id: "task-1",
      status: "completed",
      terminalSummary: "Audit complete",
    });
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`${renderBackgroundTasksRail({
        agentId: "main",
        statusRowId: "chat-tasks-status-test",
        collapsed: false,
        narrowLayout: false,
        connected: true,
        canCancel: false,
        loading: false,
        error: null,
        tasks: [task],
        cancellingTaskIds: new Set(),
        finishedCollapsed: false,
        selectedTaskId: "task-1",
        taskDetails: new Map([
          [
            "task-1",
            { ...task, terminalSummary: "Stale running progress", prompt: "Review running tasks" },
          ],
        ]),
        taskDetailErrors: new Map(),
        taskDetailLoadingIds: new Set(),
        onToggleCollapsed: () => {},
        onToggleFinished: () => {},
        onRefresh: () => {},
        onCancel: () => {},
        onToggleTask,
        onOpenSession: () => {},
      })}`,
      container,
    );

    const inspector = container.querySelector('[data-task-inspector="task-1"]');
    expect(inspector?.textContent).toContain("Review running tasks");
    expect(inspector?.textContent).toContain("Audit complete");
    expect(inspector?.textContent).not.toContain("Stale running progress");
    inspector?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onToggleTask).not.toHaveBeenCalled();
    const disclosure = container.querySelector<HTMLButtonElement>(
      ".chat-tasks-rail__task-disclosure",
    );
    expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
    disclosure?.click();
    expect(onToggleTask).toHaveBeenCalledWith(task);
  });

  it("uses a newer lookup snapshot for output", () => {
    const listTask = makeTask({
      id: "task-1",
      status: "running",
      updatedAt: 2_000,
      progressSummary: "Still running",
    });
    const lookupTask = makeTask({
      id: "task-1",
      status: "completed",
      updatedAt: 3_000,
      terminalSummary: "Finished in lookup",
      prompt: "Review running tasks",
    });
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`${renderBackgroundTasksRail({
        agentId: "main",
        statusRowId: "chat-tasks-status-test",
        collapsed: false,
        narrowLayout: false,
        connected: true,
        canCancel: false,
        loading: false,
        error: null,
        tasks: [listTask],
        cancellingTaskIds: new Set(),
        finishedCollapsed: false,
        selectedTaskId: "task-1",
        taskDetails: new Map([["task-1", lookupTask]]),
        taskDetailErrors: new Map(),
        taskDetailLoadingIds: new Set(),
        onToggleCollapsed: () => {},
        onToggleFinished: () => {},
        onRefresh: () => {},
        onCancel: () => {},
        onToggleTask: () => {},
        onOpenSession: () => {},
      })}`,
      container,
    );

    const inspector = container.querySelector('[data-task-inspector="task-1"]');
    expect(inspector?.textContent).toContain("Finished in lookup");
    expect(inspector?.textContent).not.toContain("Still running");
  });

  it("collapses the finished section", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`${renderBackgroundTasksRail({
        agentId: "main",
        statusRowId: "chat-tasks-status-test",
        collapsed: false,
        narrowLayout: false,
        connected: true,
        canCancel: false,
        loading: false,
        error: null,
        tasks: [makeTask({ id: "task-2", status: "completed" })],
        cancellingTaskIds: new Set(),
        finishedCollapsed: true,
        selectedTaskId: null,
        taskDetails: new Map(),
        taskDetailErrors: new Map(),
        taskDetailLoadingIds: new Set(),
        onToggleCollapsed: () => {},
        onToggleFinished: () => {},
        onRefresh: () => {},
        onCancel: () => {},
        onToggleTask: () => {},
        onOpenSession: () => {},
      })}`,
      container,
    );

    expect(container.querySelectorAll(".chat-tasks-rail__task").length).toBe(0);
    expect(
      container.querySelector<HTMLButtonElement>(".chat-tasks-rail__section-toggle"),
    ).not.toBeNull();
  });
});

describe("running-tasks status row", () => {
  function makeProps(overrides: Partial<BackgroundTasksProps>): BackgroundTasksProps {
    return {
      agentId: "main",
      statusRowId: "chat-tasks-status-test",
      collapsed: true,
      narrowLayout: false,
      connected: true,
      canCancel: false,
      loading: false,
      error: null,
      tasks: null,
      cancellingTaskIds: new Set(),
      finishedCollapsed: false,
      selectedTaskId: null,
      taskDetails: new Map(),
      taskDetailErrors: new Map(),
      taskDetailLoadingIds: new Set(),
      onToggleCollapsed: () => {},
      onToggleFinished: () => {},
      onRefresh: () => {},
      onCancel: () => {},
      onToggleTask: () => {},
      onOpenSession: () => {},
      ...overrides,
    };
  }

  it("ticks from the oldest active start and counts only active tasks", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`${renderBackgroundTasksStatusRow(
        makeProps({
          tasks: [
            makeTask({ id: "t1", startedAt: 9_000 }),
            makeTask({ id: "t2", status: "queued", startedAt: undefined, createdAt: 4_000 }),
            makeTask({ id: "t3", status: "completed", startedAt: 100 }),
          ],
        }),
      )}`,
      container,
    );

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
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`${renderBackgroundTasksStatusRow(
        makeProps({
          tasks: [makeTask({ id: "t1", startedAt: 9_000 })],
          onToggleCollapsed,
        }),
      )}`,
      container,
    );

    const row = container.querySelector(".chat-tasks-status");
    expect(row).not.toBeNull();
    expect(row?.querySelector("openclaw-elapsed-time")).not.toBeNull();
    // The ticking timer must stay outside the polite live region.
    expect(row?.querySelector(".chat-tasks-status__time")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    const link = row?.querySelector<HTMLButtonElement>(".chat-tasks-status__link");
    expect(link?.textContent?.trim()).toBe("1 running task");
    link?.click();
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("pluralizes the label and leaves an open rail alone", () => {
    const onToggleCollapsed = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`${renderBackgroundTasksStatusRow(
        makeProps({
          collapsed: false,
          tasks: [makeTask({ id: "t1" }), makeTask({ id: "t2", status: "queued" })],
          onToggleCollapsed,
        }),
      )}`,
      container,
    );

    const link = container.querySelector<HTMLButtonElement>(".chat-tasks-status__link");
    expect(link?.textContent?.trim()).toBe("2 running tasks");
    link?.click();
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });

  it("anchors a hover preview of the latest tasks, active first, capped at five", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`${renderBackgroundTasksStatusRow(
        makeProps({
          tasks: [
            makeTask({ id: "a1", title: "Active one", updatedAt: 9_000 }),
            makeTask({ id: "a2", status: "queued", title: "Queued two", updatedAt: 8_000 }),
            makeTask({ id: "f1", status: "completed", title: "Finished one", updatedAt: 7_000 }),
            makeTask({ id: "f2", status: "failed", title: "Finished two", updatedAt: 6_000 }),
            makeTask({ id: "f3", status: "completed", title: "Finished three", updatedAt: 5_000 }),
            makeTask({ id: "f4", status: "completed", title: "Finished four", updatedAt: 4_000 }),
          ],
        }),
      )}`,
      container,
    );

    const preview = container.querySelector("openclaw-tooltip.chat-tasks-status__preview");
    expect(preview?.querySelector(".chat-tasks-status")?.id).toBe("chat-tasks-status-test");
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
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`${renderBackgroundTasksStatusRow(
        makeProps({ tasks: [makeTask({ id: "t1", title: "Only task" })] }),
      )}`,
      container,
    );

    expect(container.querySelectorAll(".chat-tasks-preview__row").length).toBe(1);
    expect(container.querySelector(".chat-tasks-preview__more")).toBeNull();
  });

  it("renders nothing without active tasks", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`${renderBackgroundTasksStatusRow(
        makeProps({ tasks: [makeTask({ id: "t1", status: "completed" })] }),
      )}`,
      container,
    );
    expect(container.querySelector(".chat-tasks-status")).toBeNull();
  });

  it("hides the stale snapshot while disconnected", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`${renderBackgroundTasksStatusRow(
        makeProps({ connected: false, tasks: [makeTask({ id: "t1" })] }),
      )}`,
      container,
    );
    expect(container.querySelector(".chat-tasks-status")).toBeNull();
  });
});
