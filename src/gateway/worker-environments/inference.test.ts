import { describe, expect, it, vi } from "vitest";
import type {
  WorkerInferenceStartParams,
  WorkerInferenceTerminalFrame,
  WorkerInferenceTerminalOutcome,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred } from "../../shared/deferred.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerInferenceStore } from "./inference-store.js";
import {
  createWorkerInferenceManager,
  type WorkerInferenceExecutor,
  type WorkerInferenceSink,
} from "./inference.js";

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

const REQUEST: WorkerInferenceStartParams = {
  runEpoch: 3,
  sessionId: "s",
  runId: "r",
  turnId: "t",
  modelRef: { provider: "p", model: "m" },
  context: { messages: [] },
  options: {},
};
const IDENTITY: WorkerConnectionIdentity = {
  environmentId: "w",
  credentialHash: "d",
  bundleHash: "b",
  sessionId: REQUEST.sessionId,
  runId: REQUEST.runId,
  ownerEpoch: REQUEST.runEpoch,
  rpcSetVersion: 1,
  protocolFeatures: ["worker-inference-v1"],
  credentialExpiresAtMs: 10_000,
};
const ERROR: WorkerInferenceTerminalOutcome = {
  type: "error",
  reason: "provider-error",
  message: "Provider request failed",
};
const DONE: WorkerInferenceTerminalOutcome = {
  type: "done",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "openai-responses",
    provider: REQUEST.modelRef.provider,
    model: REQUEST.modelRef.model,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  },
};
const CANCEL = {
  runEpoch: REQUEST.runEpoch,
  sessionId: REQUEST.sessionId,
  runId: REQUEST.runId,
  turnId: REQUEST.turnId,
};

type Manager = ReturnType<typeof createWorkerInferenceManager>;
type StartOverrides = {
  identity?: WorkerConnectionIdentity;
  request?: WorkerInferenceStartParams;
  sink?: WorkerInferenceSink;
  revalidate?: () => "epoch-mismatch" | null;
};

function createMemoryStore(): WorkerInferenceStore {
  return {
    begin: () => ({ kind: "claimed" }),
    complete: (input) => input.outcome,
    cancelPending() {},
    recoverPending() {},
  };
}

function createSink(connectionId = "c") {
  const frames: Parameters<WorkerInferenceSink["send"]>[0][] = [];
  const sink: WorkerInferenceSink = { connectionId, send: (frame) => frames.push(frame) };
  return { frames, sink };
}

function terminalFrames(frames: Parameters<WorkerInferenceSink["send"]>[0][]) {
  return frames.filter(
    (frame): frame is WorkerInferenceTerminalFrame => frame.event === "worker.inference.terminal",
  );
}

function accept(manager: Manager, overrides: StartOverrides = {}, launch = true) {
  const result = manager.start({
    identity: IDENTITY,
    request: REQUEST,
    sink: createSink().sink,
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(`start failed: ${result.reason}`);
  }
  if (launch) {
    result.launch();
  }
  return result;
}

function makeManager(execute: WorkerInferenceExecutor, store = createMemoryStore()) {
  return createWorkerInferenceManager({ execute, store, now: () => 0 });
}

describe("worker inference manager", () => {
  it("rejects oversized and concurrent turns", async () => {
    const store = createMemoryStore();
    const execute = vi.fn<WorkerInferenceExecutor>(async () => ERROR);
    const limited = createWorkerInferenceManager({ execute, store, requestMaxBytes: 32 });
    expect(
      limited.start({ identity: IDENTITY, request: REQUEST, sink: createSink().sink }),
    ).toEqual({
      ok: false,
      reason: "invalid-context",
    });
    const pending = createDeferred<WorkerInferenceTerminalOutcome>();
    const instance = makeManager(({ signal }) => {
      signal.addEventListener("abort", () => pending.resolve(ERROR), { once: true });
      return pending.promise;
    });
    const sink = createSink();
    accept(instance, { sink: sink.sink });
    expect(
      instance.start({
        identity: IDENTITY,
        request: { ...REQUEST, runId: "run-b", turnId: "turn-b" },
        sink: createSink().sink,
      }),
    ).toEqual({ ok: false, reason: "invalid-context" });
    await instance.stop();
    expect(terminalFrames(sink.frames)[0]?.payload.outcome).toMatchObject({
      reason: "provider-error",
    });
  });

  it("cancels the provider idempotently", async () => {
    const store = createMemoryStore();
    const signals: AbortSignal[] = [];
    const pending = [
      createDeferred<WorkerInferenceTerminalOutcome>(),
      createDeferred<WorkerInferenceTerminalOutcome>(),
    ];
    const instance = makeManager(({ signal }) => {
      signals.push(signal);
      const execution = pending[signals.length - 1];
      if (!execution) {
        throw new Error("unexpected inference execution");
      }
      signal.addEventListener("abort", () => execution.resolve(ERROR), { once: true });
      return execution.promise;
    }, store);
    const sink = createSink();
    accept(instance, { sink: sink.sink });
    await waitForFast(() => expect(signals).toHaveLength(1));
    for (let index = 0; index < 2; index += 1) {
      expect(instance.cancel({ identity: IDENTITY, request: CANCEL })).toEqual({
        ok: true,
        result: { status: "cancelled" },
      });
    }
    expect(signals[0]?.aborted).toBe(true);
    accept(instance, { request: { ...REQUEST, runId: "new-run", turnId: "new-turn" } });
    await waitForFast(() => expect(signals).toHaveLength(2));
    expect(instance.cancelSession(REQUEST.sessionId, "new-run")).toEqual(["new-run"]);
    expect(signals[1]?.aborted).toBe(true);
    await instance.stop();
  });

  it("settles cumulatively oversized output while preserving the abort reason", async () => {
    let signal: AbortSignal | undefined;
    const store = createMemoryStore();
    vi.spyOn(store, "begin")
      .mockReturnValueOnce({ kind: "claimed" })
      .mockReturnValueOnce({ kind: "claimed" })
      .mockReturnValueOnce({ kind: "replay", outcome: ERROR });
    const pending = createDeferred<WorkerInferenceTerminalOutcome>();
    const instance = createWorkerInferenceManager({
      execute: ({ emit, signal: nextSignal }) => {
        signal = nextSignal;
        const delta = "x".repeat(512);
        for (let index = 0; index < 5; index += 1) {
          emit({ type: "text_delta", contentIndex: 0, delta });
        }
        return pending.promise;
      },
      store,
      now: () => 0,
      streamMaxBytes: 2_048,
    });
    const sink = createSink();
    accept(instance, { sink: sink.sink });
    await waitForFast(() => expect(signal?.aborted).toBe(true));
    await waitForFast(() =>
      expect(terminalFrames(sink.frames)[0]?.payload.outcome).toMatchObject({
        reason: "provider-error",
      }),
    );
    accept(instance, { request: { ...REQUEST, runId: "retry-run", turnId: "retry-turn" } });
    const replay = createSink("replay");
    expect(accept(instance, { sink: replay.sink }).result.status).toBe("replayed");
    expect(terminalFrames(replay.frames)[0]?.payload.outcome).toEqual(ERROR);
    pending.resolve(ERROR);
    await instance.stop();
  });

  it("does not send an unpersisted terminal", async () => {
    const store = createMemoryStore();
    vi.spyOn(store, "complete").mockImplementationOnce(() => {
      throw new Error("write failed");
    });
    const sink = createSink();
    const instance = makeManager(async () => ERROR, store);
    accept(instance, { sink: sink.sink });
    await waitForFast(() => expect(store.complete).toHaveBeenCalledOnce());
    expect(terminalFrames(sink.frames)).toEqual([]);
    await instance.stop();
  });

  it("rebinds an active stream on reconnect without a second provider call", async () => {
    const release = createDeferred();
    const execute = vi.fn<WorkerInferenceExecutor>(async ({ emit }) => {
      emit({ type: "text_delta", contentIndex: 0, delta: "first" });
      await release.promise;
      emit({ type: "text_delta", contentIndex: 0, delta: "second" });
      return ERROR;
    });
    const instance = makeManager(execute);
    const first = createSink("first");
    accept(instance, { sink: first.sink });
    await waitForFast(() => expect(first.frames).toHaveLength(1));

    const second = createSink("second");
    expect(accept(instance, { sink: second.sink }).result.status).toBe("accepted");
    release.resolve();

    await waitForFast(() => expect(terminalFrames(second.frames)).toHaveLength(1));
    expect(execute).toHaveBeenCalledOnce();
    expect(terminalFrames(first.frames)).toEqual([]);
    expect(second.frames[0]).toMatchObject({
      event: "worker.inference.event",
      payload: { seq: 2, event: { type: "text_delta", delta: "second" } },
    });
    await instance.stop();
  });

  it("fences an epoch flip between acceptance and the terminal outcome", async () => {
    let current = true;
    let signal: AbortSignal | undefined;
    const pending = createDeferred<WorkerInferenceTerminalOutcome>();
    const execute = vi.fn<WorkerInferenceExecutor>(({ signal: nextSignal }) => {
      signal = nextSignal;
      return pending.promise;
    });
    const instance = makeManager(execute);
    const sink = createSink("epoch-flip");
    const accepted = accept(
      instance,
      { sink: sink.sink, revalidate: () => (current ? null : "epoch-mismatch") },
      false,
    );
    accepted.launch();
    await waitForFast(() => expect(execute).toHaveBeenCalledOnce());

    current = false;
    pending.resolve(DONE);

    await waitForFast(() => expect(terminalFrames(sink.frames)).toHaveLength(1));
    expect(terminalFrames(sink.frames)[0]?.payload.outcome).toMatchObject({
      reason: "epoch-mismatch",
    });
    expect(signal?.aborted).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    await instance.stop();
  });

  it("fences wrong session, epoch, and revalidation failures", async () => {
    const execute = vi.fn<WorkerInferenceExecutor>(async () => ERROR);
    const instance = makeManager(execute);
    for (const [identity, reason] of [
      [{ ...IDENTITY, sessionId: "other" }, "session-not-attached"],
      [{ ...IDENTITY, ownerEpoch: REQUEST.runEpoch + 1 }, "epoch-mismatch"],
    ] as const) {
      expect(instance.start({ identity, request: REQUEST, sink: createSink().sink })).toEqual({
        ok: false,
        reason,
      });
    }
    expect(execute).not.toHaveBeenCalled();

    let firstCheck = true;
    const sink = createSink("broken-fence");
    const broken = makeManager(async () => ERROR);
    accept(broken, {
      sink: sink.sink,
      revalidate: () => {
        if (firstCheck) {
          firstCheck = false;
          return null;
        }
        throw new Error("revalidation failed");
      },
    });
    await waitForFast(() => expect(terminalFrames(sink.frames)).toHaveLength(1));
    expect(terminalFrames(sink.frames)[0]?.payload.outcome).toMatchObject({
      reason: "provider-error",
    });
    await broken.stop();
  });
});
