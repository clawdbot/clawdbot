import { describe, expect, it, vi } from "vitest";
import type {
  WorkerHelloOk,
  WorkerLiveEvent,
  WorkerTranscriptMessage,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerInferenceEventFrame,
  WorkerInferenceStartParams,
  WorkerInferenceTerminalFrame,
  WorkerInferenceTerminalOutcome,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { WorkerConnection, WorkerConnectionState } from "./worker-connection.js";
import {
  WorkerConnectionInterruptedError,
  WorkerConnectionStoppedError,
  WorkerFencedError,
} from "./worker-connection.js";
import {
  WorkerInferenceProxyClient,
  WorkerLiveEventClient,
  WorkerTranscriptCommitClient,
} from "./worker-rpc-clients.js";

const HELLO: WorkerHelloOk = {
  type: "worker-hello-ok",
  environmentId: "environment-1",
  sessionId: "session-1",
  ownerEpoch: 3,
  rpcSetVersion: 1,
  protocolFeatures: ["worker-heartbeat-v1"],
  credentialExpiresAtMs: 10_000,
  policy: { heartbeatIntervalMs: 15_000, maxPayload: 65_536 },
};

function connectionHarness() {
  let state: WorkerConnectionState = { kind: "ready", hello: HELLO };
  const readyListeners = new Set<Parameters<WorkerConnection["onReady"]>[0]>();
  const stateListeners = new Set<Parameters<WorkerConnection["onStateChange"]>[0]>();
  const inferenceEventListeners = new Set<Parameters<WorkerConnection["onInferenceEvent"]>[0]>();
  const inferenceTerminalListeners = new Set<
    Parameters<WorkerConnection["onInferenceTerminal"]>[0]
  >();
  const waitForReady = vi.fn<WorkerConnection["waitForReady"]>(async () => HELLO);
  const requestTranscriptCommit = vi.fn<WorkerConnection["requestTranscriptCommit"]>();
  const requestLiveEvent = vi.fn<WorkerConnection["requestLiveEvent"]>();
  const requestInferenceStart = vi.fn<WorkerConnection["requestInferenceStart"]>();
  const requestInferenceCancel = vi.fn<WorkerConnection["requestInferenceCancel"]>();
  const connection = {
    get state() {
      return state;
    },
    waitForReady,
    requestTranscriptCommit,
    requestLiveEvent,
    requestInferenceStart,
    requestInferenceCancel,
    onReady: (listener: Parameters<WorkerConnection["onReady"]>[0]) => {
      readyListeners.add(listener);
      return () => {
        readyListeners.delete(listener);
      };
    },
    onStateChange: (listener: Parameters<WorkerConnection["onStateChange"]>[0]) => {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    onInferenceEvent: (listener: Parameters<WorkerConnection["onInferenceEvent"]>[0]) => {
      inferenceEventListeners.add(listener);
      return () => {
        inferenceEventListeners.delete(listener);
      };
    },
    onInferenceTerminal: (listener: Parameters<WorkerConnection["onInferenceTerminal"]>[0]) => {
      inferenceTerminalListeners.add(listener);
      return () => {
        inferenceTerminalListeners.delete(listener);
      };
    },
  } as unknown as WorkerConnection;
  return {
    connection,
    waitForReady,
    requestTranscriptCommit,
    requestLiveEvent,
    requestInferenceStart,
    requestInferenceCancel,
    emitReady: () => {
      for (const listener of readyListeners) {
        listener(HELLO);
      }
    },
    emitState: (nextState: WorkerConnectionState) => {
      state = nextState;
      for (const listener of stateListeners) {
        listener(nextState);
      }
    },
    emitInferenceEvent: (frame: WorkerInferenceEventFrame) => {
      for (const listener of inferenceEventListeners) {
        listener(frame);
      }
    },
    emitInferenceTerminal: (frame: WorkerInferenceTerminalFrame) => {
      for (const listener of inferenceTerminalListeners) {
        listener(frame);
      }
    },
  };
}

function userMessage(text: string): WorkerTranscriptMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1,
  };
}

const LIVE_EVENT: WorkerLiveEvent = {
  kind: "assistant",
  payload: { text: "local result", delta: "local result" },
};

const INFERENCE_IDENTITY = {
  runEpoch: 3,
  sessionId: "session-1",
  runId: "run-1",
  turnId: "turn-1",
};

const INFERENCE_REQUEST: WorkerInferenceStartParams = {
  ...INFERENCE_IDENTITY,
  modelRef: { provider: "provider-1", model: "model-1" },
  context: { messages: [] },
  options: {},
};

function doneOutcome(): WorkerInferenceTerminalOutcome {
  return {
    type: "done",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "openai-responses",
      provider: "provider-1",
      model: "model-1",
      stopReason: "stop",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 2,
    },
  };
}

describe("worker transcript commit client", () => {
  it("retries the exact semantic batch after an interrupted response", async () => {
    const harness = connectionHarness();
    harness.requestTranscriptCommit
      .mockRejectedValueOnce(new WorkerConnectionInterruptedError())
      .mockResolvedValueOnce({
        type: "res",
        id: "commit-response",
        ok: true,
        payload: { entryIds: ["entry-1"], newLeafId: "leaf-2" },
      });
    const client = new WorkerTranscriptCommitClient(harness.connection, {
      runEpoch: 3,
      baseLeafId: "leaf-1",
      initialSeq: 8,
    });

    const message = userMessage("hello");
    const commit = client.commit([message]);
    const text = message.content[0];
    if (text?.type === "text") {
      text.text = "caller mutation";
    }

    await expect(commit).resolves.toEqual({
      entryIds: ["entry-1"],
      newLeafId: "leaf-2",
    });

    expect(harness.requestTranscriptCommit).toHaveBeenCalledTimes(2);
    expect(harness.requestTranscriptCommit.mock.calls[1]?.[0]).toBe(
      harness.requestTranscriptCommit.mock.calls[0]?.[0],
    );
    expect(harness.requestTranscriptCommit.mock.calls[0]?.[0]).toEqual({
      runEpoch: 3,
      seq: 8,
      baseLeafId: "leaf-1",
      messages: [userMessage("hello")],
    });
    expect(client.baseLeafId).toBe("leaf-2");
    expect(client.nextSeq).toBe(9);
  });

  it("fail-stops on a stale base without retrying the rejected batch", async () => {
    const harness = connectionHarness();
    harness.requestTranscriptCommit.mockResolvedValueOnce({
      type: "res",
      id: "commit-response",
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Transcript base changed",
        details: { reason: "stale-base-leaf" },
      },
    });
    const client = new WorkerTranscriptCommitClient(harness.connection, {
      runEpoch: 3,
      baseLeafId: "leaf-4",
      initialSeq: 11,
    });

    const error: unknown = await client.commit([userMessage("hello")]).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "WorkerTranscriptCommitError",
      message:
        "Worker transcript base changed; uncommitted messages were not committed; relaunch required.",
      reason: "stale-base-leaf",
    });
    expect(client.baseLeafId).toBe("leaf-4");
    expect(client.nextSeq).toBe(12);

    const blocked: unknown = await client.commit([userMessage("blocked")]).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(blocked).toBe(error);
    expect(harness.requestTranscriptCommit).toHaveBeenCalledOnce();

    expect(client.nextSeq).toBe(12);
    expect(harness.requestTranscriptCommit).toHaveBeenCalledOnce();
  });

  it("splits semantic batches at the gateway frame byte ceiling", async () => {
    const harness = connectionHarness();
    harness.requestTranscriptCommit
      .mockResolvedValueOnce({
        type: "res",
        id: "commit-response-1",
        ok: true,
        payload: { entryIds: ["entry-1"], newLeafId: "leaf-1" },
      })
      .mockResolvedValueOnce({
        type: "res",
        id: "commit-response-2",
        ok: true,
        payload: { entryIds: ["entry-2"], newLeafId: "leaf-2" },
      });
    const client = new WorkerTranscriptCommitClient(harness.connection, {
      runEpoch: 3,
      baseLeafId: null,
    });
    const messages = [userMessage("a".repeat(40_000)), userMessage("b".repeat(40_000))];

    await expect(client.commit(messages)).resolves.toEqual({
      entryIds: ["entry-1", "entry-2"],
      newLeafId: "leaf-2",
    });

    expect(harness.requestTranscriptCommit).toHaveBeenCalledTimes(2);
    expect(harness.requestTranscriptCommit.mock.calls[0]?.[0]).toMatchObject({
      seq: 1,
      baseLeafId: null,
      messages: [messages[0]],
    });
    expect(harness.requestTranscriptCommit.mock.calls[1]?.[0]).toMatchObject({
      seq: 2,
      baseLeafId: "leaf-1",
      messages: [messages[1]],
    });
  });
});

describe("worker live-event client", () => {
  it("advances acknowledgements through the buffered tail", async () => {
    const harness = connectionHarness();
    harness.requestLiveEvent
      .mockResolvedValueOnce({
        type: "res",
        id: "live-response-1",
        ok: true,
        payload: { ackedSeq: 1 },
      })
      .mockResolvedValueOnce({
        type: "res",
        id: "live-response-2",
        ok: true,
        payload: { ackedSeq: 2 },
      });
    const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3 });

    const first = client.emit("run-1", LIVE_EVENT);
    const second = client.emit("run-1", {
      kind: "assistant",
      payload: { text: "second", delta: "second" },
    });

    await expect(Promise.all([first, second])).resolves.toEqual([{ ackedSeq: 1 }, { ackedSeq: 2 }]);
    expect(harness.requestLiveEvent).toHaveBeenCalledTimes(2);
    expect(client.ackedSeq).toBe(2);
    expect(client.unackedCount).toBe(0);
    client.dispose();
  });

  it("replays immutable sequence and payload after a resync response", async () => {
    const harness = connectionHarness();
    harness.requestLiveEvent
      .mockResolvedValueOnce({
        type: "res",
        id: "live-response-1",
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "Replay required",
          details: { reason: "resync-required", ackedSeq: 0, expectedSeq: 1 },
        },
      })
      .mockResolvedValueOnce({
        type: "res",
        id: "live-response-2",
        ok: true,
        payload: { ackedSeq: 1 },
      });
    const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3 });

    const event = {
      kind: "assistant" as const,
      payload: { text: "local result", delta: "local result" },
    };
    const emitted = client.emit("run-1", event);
    event.payload.text = "caller mutation";

    await expect(emitted).resolves.toEqual({ ackedSeq: 1 });

    expect(harness.requestLiveEvent).toHaveBeenCalledTimes(2);
    const first = harness.requestLiveEvent.mock.calls[0]?.[0];
    const replay = harness.requestLiveEvent.mock.calls[1]?.[0];
    expect(replay).toEqual(first);
    expect(replay?.event).not.toBe(event);
    expect(replay?.event).toEqual(LIVE_EVENT);
    expect(replay).toMatchObject({ seq: 1, lastAckedSeq: 0 });
    client.dispose();
  });

  it("renumbers the unacked tail when the gateway resets behind the local cursor", async () => {
    const harness = connectionHarness();
    harness.requestLiveEvent
      .mockResolvedValueOnce({
        type: "res",
        id: "live-response-reset",
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "Replay required",
          details: { reason: "resync-required", ackedSeq: 0, expectedSeq: 1 },
        },
      })
      .mockResolvedValueOnce({
        type: "res",
        id: "live-response-1",
        ok: true,
        payload: { ackedSeq: 1 },
      })
      .mockResolvedValueOnce({
        type: "res",
        id: "live-response-2",
        ok: true,
        payload: { ackedSeq: 2 },
      });
    const client = new WorkerLiveEventClient(harness.connection, {
      runEpoch: 3,
      initialAckedSeq: 5,
    });

    const first = client.emit("run-1", LIVE_EVENT);
    const secondEvent: WorkerLiveEvent = {
      kind: "assistant",
      payload: { text: "second", delta: "second" },
    };
    const second = client.emit("run-1", secondEvent);

    await expect(Promise.all([first, second])).resolves.toEqual([{ ackedSeq: 1 }, { ackedSeq: 2 }]);
    expect(harness.requestLiveEvent.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ seq: 6, lastAckedSeq: 5, event: LIVE_EVENT }),
      expect.objectContaining({ seq: 1, lastAckedSeq: 0, event: LIVE_EVENT }),
      expect.objectContaining({ seq: 2, lastAckedSeq: 1, event: secondEvent }),
    ]);
    expect(client.ackedSeq).toBe(2);
    expect(client.unackedCount).toBe(0);
    client.dispose();
  });

  it("rejects a repeated no-progress resync instead of retrying forever", async () => {
    const harness = connectionHarness();
    const resyncResponse = {
      type: "res" as const,
      id: "live-response-reset",
      ok: false as const,
      error: {
        code: "INVALID_REQUEST" as const,
        message: "Replay required",
        details: { reason: "resync-required" as const, ackedSeq: 0, expectedSeq: 1 },
      },
    };
    harness.requestLiveEvent
      .mockResolvedValueOnce(resyncResponse)
      .mockResolvedValueOnce(resyncResponse)
      .mockRejectedValueOnce(new Error("unexpected third replay"));
    const client = new WorkerLiveEventClient(harness.connection, {
      runEpoch: 3,
      initialAckedSeq: 5,
    });

    await expect(client.emit("run-1", LIVE_EVENT)).rejects.toThrow(
      "worker live-event resync did not advance",
    );
    expect(harness.requestLiveEvent).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it("rejects an event emitted after stop without rescheduling", async () => {
    const harness = connectionHarness();
    harness.waitForReady.mockRejectedValue(new WorkerConnectionStoppedError());
    harness.emitState({ kind: "stopped" });
    const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3 });

    await expect(client.emit("run-1", LIVE_EVENT)).rejects.toBeInstanceOf(
      WorkerConnectionStoppedError,
    );
    expect(harness.waitForReady).toHaveBeenCalledOnce();
    expect(harness.requestLiveEvent).not.toHaveBeenCalled();
    client.dispose();
  });

  it("rejects buffered events when the worker is fenced", async () => {
    const harness = connectionHarness();
    harness.requestLiveEvent.mockImplementationOnce(async () => await new Promise<never>(() => {}));
    const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3 });

    const emitted = client.emit("run-1", LIVE_EVENT);
    await vi.waitFor(() => expect(harness.requestLiveEvent).toHaveBeenCalledOnce());
    harness.emitState({ kind: "fenced", reason: "owner-epoch-mismatch" });

    await expect(emitted).rejects.toEqual(new WorkerFencedError("owner-epoch-mismatch"));
    client.dispose();
  });
});

describe("worker inference proxy client", () => {
  it("reports stream gaps but accepts later events and the terminal outcome", async () => {
    const harness = connectionHarness();
    harness.requestInferenceStart.mockResolvedValueOnce({
      type: "res",
      id: "inference-response",
      ok: true,
      payload: { status: "accepted" },
    });
    const client = new WorkerInferenceProxyClient(harness.connection);
    const onEvent = vi.fn();
    const onStreamGap = vi.fn();
    const terminal = doneOutcome();

    const request = {
      ...structuredClone(INFERENCE_REQUEST),
      modelRef: { ...INFERENCE_REQUEST.modelRef },
    };
    const outcome = client.start(request, { onEvent, onStreamGap });
    request.modelRef.model = "caller-mutation";
    await vi.waitFor(() => expect(harness.requestInferenceStart).toHaveBeenCalledOnce());
    expect(harness.requestInferenceStart.mock.calls[0]?.[0]).toEqual(INFERENCE_REQUEST);
    harness.emitInferenceEvent({
      type: "event",
      event: "worker.inference.event",
      payload: {
        ...INFERENCE_IDENTITY,
        seq: 1,
        event: { type: "text_start", contentIndex: 0 },
      },
    });
    harness.emitInferenceEvent({
      type: "event",
      event: "worker.inference.event",
      payload: {
        ...INFERENCE_IDENTITY,
        seq: 3,
        event: { type: "text_delta", contentIndex: 0, delta: "continued" },
      },
    });
    harness.emitInferenceTerminal({
      type: "event",
      event: "worker.inference.terminal",
      payload: { ...INFERENCE_IDENTITY, seq: 4, outcome: terminal },
    });

    await expect(outcome).resolves.toEqual(terminal);
    expect(onStreamGap).toHaveBeenCalledOnce();
    expect(onStreamGap).toHaveBeenCalledWith({ expectedSeq: 2, receivedSeq: 3 });
    expect(onEvent).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it("reattaches an active turn and consumes its replayed terminal", async () => {
    const harness = connectionHarness();
    const terminal = doneOutcome();
    harness.requestInferenceStart
      .mockResolvedValueOnce({
        type: "res",
        id: "inference-response-1",
        ok: true,
        payload: { status: "accepted" },
      })
      .mockImplementationOnce(async (_params, beforeResolve) => {
        const response = {
          type: "res",
          id: "inference-response-2",
          ok: true,
          payload: { status: "replayed" },
        } as const;
        beforeResolve?.(response);
        harness.emitInferenceTerminal({
          type: "event",
          event: "worker.inference.terminal",
          payload: { ...INFERENCE_IDENTITY, seq: 1, outcome: terminal },
        });
        return response;
      });
    const client = new WorkerInferenceProxyClient(harness.connection);
    const onStreamGap = vi.fn();

    const outcome = client.start(INFERENCE_REQUEST, { onStreamGap });
    await vi.waitFor(() => expect(harness.requestInferenceStart).toHaveBeenCalledOnce());
    harness.emitInferenceEvent({
      type: "event",
      event: "worker.inference.event",
      payload: {
        ...INFERENCE_IDENTITY,
        seq: 1,
        event: { type: "text_start", contentIndex: 0 },
      },
    });
    harness.emitReady();
    await vi.waitFor(() => expect(harness.requestInferenceStart).toHaveBeenCalledTimes(2));

    await expect(outcome).resolves.toEqual(terminal);
    expect(harness.requestInferenceStart.mock.calls[1]?.[0]).toEqual(
      harness.requestInferenceStart.mock.calls[0]?.[0],
    );
    expect(onStreamGap).not.toHaveBeenCalled();
    client.dispose();
  });
});
