import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  type WorkerConnectParams,
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerInferenceEventFrame,
  WorkerInferenceTerminalFrame,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { toWorkerConnectionError } from "./worker-connection-contract.js";
import { WorkerConnectionEndpointError } from "./worker-connection-endpoint.js";
import { WorkerConnectionFrameDispatcher } from "./worker-connection-frames.js";
import { createWorkerConnection, type WorkerConnectionState } from "./worker-connection.js";

const FRAME_CONNECT_PARAMS: WorkerConnectParams = {
  minProtocol: 1,
  maxProtocol: 1,
  client: {
    id: GATEWAY_CLIENT_IDS.WORKER,
    version: "listener-isolation-test",
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.WORKER,
  },
  role: "worker",
  admission: {
    environmentId: "listener-isolation-test",
    credential: "listener-isolation-credential",
    ownerEpoch: 1,
    rpcSetVersion: WORKER_RPC_SET_VERSION,
    handshake: {
      bundleHash: "a".repeat(64),
      openclawVersion: "listener-isolation-test",
      protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
    },
    sessionId: "session-1",
    runId: "run-1",
  },
};

function createIdleConnection() {
  return createWorkerConnection({
    endpoint: { kind: "unix", socketPath: "/tmp/worker-listener-isolation.sock" },
    connectParams: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: GATEWAY_CLIENT_IDS.WORKER,
        version: "listener-isolation-test",
        platform: process.platform,
        mode: GATEWAY_CLIENT_MODES.WORKER,
      },
      role: "worker",
      admission: {
        environmentId: "listener-isolation-test",
        credential: "listener-isolation-credential",
        ownerEpoch: 1,
        rpcSetVersion: WORKER_RPC_SET_VERSION,
        handshake: {
          bundleHash: "a".repeat(64),
          openclawVersion: "listener-isolation-test",
          protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
        },
        sessionId: null,
        runId: null,
      },
    },
  });
}

function createFrameDispatcher() {
  return new WorkerConnectionFrameDispatcher({
    connectParams: () => FRAME_CONNECT_PARAMS,
    requestTimeoutMs: 1_000,
    isReady: () => false,
    socket: () => undefined,
    isTerminal: () => false,
    terminalError: () => new Error("not terminal"),
    interruptReadySocket: () => undefined,
  });
}

function inferenceEventFrame(seq: number): WorkerInferenceEventFrame {
  return {
    type: "event",
    event: "worker.inference.event",
    payload: {
      runEpoch: 1,
      sessionId: "session-1",
      runId: "run-1",
      turnId: "turn-1",
      seq,
      event: { type: "text_delta", contentIndex: 0, delta: `chunk-${seq}` },
    },
  };
}

function inferenceTerminalFrame(seq: number): WorkerInferenceTerminalFrame {
  return {
    type: "event",
    event: "worker.inference.terminal",
    payload: {
      runEpoch: 1,
      sessionId: "session-1",
      runId: "run-1",
      turnId: "turn-1",
      seq,
      outcome: {
        type: "error",
        reason: "provider-error",
        message: `failure-${seq}`,
      },
    },
  };
}

function installThrowingThenHealthyListeners(connection: ReturnType<typeof createIdleConnection>) {
  let throwingCalls = 0;
  const observed: WorkerConnectionState["kind"][] = [];
  connection.onStateChange(() => {
    throwingCalls += 1;
    throw new Error("induced observer failure");
  });
  connection.onStateChange((state) => {
    observed.push(state.kind);
  });
  return { observed, throwingCalls: () => throwingCalls };
}

describe("worker connection endpoint failures", () => {
  it("fails insecure public endpoints without entering reconnect backoff", async () => {
    const createSocket = vi.fn();
    const connection = createWorkerConnection({
      endpoint: {
        kind: "websocket",
        url: "ws://gateway.example/__openclaw__/worker",
      },
      connectParams: FRAME_CONNECT_PARAMS,
      createSocket,
      admissionDeadlineMs: 60_000,
      reconnectBackoff: { initialMs: 30_000, maxMs: 30_000, factor: 1, jitter: 0 },
    });

    await expect(connection.start()).rejects.toBeInstanceOf(WorkerConnectionEndpointError);
    expect(connection.state).toMatchObject({ kind: "failed" });
    expect(createSocket).not.toHaveBeenCalled();
  });
});

describe("worker connection error coercion", () => {
  it("preserves structured non-Error causes", () => {
    const cause = { code: "ECONNRESET", status: 503 };

    const error = toWorkerConnectionError(cause);

    expect(error.message).toBe("[object Object]");
    expect(error.cause).toBe(cause);
    expect(error).toMatchObject(cause);
  });
});

describe("WorkerConnection state listener isolation", () => {
  it("settles stop and reaches later listeners when an earlier listener throws", async () => {
    const connection = createIdleConnection();
    const listeners = installThrowingThenHealthyListeners(connection);
    const exit = connection.waitForExit();

    await expect(connection.stop()).resolves.toBeUndefined();
    await expect(exit).resolves.toEqual({ kind: "stopped" });
    await expect(connection.stop()).resolves.toBeUndefined();

    expect(connection.state).toEqual({ kind: "stopped" });
    expect(listeners.throwingCalls()).toBe(1);
    expect(listeners.observed).toEqual(["stopped"]);
  });

  it("settles fencing and reaches later listeners when an earlier listener throws", async () => {
    const connection = createIdleConnection();
    const listeners = installThrowingThenHealthyListeners(connection);

    expect(() => connection.fence("owner-epoch-mismatch")).not.toThrow();
    await expect(connection.waitForExit()).resolves.toEqual({
      kind: "fenced",
      reason: "owner-epoch-mismatch",
    });

    expect(connection.state).toEqual({ kind: "fenced", reason: "owner-epoch-mismatch" });
    expect(listeners.throwingCalls()).toBe(1);
    expect(listeners.observed).toEqual(["fenced"]);
  });
});

describe("WorkerConnection inference listener isolation", () => {
  it("continues event delivery and processes later frames after an observer throws", () => {
    const dispatcher = createFrameDispatcher();
    const observed: number[] = [];
    dispatcher.onInferenceEvent(() => {
      throw new Error("induced event observer failure");
    });
    dispatcher.onInferenceEvent((frame) => {
      observed.push(frame.payload.seq);
    });

    expect(() =>
      dispatcher.dispatchReadyFrame(inferenceEventFrame(1), {} as WebSocket),
    ).not.toThrow();
    expect(() =>
      dispatcher.dispatchReadyFrame(inferenceEventFrame(2), {} as WebSocket),
    ).not.toThrow();

    expect(observed).toEqual([1, 2]);
  });

  it("continues terminal delivery and processes later frames after an observer throws", () => {
    const dispatcher = createFrameDispatcher();
    const observed: number[] = [];
    dispatcher.onInferenceTerminal(() => {
      throw new Error("induced terminal observer failure");
    });
    dispatcher.onInferenceTerminal((frame) => {
      observed.push(frame.payload.seq);
    });

    expect(() =>
      dispatcher.dispatchReadyFrame(inferenceTerminalFrame(1), {} as WebSocket),
    ).not.toThrow();
    expect(() =>
      dispatcher.dispatchReadyFrame(inferenceTerminalFrame(2), {} as WebSocket),
    ).not.toThrow();

    expect(observed).toEqual([1, 2]);
  });
});
