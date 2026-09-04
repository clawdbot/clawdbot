import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import { renderBackgroundTasksStatusRow } from "./chat-background-tasks-status.ts";
import {
  createBackgroundTasksProps,
  handleBackgroundTasksEvent,
  type BackgroundTasksHost,
} from "./chat-background-tasks.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import { deriveSubagentActivity } from "./chat-subagent-activity.ts";

const TERMINAL_RETENTION_MS = 60_000;

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

function makeProps(overrides: Partial<BackgroundTasksProps>): BackgroundTasksProps {
  return {
    sessionKey: "agent:main:current",
    statusRowId: "chat-tasks-status-test",
    collapsed: true,
    narrowLayout: false,
    connected: true,
    canCancel: false,
    loading: false,
    error: null,
    tasks: [],
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
    onOpenTaskDetail: undefined,
    ...overrides,
  };
}

function renderStatusRow(overrides: Partial<BackgroundTasksProps>) {
  const container = document.createElement("div");
  document.body.append(container);
  render(html`${renderBackgroundTasksStatusRow(makeProps(overrides))}`, container);
  return container;
}

function createHost(task: TaskSummary) {
  const requestUpdate = vi.fn();
  const request = vi.fn(() => Promise.resolve({ tasks: [task] }));
  const host: BackgroundTasksHost = {
    sessionKey: "agent:main:current",
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
    hello: null,
    requestUpdate,
  };
  return { host, requestUpdate };
}

function flushAsync() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("subagent activity rows", () => {
  it("opens the selected subagent from an accessible activity control", () => {
    const task = makeTask({ id: "clickable-subagent" });
    const onOpenTaskDetail = vi.fn();
    const container = renderStatusRow({
      tasks: [task],
      subagentActivity: deriveSubagentActivity({
        tasks: [task],
        sessionKey: "agent:main:current",
        terminalObservedAtByTask: new Map(),
        canonicalizeSessionKey: (sessionKey) => sessionKey ?? "",
      }),
      onOpenTaskDetail,
    });

    const row = container.querySelector<HTMLButtonElement>(
      '[data-subagent-task-id="clickable-subagent"]',
    );
    expect(row?.tagName).toBe("BUTTON");
    expect(row?.getAttribute("aria-label")).toBe("Open subagent details for Map codebase");
    row?.click();
    expect(onOpenTaskDetail).toHaveBeenCalledWith(task);
  });

  it("keeps activity rows non-interactive when no open callback is provided", () => {
    const task = makeTask({ id: "status-only-subagent" });
    const container = renderStatusRow({
      tasks: [task],
      subagentActivity: deriveSubagentActivity({
        tasks: [task],
        sessionKey: "agent:main:current",
        terminalObservedAtByTask: new Map(),
        canonicalizeSessionKey: (sessionKey) => sessionKey ?? "",
      }),
    });

    const row = container.querySelector('[data-subagent-task-id="status-only-subagent"]');
    expect(row?.tagName).toBe("DIV");
    expect(row?.getAttribute("role")).toBe("status");
    expect(row?.hasAttribute("tabindex")).toBe(false);
  });

  it("filters by requester, runtime, and retention while leaving other work in the aggregate", () => {
    const now = 100_000;
    const current = makeTask({
      id: "current-subagent",
      lastActivity: "Reviewing the current session",
      updatedAt: now,
    });
    const recent = makeTask({
      id: "recent-subagent",
      status: "completed",
      updatedAt: now - 1_000,
      endedAt: now - 1_000,
      terminalSummary: "Review complete",
    });
    const otherRuntime = makeTask({
      id: "other-runtime",
      runtime: "cli",
      lastActivity: "CLI task",
    });
    const tasks = [
      current,
      recent,
      makeTask({
        id: "other-session",
        sessionKey: "agent:main:other",
        lastActivity: "Wrong requester",
      }),
      otherRuntime,
      makeTask({
        id: "expired-subagent",
        status: "completed",
        updatedAt: now - TERMINAL_RETENTION_MS - 1,
        endedAt: now - TERMINAL_RETENTION_MS - 1,
        terminalSummary: "Too old",
      }),
    ];
    const subagentActivity = deriveSubagentActivity({
      tasks,
      sessionKey: "agent:main:current",
      terminalObservedAtByTask: new Map(),
      canonicalizeSessionKey: (sessionKey) => sessionKey ?? "",
      now,
    });

    expect(subagentActivity.rows.map((task) => task.id)).toEqual([
      "current-subagent",
      "recent-subagent",
    ]);
    expect([...subagentActivity.taskIds]).toEqual(["current-subagent", "recent-subagent"]);

    const container = renderStatusRow({
      tasks: [current, recent, otherRuntime],
      subagentActivity,
    });
    expect(container.querySelectorAll(".chat-subagent-activity__row")).toHaveLength(2);
    expect(container.textContent).toContain("Reviewing the current session");
    expect(container.textContent).toContain("Subagent finished");
    expect(container.textContent).not.toContain("Wrong requester");
    expect(container.textContent).not.toContain("Too old");
    expect(container.querySelector(".chat-tasks-status__link")?.textContent?.trim()).toBe(
      "1 running task",
    );
  });

  it("caps visible rows at five and counts only hidden running work", () => {
    const running = Array.from({ length: 7 }, (_, index) =>
      makeTask({
        id: `running-${index}`,
        lastActivity: `Running child ${index}`,
        updatedAt: 10_000 - index,
      }),
    );
    const queued = Array.from({ length: 2 }, (_, index) =>
      makeTask({ id: `queued-${index}`, status: "queued", updatedAt: 1_000 - index }),
    );
    const subagentActivity = deriveSubagentActivity({
      tasks: [...running, ...queued],
      sessionKey: "agent:main:current",
      terminalObservedAtByTask: new Map(),
      canonicalizeSessionKey: (sessionKey) => sessionKey ?? "",
      now: 20_000,
    });
    const container = renderStatusRow({
      tasks: [...running, ...queued],
      subagentActivity,
    });

    expect(container.querySelectorAll(".chat-subagent-activity__row")).toHaveLength(5);
    expect(container.querySelector(".chat-subagent-activity__overflow")?.textContent?.trim()).toBe(
      "+2 more working",
    );
    expect(container.querySelector(".chat-tasks-status")).toBeNull();
  });

  it("retires live text but retains diff stats through terminal activity", async () => {
    const running = makeTask({
      id: "retained-subagent",
      lastActivity: "Editing the final report",
      diffStat: { files: 2, added: 12, removed: 3 },
    });
    const { host, requestUpdate } = createHost(running);
    createBackgroundTasksProps(host);
    await flushAsync();

    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(100_000);
    handleBackgroundTasksEvent(host, {
      action: "upserted",
      task: makeTask({
        id: "retained-subagent",
        status: "cancelled",
        updatedAt: 100_000,
        endedAt: 100_000,
      }),
    });
    const props = createBackgroundTasksProps(host);
    expect(props.tasks?.[0]).toMatchObject({
      status: "cancelled",
      diffStat: { files: 2, added: 12, removed: 3 },
    });
    expect(props.tasks?.[0]).not.toHaveProperty("lastActivity");

    const container = document.createElement("div");
    document.body.append(container);
    const renderCurrent = () =>
      render(html`${renderBackgroundTasksStatusRow(createBackgroundTasksProps(host))}`, container);
    renderCurrent();
    expect(container.textContent).toContain("Subagent cancelled");
    expect(container.textContent).not.toContain("Editing the final report");
    expect(container.querySelector(".chat-diffstat__add")?.textContent).toBe("+12");
    expect(container.querySelector(".chat-diffstat__del")?.textContent).toBe("-3");

    requestUpdate.mockClear();
    vi.advanceTimersByTime(TERMINAL_RETENTION_MS - 1);
    renderCurrent();
    expect(container.querySelector(".chat-subagent-activity__row")).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(requestUpdate).toHaveBeenCalledOnce();
    renderCurrent();
    expect(container.querySelector(".chat-subagent-activity__row")).toBeNull();
  });
});
