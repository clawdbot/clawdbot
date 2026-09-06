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
import { createDeferred } from "../../test/helpers/promise.js";
import { WorkerConnectionStoppedError, WorkerFencedError } from "./worker-connection-contract.js";
import type { WorkerConnection, WorkerConnectionState } from "./worker-connection.js";
import { WorkerConnectionInterruptedError } from "./worker-connection.js";
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
  const terminalErrorListeners = new Set<Parameters<WorkerConnection["onTerminalError"]>[0]>();
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
    onTerminalError: (listener: Parameters<WorkerConnection["onTerminalError"]>[0]) => {
      terminalErrorListeners.add(listener);
      return () => {
        terminalErrorListeners.delete(listener);
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
    emitTerminalError: (nextState: WorkerConnectionState, error: Error) => {
      state = nextState;
      for (const listener of terminalErrorListeners) {
        listener(error);
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

const TERMINAL_EVENT: WorkerLiveEvent = {
  kind: "lifecycle",
  payload: { phase: "finishing", startedAt: 1, endedAt: 2 },
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

  it("commits a terminal assistant message with replay near the frame ceiling", async () => {
    const harness = connectionHarness();
    harness.requestTranscriptCommit.mockResolvedValueOnce({
      type: "res",
      id: "commit-response",
      ok: true,
      payload: { entryIds: ["entry-1"], newLeafId: "leaf-1" },
    });
    const client = new WorkerTranscriptCommitClient(harness.connection, {
      runEpoch: 3,
      baseLeafId: null,
    });
    const message: WorkerTranscriptMessage = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.6-sol",
      providerReplay: {
        v: 1,
        type: "openai-responses-compaction",
        data: "x".repeat(60 * 1024),
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.6-sol",
      },
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    };

    await expect(client.commit([message])).resolves.toEqual({
      entryIds: ["entry-1"],
      newLeafId: "leaf-1",
    });
    expect(harness.requestTranscriptCommit).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [message] }),
    );
  });
});

describe("worker live-event client", () => {
  it("advances acknowledgements through previews to the terminal barrier", async () => {
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
      })
      .mockResolvedValueOnce({
        type: "res",
        id: "live-response-3",
        ok: true,
        payload: { ackedSeq: 3 },
      });
    const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3 });

    client.enqueuePreview("run-1", LIVE_EVENT);
    client.enqueuePreview("run-1", {
      kind: "assistant",
      payload: { text: "second", delta: "second" },
    });

    await expect(client.emitTerminal("run-1", TERMINAL_EVENT)).resolves.toBeUndefined();
    expect(harness.requestLiveEvent).toHaveBeenCalledTimes(3);
    client.dispose();
  });

  it("accepts out-of-order cumulative ACKs while a no-progress response has peers in flight", async () => {
    const harness = connectionHarness();
    const firstResponse =
      createDeferred<Awaited<ReturnType<WorkerConnection["requestLiveEvent"]>>>();
    const secondResponse =
      createDeferred<Awaited<ReturnType<WorkerConnection["requestLiveEvent"]>>>();
    const terminalResponse =
      createDeferred<Awaited<ReturnType<WorkerConnection["requestLiveEvent"]>>>();
    harness.requestLiveEvent.mockImplementation(async (request) => {
      return await (request.seq === 1
        ? firstResponse.promise
        : request.seq === 2
          ? secondResponse.promise
          : terminalResponse.promise);
    });
    const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3 });

    client.enqueuePreview("run-1", LIVE_EVENT);
    client.enqueuePreview("run-1", {
      kind: "thinking",
      payload: { text: "second", delta: "second" },
    });
    const terminal = client.emitTerminal("run-1", TERMINAL_EVENT);
    await vi.waitFor(() => expect(harness.requestLiveEvent).toHaveBeenCalledTimes(3));
    secondResponse.resolve({
      type: "res",
      id: "live-response-2",
      ok: true,
      payload: { ackedSeq: 0 },
    });
    await Promise.resolve();
    expect(harness.requestLiveEvent).toHaveBeenCalledTimes(3);
    firstResponse.resolve({
      type: "res",
      id: "live-response-1",
      ok: true,
      payload: { ackedSeq: 2 },
    });
    terminalResponse.resolve({
      type: "res",
      id: "live-response-3",
      ok: true,
      payload: { ackedSeq: 3 },
    });

    await expect(terminal).resolves.toBeUndefined();
    client.dispose();
  });

  it("recovers finishing after a concurrent preview rejection wins the response race", async () => {
    const harness = connectionHarness();
    const previewResponse =
      createDeferred<Awaited<ReturnType<WorkerConnection["requestLiveEvent"]>>>();
    const firstTerminalResponse =
      createDeferred<Awaited<ReturnType<WorkerConnection["requestLiveEvent"]>>>();
    harness.requestLiveEvent
      .mockImplementationOnce(async () => await previewResponse.promise)
      .mockImplementationOnce(async () => await firstTerminalResponse.promise)
      .mockImplementationOnce(async (request) =>
        request.lastAckedSeq > 0
          ? {
              type: "res",
              id: "live-response-resync",
              ok: false,
              error: {
                code: "INVALID_REQUEST",
                message: "Replay required",
                details: { reason: "resync-required", ackedSeq: 0, expectedSeq: 1 },
              },
            }
          : {
              type: "res",
              id: "live-response-gap",
              ok: true,
              payload: { ackedSeq: 0 },
            },
      )
      .mockResolvedValueOnce({
        type: "res",
        id: "live-response-finishing",
        ok: true,
        payload: { ackedSeq: 1 },
      });
    const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3 });

    client.enqueuePreview("run-1", LIVE_EVENT);
    const finishing = client.emitTerminal("run-1", TERMINAL_EVENT);
    await vi.waitFor(() => expect(harness.requestLiveEvent).toHaveBeenCalledTimes(2));
    previewResponse.resolve({
      type: "res",
      id: "live-response-preview",
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Preview rejected",
        details: { reason: "invalid-event" },
      },
    });
    firstTerminalResponse.resolve({
      type: "res",
      id: "live-response-stale-finishing",
      ok: true,
      payload: { ackedSeq: 0 },
    });

    await expect(finishing).resolves.toBeUndefined();
    expect(harness.requestLiveEvent.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ seq: 1, lastAckedSeq: 0, event: LIVE_EVENT }),
      expect.objectContaining({ seq: 2, lastAckedSeq: 0 }),
      expect.objectContaining({ seq: 2, lastAckedSeq: 2 }),
      expect.objectContaining({ seq: 1, lastAckedSeq: 0 }),
    ]);
    client.dispose();
  });

  it("recovers finishing emitted after an earlier preview rejection", async () => {
    const harness = connectionHarness();
    const previewResponse =
      createDeferred<Awaited<ReturnType<WorkerConnection["requestLiveEvent"]>>>();
    harness.requestLiveEvent
      .mockImplementationOnce(async () => await previewResponse.promise)
      .mockImplementationOnce(async (request) =>
        request.lastAckedSeq > 0
          ? {
              type: "res",
              id: "live-response-resync",
              ok: false,
              error: {
                code: "INVALID_REQUEST",
                message: "Replay required",
                details: { reason: "resync-required", ackedSeq: 0, expectedSeq: 1 },
              },
            }
          : {
              type: "res",
              id: "live-response-gap",
              ok: true,
              payload: { ackedSeq: 0 },
            },
      )
      .mockResolvedValueOnce({
        type: "res",
        id: "live-response-finishing",
        ok: true,
        payload: { ackedSeq: 1 },
      });
    const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3 });

    client.enqueuePreview("run-1", LIVE_EVENT);
    previewResponse.resolve({
      type: "res",
      id: "live-response-preview",
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Preview rejected",
        details: { reason: "invalid-event" },
      },
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(harness.requestLiveEvent).toHaveBeenCalledOnce();
    client.enqueuePreview("run-1", {
      kind: "assistant",
      payload: { text: "dropped", delta: "dropped" },
    });
    expect(harness.requestLiveEvent).toHaveBeenCalledOnce();

    await expect(client.emitTerminal("run-1", TERMINAL_EVENT)).resolves.toBeUndefined();

    expect(harness.requestLiveEvent.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ seq: 1, lastAckedSeq: 0, event: LIVE_EVENT }),
      expect.objectContaining({ seq: 2, lastAckedSeq: 1 }),
      expect.objectContaining({ seq: 1, lastAckedSeq: 0 }),
    ]);
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
      })
      .mockResolvedValueOnce({
        type: "res",
        id: "live-response-terminal",
        ok: true,
        payload: { ackedSeq: 2 },
      });
    const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3 });

    const event = {
      kind: "assistant" as const,
      payload: { text: "local result", delta: "local result" },
    };
    client.enqueuePreview("run-1", event);
    event.payload.text = "caller mutation";
    await vi.waitFor(() => expect(harness.requestLiveEvent).toHaveBeenCalledTimes(2));
    await expect(client.emitTerminal("run-1", TERMINAL_EVENT)).resolves.toBeUndefined();

    expect(harness.requestLiveEvent).toHaveBeenCalledTimes(3);
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
    let responseIndex = 0;
    harness.requestLiveEvent.mockImplementation(async () => {
      responseIndex += 1;
      if (responseIndex === 1) {
        return {
          type: "res",
          id: "live-response-reset",
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Replay required",
            details: { reason: "resync-required", ackedSeq: 0, expectedSeq: 1 },
          },
        };
      }
      const ackedSeq = responseIndex === 2 ? 0 : responseIndex - 2;
      return {
        type: "res",
        id: `live-response-${responseIndex}`,
        ok: true,
        payload: { ackedSeq },
      };
    });
    const client = new WorkerLiveEventClient(harness.connection, {
      runEpoch: 3,
      initialAckedSeq: 5,
    });

    client.enqueuePreview("run-1", LIVE_EVENT);
    const secondEvent: WorkerLiveEvent = {
      kind: "assistant",
      payload: { text: "second", delta: "second" },
    };
    client.enqueuePreview("run-1", secondEvent);
    await vi.waitFor(() => expect(harness.requestLiveEvent).toHaveBeenCalledTimes(4));

    await expect(client.emitTerminal("run-1", TERMINAL_EVENT)).resolves.toBeUndefined();
    expect(harness.requestLiveEvent.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ seq: 6, lastAckedSeq: 5, event: LIVE_EVENT }),
      expect.objectContaining({ seq: 7, lastAckedSeq: 5, event: secondEvent }),
      expect.objectContaining({ seq: 1, lastAckedSeq: 0, event: LIVE_EVENT }),
      expect.objectContaining({ seq: 2, lastAckedSeq: 0, event: secondEvent }),
      expect.objectContaining({ seq: 3, lastAckedSeq: 2, event: TERMINAL_EVENT }),
    ]);
    client.dispose();
  });

  it("recovers terminal delivery after a repeated no-progress preview resync", async () => {
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
      .mockImplementationOnce(async (request) =>
        request.lastAckedSeq > 0
          ? resyncResponse
          : {
              type: "res",
              id: "live-response-gap",
              ok: true,
              payload: { ackedSeq: 0 },
            },
      )
      .mockResolvedValueOnce({
        type: "res",
        id: "live-response-finishing",
        ok: true,
        payload: { ackedSeq: 1 },
      });
    const client = new WorkerLiveEventClient(harness.connection, {
      runEpoch: 3,
      initialAckedSeq: 5,
    });

    client.enqueuePreview("run-1", LIVE_EVENT);
    await vi.waitFor(() => expect(harness.requestLiveEvent).toHaveBeenCalledTimes(2));
    await expect(client.emitTerminal("run-1", TERMINAL_EVENT)).resolves.toBeUndefined();
    expect(harness.requestLiveEvent).toHaveBeenCalledTimes(4);
    client.dispose();
  });

  it("rejects terminal delivery when a preview receives an inconsistent resync cursor", async () => {
    const harness = connectionHarness();
    const previewResponse =
      createDeferred<Awaited<ReturnType<WorkerConnection["requestLiveEvent"]>>>();
    const terminalResponse =
      createDeferred<Awaited<ReturnType<WorkerConnection["requestLiveEvent"]>>>();
    harness.requestLiveEvent.mockImplementation(async (request) =>
      request.event.kind === "lifecycle" ? terminalResponse.promise : previewResponse.promise,
    );
    const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3 });

    client.enqueuePreview("run-1", LIVE_EVENT);
    const terminal = client.emitTerminal("run-1", TERMINAL_EVENT);
    await vi.waitFor(() => expect(harness.requestLiveEvent).toHaveBeenCalledTimes(2));
    previewResponse.resolve({
      type: "res",
      id: "live-response-inconsistent-resync",
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Replay required",
        details: { reason: "resync-required", ackedSeq: 0, expectedSeq: 2 },
      },
    });

    await expect(terminal).rejects.toThrow("worker live-event resync cursor is inconsistent");
    terminalResponse.resolve({
      type: "res",
      id: "live-response-terminal",
      ok: true,
      payload: { ackedSeq: 2 },
    });
    client.dispose();
  });

  it("drops previews and rejects terminal delivery after stop without rescheduling", async () => {
    const harness = connectionHarness();
    harness.waitForReady.mockRejectedValue(new WorkerConnectionStoppedError());
    harness.emitTerminalError({ kind: "stopped" }, new WorkerConnectionStoppedError());
    const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3 });

    client.enqueuePreview("run-1", LIVE_EVENT);
    await expect(client.emitTerminal("run-1", TERMINAL_EVENT)).rejects.toBeInstanceOf(
      WorkerConnectionStoppedError,
    );
    expect(harness.waitForReady).toHaveBeenCalledOnce();
    expect(harness.requestLiveEvent).not.toHaveBeenCalled();
    client.dispose();
  });

  it("rejects the terminal barrier when the worker is fenced", async () => {
    const harness = connectionHarness();
    harness.requestLiveEvent.mockImplementation(async () => await new Promise<never>(() => {}));
    const client = new WorkerLiveEventClient(harness.connection, { runEpoch: 3 });

    client.enqueuePreview("run-1", LIVE_EVENT);
    const terminal = client.emitTerminal("run-1", TERMINAL_EVENT);
    await vi.waitFor(() => expect(harness.requestLiveEvent).toHaveBeenCalledTimes(2));
    harness.emitTerminalError(
      { kind: "fenced", reason: "owner-epoch-mismatch" },
      new WorkerFencedError("owner-epoch-mismatch"),
    );

    await expect(terminal).rejects.toEqual(new WorkerFencedError("owner-epoch-mismatch"));
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
