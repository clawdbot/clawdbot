import { describe, expect, it } from "vitest";
import { EventHub, OpenClaw, normalizeGatewayEvent } from "./index.js";
import type {
  GatewayEvent,
  GatewayRequestOptions,
  OpenClawEvent,
  OpenClawTransport,
} from "./types.js";

type RequestCall = {
  method: string;
  params?: unknown;
  options?: GatewayRequestOptions;
};

type FakeResponseValue = null | boolean | number | string | Record<string, unknown> | unknown[];
type FakeResponseHandler = (
  params: unknown,
  options: GatewayRequestOptions | undefined,
  transport: FakeTransport,
) => Promise<FakeResponseValue> | FakeResponseValue;
type FakeResponse = FakeResponseValue | FakeResponseHandler;

class FakeTransport implements OpenClawTransport {
  readonly calls: RequestCall[] = [];
  private readonly eventHub = new EventHub<GatewayEvent>({ replayLimit: 100 });

  constructor(private readonly responses: Record<string, FakeResponse>) {}

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    this.calls.push({ method, params, options });
    const response = this.responses[method];
    if (typeof response === "function") {
      return (await response(params, options, this)) as T;
    }
    return response as T;
  }

  events(filter?: (event: GatewayEvent) => boolean): AsyncIterable<GatewayEvent> {
    return this.eventHub.stream(filter, { replay: true });
  }

  emit(event: GatewayEvent): void {
    this.eventHub.publish(event);
  }

  close(): void {
    this.eventHub.close();
  }
}

function requireTransportCall(calls: readonly RequestCall[], index: number): RequestCall {
  const call = calls[index];
  if (!call) {
    throw new Error(`Expected transport call ${index}`);
  }
  return call;
}

describe("OpenClaw SDK", () => {
  it("runs an agent through the Gateway agent method", async () => {
    const transport = new FakeTransport({
      agent: { status: "accepted", runId: "run_123" },
      "agent.wait": { status: "ok", runId: "run_123", sessionKey: "main" },
    });
    const oc = new OpenClaw({ transport });
    const agent = await oc.agents.get("main");

    const run = await agent.run({
      input: "ship it",
      model: "sonnet-4.6",
      sessionKey: "main",
      timeoutMs: 30_000,
      idempotencyKey: "idempotent-test",
    });
    const result = await run.wait({ timeoutMs: 500 });

    expect(run.id).toBe("run_123");
    expect(result.runId).toBe("run_123");
    expect(result.sessionKey).toBe("main");
    expect(result.status).toBe("completed");
    expect(transport.calls).toEqual([
      {
        method: "agent",
        options: { expectFinal: false, timeoutMs: 30_000 },
        params: {
          agentId: "main",
          idempotencyKey: "idempotent-test",
          message: "ship it",
          model: "sonnet-4.6",
          sessionKey: "main",
          timeout: 30,
        },
      },
      {
        method: "agent.wait",
        options: { timeoutMs: null },
        params: { runId: "run_123", timeoutMs: 500 },
      },
    ]);
  });

  it("preserves numeric wait timestamps", async () => {
    const transport = new FakeTransport({
      "agent.wait": { status: "ok", runId: "run_numeric", startedAt: 123, endedAt: 456 },
    });
    const oc = new OpenClaw({ transport });

    const result = await oc.runs.wait("run_numeric");

    expect(result.runId).toBe("run_numeric");
    expect(result.status).toBe("completed");
    expect(result.startedAt).toBe(123);
    expect(result.endedAt).toBe(456);
    expect(transport.calls).toEqual([
      {
        method: "agent.wait",
        params: { runId: "run_numeric" },
        options: { timeoutMs: null },
      },
    ]);
  });

  it("maps aborted wait snapshots to cancelled even when Gateway status is timeout", async () => {
    const transport = new FakeTransport({
      "agent.wait": {
        status: "timeout",
        runId: "run_cancelled",
        stopReason: "rpc",
        error: "aborted by operator",
      },
    });
    const oc = new OpenClaw({ transport });

    const result = await oc.runs.wait("run_cancelled");

    expect(result.runId).toBe("run_cancelled");
    expect(result.status).toBe("cancelled");
    expect(result.error?.message).toBe("aborted by operator");
  });

  it("keeps wait-only deadlines non-terminal", async () => {
    const transport = new FakeTransport({
      "agent.wait": { status: "timeout", runId: "run_still_active" },
    });
    const oc = new OpenClaw({ transport });

    const result = await oc.runs.wait("run_still_active");

    expect(result.runId).toBe("run_still_active");
    expect(result.status).toBe("accepted");
    expect(result.error).toBeUndefined();
  });

  it("maps terminal runtime timeout snapshots to timed_out", async () => {
    const transport = new FakeTransport({
      "agent.wait": {
        status: "timeout",
        runId: "run_timed_out",
        stopReason: "timeout",
        error: "agent runtime timeout",
      },
    });
    const oc = new OpenClaw({ transport });

    const result = await oc.runs.wait("run_timed_out");

    expect(result.runId).toBe("run_timed_out");
    expect(result.status).toBe("timed_out");
    expect(result.error?.message).toBe("agent runtime timeout");
  });

  it("maps terminal timeout snapshots without stop reasons to timed_out", async () => {
    const transport = new FakeTransport({
      "agent.wait": {
        status: "timeout",
        runId: "run_timed_out",
        startedAt: 123,
        endedAt: 456,
      },
    });
    const oc = new OpenClaw({ transport });

    const result = await oc.runs.wait("run_timed_out");

    expect(result.runId).toBe("run_timed_out");
    expect(result.status).toBe("timed_out");
    expect(result.startedAt).toBe(123);
    expect(result.endedAt).toBe(456);
    expect(result.error).toBeUndefined();
  });

  it("splits provider-qualified model refs and rejects unsupported run options", async () => {
    const transport = new FakeTransport({
      agent: { status: "accepted", runId: "run_openrouter" },
    });
    const oc = new OpenClaw({ transport });

    await oc.runs.create({
      input: "use a routed model",
      model: "openrouter/deepseek/deepseek-r1",
      idempotencyKey: "model-ref-test",
    });

    expect(requireTransportCall(transport.calls, 0)).toEqual({
      method: "agent",
      options: { expectFinal: false },
      params: {
        message: "use a routed model",
        provider: "openrouter",
        model: "deepseek/deepseek-r1",
        idempotencyKey: "model-ref-test",
      },
    });
    await expect(
      oc.runs.create({
        input: "unsupported",
        idempotencyKey: "unsupported-options-test",
        workspace: { cwd: "/tmp/project" },
        runtime: { type: "managed", provider: "testbox" },
        environment: { type: "local" },
        approvals: "ask",
      }),
    ).rejects.toThrow(
      "OpenClaw Gateway does not support per-run SDK options yet: workspace, runtime, environment, approvals",
    );
  });

  it("ceil-converts run timeoutMs to Gateway timeout seconds", async () => {
    const transport = new FakeTransport({
      agent: { status: "accepted", runId: "run_timeout" },
    });
    const oc = new OpenClaw({ transport });

    await oc.runs.create({
      input: "short run",
      timeoutMs: 1_500,
      idempotencyKey: "timeout-test",
    });

    expect(requireTransportCall(transport.calls, 0)).toEqual({
      method: "agent",
      options: { expectFinal: false, timeoutMs: 1_500 },
      params: {
        message: "short run",
        timeout: 2,
        idempotencyKey: "timeout-test",
      },
    });
    await expect(
      oc.runs.create({
        input: "bad timeout",
        timeoutMs: Number.NaN,
        idempotencyKey: "bad-timeout-test",
      }),
    ).rejects.toThrow("timeoutMs must be a finite non-negative number");
  });

  it("calls artifact Gateway RPCs", async () => {
    const transport = new FakeTransport({
      "artifacts.list": { artifacts: [{ id: "artifact_123", type: "image", title: "demo.png" }] },
      "artifacts.get": { artifact: { id: "artifact_123", type: "image", title: "demo.png" } },
      "artifacts.download": {
        artifact: { id: "artifact_123", type: "image", title: "demo.png" },
        encoding: "base64",
        data: "aGVsbG8=",
      },
    });
    const oc = new OpenClaw({ transport });

    const artifactList = await oc.artifacts.list({ sessionKey: "agent:main:main" });
    expect(artifactList.artifacts).toEqual([
      { id: "artifact_123", type: "image", title: "demo.png" },
    ]);
    const artifactGet = await oc.artifacts.get("artifact_123", { sessionKey: "agent:main:main" });
    expect(artifactGet.artifact).toEqual({ id: "artifact_123", type: "image", title: "demo.png" });
    const artifactDownload = await oc.artifacts.download("artifact_123", {
      sessionKey: "agent:main:main",
    });
    expect(artifactDownload.artifact).toEqual({
      id: "artifact_123",
      type: "image",
      title: "demo.png",
    });
    expect(artifactDownload.encoding).toBe("base64");
    expect(artifactDownload.data).toBe("aGVsbG8=");

    expect(transport.calls).toEqual([
      {
        method: "artifacts.list",
        options: undefined,
        params: { sessionKey: "agent:main:main" },
      },
      {
        method: "artifacts.get",
        options: undefined,
        params: { artifactId: "artifact_123", sessionKey: "agent:main:main" },
      },
      {
        method: "artifacts.download",
        options: undefined,
        params: { artifactId: "artifact_123", sessionKey: "agent:main:main" },
      },
    ]);
  });

  it("requires artifact query scope before calling Gateway", async () => {
    const transport = new FakeTransport({});
    const oc = new OpenClaw({ transport });

    await expect(oc.artifacts.list(undefined as never)).rejects.toThrow(
      "oc.artifacts.list requires one of sessionKey, runId, or taskId",
    );
    await expect(oc.artifacts.get("artifact_123", undefined as never)).rejects.toThrow(
      "oc.artifacts.get requires one of sessionKey, runId, or taskId",
    );
    await expect(oc.artifacts.download("artifact_123", undefined as never)).rejects.toThrow(
      "oc.artifacts.download requires one of sessionKey, runId, or taskId",
    );
    expect(transport.calls).toStrictEqual([]);
  });

  it("throws explicit unsupported errors for SDK namespaces without Gateway RPCs", async () => {
    const transport = new FakeTransport({});
    const oc = new OpenClaw({ transport });

    await expect(oc.environments.create({ provider: "testbox" })).rejects.toThrow(
      "oc.environments.create is not supported by the current OpenClaw Gateway yet",
    );
    await expect(oc.environments.delete("environment_123")).rejects.toThrow(
      "oc.environments.delete is not supported by the current OpenClaw Gateway yet",
    );
    expect(transport.calls).toStrictEqual([]);
  });

  it("invokes tools through the Gateway tools.invoke method", async () => {
    const transport = new FakeTransport({
      "tools.invoke": { ok: true, toolName: "demo", output: { value: 1 }, source: "core" },
    });
    const oc = new OpenClaw({ transport });

    const result = await oc.tools.invoke("demo", {
      args: { mode: "test" },
      sessionKey: "agent:main:main",
      confirm: false,
      idempotencyKey: "tools-invoke-test",
    });
    expect(result.ok).toBe(true);
    expect(result.toolName).toBe("demo");
    expect(result.output).toEqual({ value: 1 });
    expect(transport.calls).toEqual([
      {
        method: "tools.invoke",
        params: {
          name: "demo",
          args: { mode: "test" },
          sessionKey: "agent:main:main",
          confirm: false,
          idempotencyKey: "tools-invoke-test",
        },
        options: undefined,
      },
    ]);
  });

  it("calls task ledger Gateway methods", async () => {
    const transport = new FakeTransport({
      "tasks.list": {
        tasks: [
          {
            id: "task_123",
            status: "running",
            title: "Investigate issue",
            runId: "run_123",
            sessionKey: "agent:main:main",
          },
        ],
      },
      "tasks.get": {
        task: {
          id: "task_123",
          status: "running",
          title: "Investigate issue",
        },
      },
      "tasks.cancel": {
        found: true,
        cancelled: true,
        task: {
          id: "task_123",
          status: "cancelled",
        },
      },
    });
    const oc = new OpenClaw({ transport });

    const taskList = await oc.tasks.list({
      status: "running",
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    expect(taskList.tasks).toEqual([
      {
        id: "task_123",
        status: "running",
        title: "Investigate issue",
        runId: "run_123",
        sessionKey: "agent:main:main",
      },
    ]);
    const taskGet = await oc.tasks.get("task_123");
    expect(taskGet.task).toEqual({
      id: "task_123",
      status: "running",
      title: "Investigate issue",
    });
    const taskCancel = await oc.tasks.cancel("task_123", { reason: "user stopped task" });
    expect(taskCancel.found).toBe(true);
    expect(taskCancel.cancelled).toBe(true);
    expect(taskCancel.task).toEqual({ id: "task_123", status: "cancelled" });

    expect(transport.calls).toEqual([
      {
        method: "tasks.list",
        params: { status: "running", agentId: "main", sessionKey: "agent:main:main" },
        options: undefined,
      },
      {
        method: "tasks.get",
        params: { taskId: "task_123" },
        options: undefined,
      },
      {
        method: "tasks.cancel",
        params: { taskId: "task_123", reason: "user stopped task" },
        options: undefined,
      },
    ]);
  });

  it("lists and reads environment status through current Gateway methods", async () => {
    const gatewayEnvironment = {
      id: "gateway",
      type: "local",
      label: "Gateway local",
      status: "available",
      capabilities: ["agent.run"],
    };
    const transport = new FakeTransport({
      "environments.list": { environments: [gatewayEnvironment] },
      "environments.status": gatewayEnvironment,
    });
    const oc = new OpenClaw({ transport });

    await expect(oc.environments.list()).resolves.toEqual({
      environments: [gatewayEnvironment],
    });
    await expect(oc.environments.status("gateway")).resolves.toEqual(gatewayEnvironment);
    await expect(oc.environments.create({ provider: "testbox" })).rejects.toThrow(
      "oc.environments.create is not supported by the current OpenClaw Gateway yet",
    );
    await expect(oc.environments.delete("gateway")).rejects.toThrow(
      "oc.environments.delete is not supported by the current OpenClaw Gateway yet",
    );
    expect(transport.calls).toEqual([
      { method: "environments.list", params: {}, options: undefined },
      { method: "environments.status", params: { environmentId: "gateway" }, options: undefined },
    ]);
  });

  it("cancels runs and checks model auth status through current Gateway methods", async () => {
    const transport = new FakeTransport({
      agent: { status: "accepted", runId: "run_without_session" },
      "sessions.abort": { ok: true, status: "aborted", abortedRunId: "run_without_session" },
      "models.authStatus": { providers: [] },
    });
    const oc = new OpenClaw({ transport });

    const run = await oc.runs.create({
      input: "start",
      idempotencyKey: "cancel-test",
    });
    await run.cancel();
    await oc.models.status({ probe: false });

    expect(transport.calls.map((call) => call.method)).toEqual([
      "agent",
      "sessions.abort",
      "models.authStatus",
    ]);
    expect(requireTransportCall(transport.calls, 1).params).toEqual({
      runId: "run_without_session",
    });
    expect(requireTransportCall(transport.calls, 2).params).toEqual({ probe: false });
  });

  it("replays fast run events emitted before the caller starts iterating", async () => {
    const ts = 1_777_000_000_000;
    const transport = new FakeTransport({
      agent: (
        _params: unknown,
        _options: GatewayRequestOptions | undefined,
        fake: FakeTransport,
      ) => {
        fake.emit({
          event: "agent",
          seq: 1,
          payload: { runId: "run_fast", stream: "lifecycle", ts, data: { phase: "start" } },
        });
        fake.emit({
          event: "agent",
          seq: 2,
          payload: {
            runId: "run_fast",
            stream: "assistant",
            ts: ts + 1,
            data: { delta: "fast" },
          },
        });
        fake.emit({
          event: "agent",
          seq: 3,
          payload: {
            runId: "run_fast",
            stream: "lifecycle",
            ts: ts + 2,
            data: { phase: "end" },
          },
        });
        return { status: "accepted", runId: "run_fast", sessionKey: "fast" };
      },
    });
    const oc = new OpenClaw({ transport });

    const run = await oc.runs.create({
      input: "finish immediately",
      idempotencyKey: "fast-run-events",
      sessionKey: "fast",
    });
    const seen: string[] = [];

    for await (const event of run.events()) {
      seen.push(event.type);
      if (event.type === "run.completed") {
        break;
      }
    }

    expect(seen).toEqual(["run.started", "assistant.delta", "run.completed"]);
  });

  it("does not surface raw chat projection events in per-run streams", async () => {
    const ts = 1_777_000_000_100;
    const transport = new FakeTransport({
      agent: (
        _params: unknown,
        _options: GatewayRequestOptions | undefined,
        fake: FakeTransport,
      ) => {
        fake.emit({
          event: "agent",
          seq: 1,
          payload: {
            runId: "run_chat_projection",
            stream: "lifecycle",
            ts,
            data: { phase: "start" },
          },
        });
        fake.emit({
          event: "agent",
          seq: 2,
          payload: {
            runId: "run_chat_projection",
            stream: "assistant",
            ts: ts + 1,
            data: { delta: "hello" },
          },
        });
        fake.emit({
          event: "chat",
          seq: 3,
          payload: {
            runId: "run_chat_projection",
            sessionKey: "chat-projection",
            state: "delta",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hello" }],
              timestamp: ts + 2,
            },
          },
        });
        fake.emit({
          event: "agent",
          seq: 4,
          payload: {
            runId: "run_chat_projection",
            stream: "lifecycle",
            ts: ts + 3,
            data: { phase: "end" },
          },
        });
        fake.emit({
          event: "chat",
          seq: 5,
          payload: {
            runId: "run_chat_projection",
            sessionKey: "chat-projection",
            state: "final",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hello" }],
              timestamp: ts + 4,
            },
          },
        });
        return {
          status: "accepted",
          runId: "run_chat_projection",
          sessionKey: "chat-projection",
        };
      },
    });
    const oc = new OpenClaw({ transport });

    const run = await oc.runs.create({
      input: "stream with chat projection",
      idempotencyKey: "chat-projection-events",
      sessionKey: "chat-projection",
    });
    const seen: OpenClawEvent[] = [];

    for await (const event of run.events()) {
      seen.push(event);
      if (event.type === "run.completed") {
        break;
      }
    }

    expect(seen.map((event) => event.type)).toEqual([
      "run.started",
      "assistant.delta",
      "run.completed",
    ]);
    expect(seen.map((event) => event.raw?.event)).toEqual(["agent", "agent", "agent"]);
  });

  it("normalizes chat-only projection events in per-run streams", async () => {
    const ts = 1_777_000_000_200;
    const transport = new FakeTransport({
      agent: (
        _params: unknown,
        _options: GatewayRequestOptions | undefined,
        fake: FakeTransport,
      ) => {
        fake.emit({
          event: "chat",
          seq: 1,
          payload: {
            runId: "run_chat_only",
            sessionKey: "chat-only",
            state: "delta",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hello" }],
              timestamp: ts,
            },
          },
        });
        fake.emit({
          event: "chat",
          seq: 2,
          payload: {
            runId: "run_chat_only",
            sessionKey: "chat-only",
            state: "delta",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hello again" }],
              timestamp: ts + 1,
            },
          },
        });
        fake.emit({
          event: "chat",
          seq: 3,
          payload: {
            runId: "run_chat_only",
            sessionKey: "chat-only",
            state: "delta",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "reset" }],
              timestamp: ts + 2,
            },
          },
        });
        fake.emit({
          event: "chat",
          seq: 4,
          payload: {
            runId: "run_chat_only",
            sessionKey: "chat-only",
            state: "final",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "reset" }],
              timestamp: ts + 3,
            },
          },
        });
        fake.emit({
          event: "custom.debug",
          seq: 5,
          payload: {
            runId: "run_chat_only",
            ts: ts + 4,
            data: { ok: true },
          },
        });
        return { status: "accepted", runId: "run_chat_only", sessionKey: "chat-only" };
      },
    });
    const oc = new OpenClaw({ transport });

    const run = await oc.runs.create({
      input: "stream with chat-only projection",
      idempotencyKey: "chat-only-events",
      sessionKey: "chat-only",
    });
    const iterator = run.events()[Symbol.asyncIterator]();

    try {
      const first = await iterator.next();
      expect(first.done).toBe(false);
      if (first.done !== false) {
        throw new Error("expected first chat projection event");
      }
      expect(first.value.type).toBe("assistant.delta");
      expect(first.value.data).toEqual({ text: "hello", delta: "hello" });
      expect(first.value.raw?.event).toBe("chat");

      const second = await iterator.next();
      expect(second.done).toBe(false);
      if (second.done !== false) {
        throw new Error("expected second chat projection event");
      }
      expect(second.value.type).toBe("assistant.delta");
      expect(second.value.data).toEqual({ text: "hello again", delta: " again" });
      expect(second.value.raw?.event).toBe("chat");

      const third = await iterator.next();
      expect(third.done).toBe(false);
      if (third.done !== false) {
        throw new Error("expected replacement chat projection event");
      }
      expect(third.value.type).toBe("assistant.delta");
      expect(third.value.data).toEqual({ text: "reset", delta: "reset", replace: true });
      expect(third.value.raw?.event).toBe("chat");

      const fourth = await iterator.next();
      expect(fourth.done).toBe(false);
      if (fourth.done !== false) {
        throw new Error("expected chat projection completion event");
      }
      expect(fourth.value.type).toBe("run.completed");
      expect(fourth.value.data).toEqual({ phase: "end", outputText: "reset" });
      expect(fourth.value.raw?.event).toBe("chat");
    } finally {
      await iterator.return?.();
    }
  });

  it("creates a session and sends a message as a run", async () => {
    const transport = new FakeTransport({
      "sessions.create": { key: "session-main", label: "Main" },
      "sessions.send": { status: "accepted", runId: "run_session" },
    });
    const oc = new OpenClaw({ transport });

    const session = await oc.sessions.create({ key: "session-main" });
    const run = await session.send({ message: "continue", thinking: "medium" });

    expect(run.id).toBe("run_session");
    expect(transport.calls).toEqual([
      {
        method: "sessions.create",
        options: undefined,
        params: { key: "session-main" },
      },
      {
        method: "sessions.send",
        options: { expectFinal: true },
        params: { key: "session-main", message: "continue", thinking: "medium" },
      },
    ]);
  });

  it("normalizes Gateway agent stream events into SDK events", () => {
    const ts = 1_777_000_000_000;

    const started = normalizeGatewayEvent({
      event: "agent",
      seq: 1,
      payload: { runId: "run_1", stream: "lifecycle", ts, data: { phase: "start" } },
    });
    expect(started.type).toBe("run.started");
    expect(started.runId).toBe("run_1");
    expect(started.data).toEqual({ phase: "start" });

    const assistant = normalizeGatewayEvent({
      event: "agent",
      seq: 2,
      payload: { runId: "run_1", stream: "assistant", ts, data: { delta: "hello" } },
    });
    expect(assistant.type).toBe("assistant.delta");
    expect(assistant.runId).toBe("run_1");
    expect(assistant.data).toEqual({ delta: "hello" });

    const completed = normalizeGatewayEvent({
      event: "agent",
      seq: 3,
      payload: { runId: "run_1", stream: "lifecycle", ts, data: { phase: "end" } },
    });
    expect(completed.type).toBe("run.completed");
    expect(completed.runId).toBe("run_1");
    expect(completed.data).toEqual({ phase: "end" });

    const aborted = normalizeGatewayEvent({
      event: "agent",
      seq: 4,
      payload: {
        runId: "run_1",
        stream: "lifecycle",
        ts,
        data: { phase: "end", aborted: true },
      },
    });
    expect(aborted.type).toBe("run.timed_out");
    expect(aborted.runId).toBe("run_1");
    expect(aborted.data).toEqual({ phase: "end", aborted: true });

    const cancelled = normalizeGatewayEvent({
      event: "agent",
      seq: 5,
      payload: {
        runId: "run_1",
        stream: "lifecycle",
        ts,
        data: { phase: "end", aborted: true, stopReason: "rpc" },
      },
    });
    expect(cancelled.type).toBe("run.cancelled");
    expect(cancelled.runId).toBe("run_1");
    expect(cancelled.data).toEqual({ phase: "end", aborted: true, stopReason: "rpc" });

    const timedOut = normalizeGatewayEvent({
      event: "agent",
      seq: 6,
      payload: {
        runId: "run_1",
        stream: "lifecycle",
        ts,
        data: { phase: "end", stopReason: "timeout" },
      },
    });
    expect(timedOut.type).toBe("run.timed_out");
    expect(timedOut.runId).toBe("run_1");
    expect(timedOut.data).toEqual({ phase: "end", stopReason: "timeout" });
  });
});
