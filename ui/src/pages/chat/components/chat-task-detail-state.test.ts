import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import type { ChatPageHost } from "../chat-state-host.ts";
import type { ChatProps } from "../chat-view.ts";
import { closeSlot, openSlot, type SidebarLayout } from "../sidebar-layout.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import { renderChatDetailSlot } from "./chat-detail-slot.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import * as taskDetailState from "./chat-task-detail-state.ts";
import {
  observeTaskDetailEvent,
  readTaskTranscript,
  type TaskDetailHost,
} from "./chat-task-detail-state.ts";
import type { ChatTranscriptController } from "./chat-transcript-controller.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function history(text: string) {
  return {
    messages: [{ role: "assistant", content: [{ type: "text", text }] }],
    sessionId: "child-session",
    thinkingLevel: null,
  };
}

function hostWith(request: ReturnType<typeof vi.fn>): TaskDetailHost {
  return {
    sessionKey: "agent:main:main",
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
    connectionEpoch: 4,
    requestUpdate: vi.fn(),
  };
}

function task(status: TaskSummary["status"]): TaskSummary {
  return {
    id: "task-1",
    taskId: "task-1",
    status,
    runtime: "subagent",
    agentId: "main",
    sessionKey: "agent:main:main",
    childSessionKey: "agent:main:subagent:child",
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

function backgroundTasks(selectedTask: TaskSummary): BackgroundTasksProps {
  return {
    sessionKey: "agent:main:main",
    statusRowId: "chat-tasks-status-test",
    collapsed: false,
    narrowLayout: false,
    connected: true,
    canCancel: false,
    loading: false,
    error: null,
    tasks: [selectedTask],
    activeCount: selectedTask.status === "queued" || selectedTask.status === "running" ? 1 : 0,
    subagentActivity: {
      rows: [],
      overflowWorking: 0,
      taskIds: new Set(),
      nextExpiryAt: null,
    },
    taskDetails: new Map(),
    taskDetailErrors: new Map(),
    taskDetailLoadingIds: new Set(),
    cancellingTaskIds: new Set(),
    finishedCollapsed: false,
    onToggleCollapsed: () => undefined,
    onToggleFinished: () => undefined,
    onRefresh: () => undefined,
    onCancel: () => undefined,
  };
}

const taskContent = { kind: "task", taskId: "task-1" } satisfies SidebarContent;
const fileContent = {
  kind: "file",
  path: "notes.txt",
  name: "notes.txt",
  content: "Non-task detail",
} satisfies SidebarContent;

function renderDetail(host: TaskDetailHost, content: SidebarContent, layout: SidebarLayout) {
  renderChatDetailSlot({
    backgroundTasks: backgroundTasks(task("running")),
    chat: { paneId: "pane-1" } as ChatProps,
    content,
    host: host as ChatPageHost,
    layout,
    transcript: {} as ChatTranscriptController,
  });
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("task detail transcript state", () => {
  it("clears transcript state when the detail slot closes", () => {
    const pending = deferred<never>();
    const host = hostWith(vi.fn().mockReturnValue(pending.promise));
    const openDetailLayout = openSlot({ columns: [] }, "detail");

    renderDetail(host, taskContent, openDetailLayout);
    expect(host.taskDetailState).toBeDefined();

    renderDetail(host, taskContent, closeSlot(openDetailLayout, "detail"));
    expect(host.taskDetailState).toBeUndefined();
  });

  it("does not reset transcript state during stable task or non-task renders", () => {
    const pending = deferred<never>();
    const request = vi.fn().mockReturnValue(pending.promise);
    const host = hostWith(request);
    const openDetailLayout = openSlot({ columns: [] }, "detail");
    const reset = vi.spyOn(taskDetailState, "resetTaskDetail");

    renderDetail(host, taskContent, openDetailLayout);
    const openTaskState = host.taskDetailState;
    renderDetail(host, taskContent, openDetailLayout);

    expect(host.taskDetailState).toBe(openTaskState);
    expect(request).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();

    renderDetail(host, fileContent, openDetailLayout);
    expect(host.taskDetailState).toBeUndefined();
    expect(reset).toHaveBeenCalledOnce();

    renderDetail(host, fileContent, openDetailLayout);
    expect(reset).toHaveBeenCalledOnce();
  });

  it("loads the selected child transcript", async () => {
    const pending = deferred<ReturnType<typeof history>>();
    const request = vi.fn().mockReturnValue(pending.promise);
    const host = hostWith(request);

    expect(
      readTaskTranscript(host, {
        taskId: "task-1",
        sessionKey: "agent:main:subagent:child",
      }),
    ).toEqual({ status: "loading" });
    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "agent:main:subagent:child",
      limit: 800,
    });

    pending.resolve(history("Child transcript loaded."));
    await flushAsync();
    expect(
      readTaskTranscript(host, {
        taskId: "task-1",
        sessionKey: "agent:main:subagent:child",
      }),
    ).toMatchObject({
      status: "loaded",
      messages: [{ role: "assistant" }],
    });
  });

  it("surfaces a history request failure", async () => {
    const pending = deferred<never>();
    const host = hostWith(vi.fn().mockReturnValue(pending.promise));
    readTaskTranscript(host, {
      taskId: "task-1",
      sessionKey: "agent:main:subagent:child",
    });

    pending.reject(new Error("history unavailable"));
    await flushAsync();
    expect(
      readTaskTranscript(host, {
        taskId: "task-1",
        sessionKey: "agent:main:subagent:child",
      }),
    ).toEqual({ status: "error" });
  });

  it("coalesces in-flight events and performs the terminal refresh after the throttle", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(10_000);
    const first = deferred<ReturnType<typeof history>>();
    const final = deferred<ReturnType<typeof history>>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(final.promise);
    const host = hostWith(request);
    readTaskTranscript(host, {
      taskId: "task-1",
      sessionKey: "agent:main:subagent:child",
    });

    observeTaskDetailEvent(host, { action: "upserted", task: task("running") });
    observeTaskDetailEvent(host, { action: "upserted", task: task("completed") });
    expect(request).toHaveBeenCalledTimes(1);

    first.resolve(history("Still running."));
    await flushAsync();
    vi.advanceTimersByTime(1_999);
    expect(request).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(request).toHaveBeenCalledTimes(2);

    final.resolve(history("Final child response."));
    await flushAsync();
    expect(
      readTaskTranscript(host, {
        taskId: "task-1",
        sessionKey: "agent:main:subagent:child",
      }),
    ).toMatchObject({ status: "loaded" });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
