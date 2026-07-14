import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { TaskSummary } from "../../../lib/tasks/data.ts";
import {
  createBackgroundTasksProps,
  handleBackgroundTasksEvent,
  renderBackgroundTasksRail,
  renderBackgroundTasksStatusRow,
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
        collapsed: false,
        narrowLayout: false,
        connected: true,
        canCancel: true,
        loading: false,
        error: null,
        tasks: [
          makeTask({ id: "task-1", childSessionKey: "agent:main:subagent:abc" }),
          makeTask({ id: "task-2", status: "completed", title: "Finished work" }),
        ],
        cancellingTaskIds: new Set(),
        finishedCollapsed: false,
        onToggleCollapsed: () => {},
        onToggleFinished: () => {},
        onRefresh: () => {},
        onCancel,
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
        onToggleCollapsed: () => {},
        onToggleFinished: () => {},
        onRefresh: () => {},
        onCancel: () => {},
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

  it("collapses the finished section", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`${renderBackgroundTasksRail({
        agentId: "main",
        collapsed: false,
        narrowLayout: false,
        connected: true,
        canCancel: false,
        loading: false,
        error: null,
        tasks: [makeTask({ id: "task-2", status: "completed" })],
        cancellingTaskIds: new Set(),
        finishedCollapsed: true,
        onToggleCollapsed: () => {},
        onToggleFinished: () => {},
        onRefresh: () => {},
        onCancel: () => {},
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
      collapsed: true,
      narrowLayout: false,
      connected: true,
      canCancel: false,
      loading: false,
      error: null,
      tasks: null,
      cancellingTaskIds: new Set(),
      finishedCollapsed: false,
      onToggleCollapsed: () => {},
      onToggleFinished: () => {},
      onRefresh: () => {},
      onCancel: () => {},
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
