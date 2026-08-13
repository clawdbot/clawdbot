import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import {
  observeTaskDetailEvent,
  readTaskTranscript,
  type TaskDetailHost,
} from "./chat-task-detail-state.ts";

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

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("task detail transcript state", () => {
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
      limit: 100,
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
