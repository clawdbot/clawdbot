// Task follow command tests cover replay, JSONL, bounds, reconnect dedupe, and viewer-only abort.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";

const mocks = vi.hoisted(() => ({
  clientOptions: undefined as Record<string, unknown> | undefined,
  historyMessages: [] as unknown[],
  task: undefined as Record<string, unknown> | undefined,
  request: vi.fn(),
  stop: vi.fn(),
  stopAndWait: vi.fn(async () => {}),
  reconcileTaskLookupToken: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
}));

vi.mock("../gateway/client-bootstrap.js", () => ({
  resolveGatewayClientBootstrap: vi.fn(async () => ({
    url: "ws://127.0.0.1:18789",
    urlSource: "test",
    connectionDetails: { url: "ws://127.0.0.1:18789" },
    auth: { token: "test-token" },
  })),
}));

vi.mock("../gateway/client.js", () => ({
  GatewayClient: class {
    constructor(options: Record<string, unknown>) {
      mocks.clientOptions = options;
    }

    request(method: string, params?: unknown) {
      return mocks.request(method, params);
    }

    stop() {
      mocks.stop();
    }

    stopAndWait() {
      return mocks.stopAndWait();
    }
  },
}));

vi.mock("../gateway/client-start-readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: vi.fn(async () => {
    queueMicrotask(() => {
      const onHelloOk = mocks.clientOptions?.onHelloOk;
      if (typeof onHelloOk === "function") {
        onHelloOk({});
      }
    });
    return { ready: true, aborted: false };
  }),
}));

vi.mock("../tasks/task-registry.reconcile.js", () => ({
  reconcileTaskLookupToken: mocks.reconcileTaskLookupToken,
}));

import { tasksFollowCommand } from "./tasks-follow.js";

function taskRecord(): TaskRecord {
  return {
    taskId: "task-1",
    runtime: "subagent",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    childSessionKey: "agent:main:subagent:child",
    task: "Do bounded work",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt: 1,
  };
}

function taskSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    taskId: "task-1",
    runtime: "subagent",
    kind: "subagent",
    status: "running",
    deliveryStatus: "pending",
    childSessionKey: "agent:main:subagent:child",
    agentId: "main",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function createRuntime() {
  return {
    log: vi.fn<RuntimeEnv["log"]>(),
    error: vi.fn<RuntimeEnv["error"]>(),
    exit: vi.fn<RuntimeEnv["exit"]>(),
  };
}

function emitGatewayEvent(event: Record<string, unknown>) {
  const onEvent = mocks.clientOptions?.onEvent;
  if (typeof onEvent !== "function") {
    throw new Error("missing mocked Gateway event handler");
  }
  onEvent(event);
}

function jsonEvents(runtime: ReturnType<typeof createRuntime>) {
  return runtime.log.mock.calls.map(
    ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
  );
}

beforeEach(() => {
  mocks.clientOptions = undefined;
  mocks.historyMessages = [];
  mocks.task = taskSummary();
  mocks.request.mockReset();
  mocks.stop.mockReset();
  mocks.stopAndWait.mockClear();
  mocks.reconcileTaskLookupToken.mockReset();
  mocks.reconcileTaskLookupToken.mockReturnValue(taskRecord());
  mocks.request.mockImplementation(async (method: string) => {
    if (method === "tasks.get") {
      return { task: mocks.task };
    }
    if (method === "chat.history") {
      return { messages: mocks.historyMessages };
    }
    throw new Error(`unexpected method: ${method}`);
  });
});

describe("tasksFollowCommand", () => {
  it("emits bounded JSON Lines replay and stops on final execution and delivery", async () => {
    const runtime = createRuntime();
    mocks.task = taskSummary({
      status: "completed",
      deliveryStatus: "delivered",
      terminalOutcome: "succeeded",
      updatedAt: 5,
    });
    mocks.historyMessages = [
      {
        role: "user",
        content: "u".repeat(2_000),
        __openclaw: { seq: 1, recordTimestampMs: 3 },
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden reasoning" },
          { type: "text", text: `visible result Authorization: Bearer ${"s".repeat(32)}` },
        ],
        __openclaw: { seq: 2, recordTimestampMs: 4 },
      },
      { role: "toolResult", content: "unbounded tool result", __openclaw: { seq: 3 } },
    ];

    await tasksFollowCommand({ lookup: "task-1", json: true }, runtime);

    const events = jsonEvents(runtime);
    expect(events.map((event) => event.kind)).toEqual([
      "task.snapshot",
      "session.message",
      "session.message",
    ]);
    expect(events.every((event) => typeof event.id === "string" && event.id === event.cursor)).toBe(
      true,
    );
    const firstMessage = events.find((event) => event.kind === "session.message");
    if (!firstMessage) {
      throw new Error("missing replayed session message");
    }
    expect((firstMessage.state as { text: string }).text).toHaveLength(1_000);
    expect(JSON.stringify(events)).not.toContain("hidden reasoning");
    expect(JSON.stringify(events)).not.toContain("unbounded tool result");
    expect(JSON.stringify(events)).not.toContain("s".repeat(32));
    expect(mocks.clientOptions?.scopes).toEqual(["operator.read"]);
    expect(mocks.stopAndWait).toHaveBeenCalledOnce();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("keeps live updates ordered and deduplicates replay across reconnect and gaps", async () => {
    const runtime = createRuntime();
    const follow = tasksFollowCommand({ lookup: "task-1", json: true }, runtime);
    await vi.waitFor(() => expect(runtime.log).toHaveBeenCalled());

    const runningUpdate = taskSummary({
      updatedAt: 10,
      lastToolName: "exec",
      lastActivity: "running checks",
    });
    emitGatewayEvent({
      event: "task",
      seq: 10,
      payload: { action: "upserted", task: runningUpdate },
    });
    emitGatewayEvent({
      event: "task",
      seq: 11,
      payload: { action: "upserted", task: runningUpdate },
    });
    await vi.waitFor(() =>
      expect(jsonEvents(runtime).some((event) => event.gatewaySeq === 10)).toBe(true),
    );

    mocks.task = runningUpdate;
    const onGap = mocks.clientOptions?.onGap;
    if (typeof onGap !== "function") {
      throw new Error("missing mocked Gateway gap handler");
    }
    onGap({ expected: 12, received: 14 });

    const onClose = mocks.clientOptions?.onClose;
    const onHelloOk = mocks.clientOptions?.onHelloOk;
    if (typeof onClose !== "function" || typeof onHelloOk !== "function") {
      throw new Error("missing mocked Gateway reconnect handlers");
    }
    onClose(1006, "restart");
    onClose(1006, "restart");
    onHelloOk({});

    const finalTask = taskSummary({
      status: "completed",
      deliveryStatus: "delivered",
      terminalOutcome: "succeeded",
      updatedAt: 20,
      terminalSummary: "done",
    });
    emitGatewayEvent({
      event: "task",
      seq: 15,
      payload: { action: "upserted", task: finalTask },
    });
    await follow;

    const events = jsonEvents(runtime);
    const runningIds = events
      .filter(
        (event) => (event.state as { lastActivity?: string }).lastActivity === "running checks",
      )
      .map((event) => event.id);
    expect(new Set(runningIds).size).toBe(1);
    expect(events.some((event) => event.kind === "connection.gap")).toBe(true);
    expect(events.filter((event) => event.kind === "connection.disconnected")).toHaveLength(1);
    expect(events.some((event) => event.kind === "connection.reconnected")).toBe(true);
    const finalEvent = events.at(-1);
    if (!finalEvent) {
      throw new Error("missing terminal task event");
    }
    expect(finalEvent.kind).toBe("task.update");
    expect((finalEvent.state as { deliveryStatus: string }).deliveryStatus).toBe("delivered");
  });

  it("waits for completion delivery after execution reaches a terminal state", async () => {
    const runtime = createRuntime();
    mocks.task = taskSummary({
      status: "completed",
      deliveryStatus: "session_queued",
      terminalOutcome: "succeeded",
      updatedAt: 30,
    });

    let settled = false;
    const follow = tasksFollowCommand({ lookup: "task-1", json: true }, runtime).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(runtime.log).toHaveBeenCalled());
    await Promise.resolve();
    expect(settled).toBe(false);

    emitGatewayEvent({
      event: "task",
      seq: 31,
      payload: {
        action: "upserted",
        task: taskSummary({
          status: "completed",
          deliveryStatus: "delivered",
          terminalOutcome: "succeeded",
          updatedAt: 31,
        }),
      },
    });
    await follow;

    expect(settled).toBe(true);
    expect(
      jsonEvents(runtime).map(
        (event) => (event.state as { deliveryStatus?: string }).deliveryStatus,
      ),
    ).toEqual(["session_queued", "delivered"]);
  });

  it("Ctrl-C stops only the viewer and never sends a task mutation", async () => {
    const runtime = createRuntime();
    let sigint: (() => void) | undefined;
    const once = vi.spyOn(process, "once").mockImplementation((event, listener) => {
      if (event === "SIGINT") {
        sigint = listener as () => void;
      }
      return process;
    });
    const remove = vi.spyOn(process, "removeListener").mockImplementation(() => process);

    const follow = tasksFollowCommand({ lookup: "task-1" }, runtime);
    await vi.waitFor(() => expect(runtime.log).toHaveBeenCalled());
    expect(runtime.log.mock.calls[0]?.[0]).toEqual(expect.stringContaining("[task.snapshot]"));
    if (!sigint) {
      throw new Error("missing SIGINT listener");
    }
    sigint();
    await follow;

    expect(mocks.request.mock.calls.map(([method]) => method)).toEqual([
      "tasks.get",
      "chat.history",
    ]);
    expect(runtime.exit).not.toHaveBeenCalled();
    once.mockRestore();
    remove.mockRestore();
  });

  it("rejects an unknown lookup before opening a Gateway client", async () => {
    const runtime = createRuntime();
    mocks.reconcileTaskLookupToken.mockReturnValue(undefined);

    await tasksFollowCommand({ lookup: "missing" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("missing"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.clientOptions).toBeUndefined();
  });
});
