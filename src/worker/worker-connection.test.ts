import { once } from "node:events";
import net from "node:net";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  type WorkerConnectParams,
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
  WORKER_PUBLIC_INGRESS_PATH,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerInferenceEventFrame,
  WorkerInferenceTerminalFrame,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  formatWorkerConnectionFailure,
  toWorkerConnectionError,
  WorkerAdmissionDeadlineExceededError,
  WorkerConnectionStoppedError,
  WorkerFencedError,
} from "./worker-connection-contract.js";
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
    const terminalErrors: Error[] = [];
    connection.onTerminalError((error) => terminalErrors.push(error));

    await expect(connection.start()).rejects.toBeInstanceOf(WorkerConnectionEndpointError);
    expect(terminalErrors).toHaveLength(1);
    expect(connection.state).toEqual({ kind: "failed", error: terminalErrors[0] });
    expect(createSocket).not.toHaveBeenCalled();
  });

  it("reports the last unreachable gateway cause with an operator hint", async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("test server did not allocate a TCP port"));
          return;
        }
        server.close((error) => (error ? reject(error) : resolve(address.port)));
      });
    });
    const endpoint = {
      kind: "websocket" as const,
      url: `ws://127.0.0.1:${port}${WORKER_PUBLIC_INGRESS_PATH}`,
    };
    const failures: string[] = [];
    const connection = createWorkerConnection({
      endpoint,
      connectParams: FRAME_CONNECT_PARAMS,
      admissionTimeoutMs: 25,
      admissionDeadlineMs: 100,
      reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
      onConnectionFailure: (error) => {
        if (error) {
          failures.push(formatWorkerConnectionFailure(endpoint, error));
        }
      },
    });

    try {
      await expect(connection.start()).rejects.toBeInstanceOf(WorkerAdmissionDeadlineExceededError);
      expect(failures.at(-1)).toMatch(
        new RegExp(
          `^worker could not reach gateway 127\\.0\\.0\\.1:${port}: .*ECONNREFUSED.*; check TLS pin/publicUrl configuration$`,
          "u",
        ),
      );
    } finally {
      await connection.stop();
    }
  });

  it("does not report local cancellation as a gateway connection failure", async () => {
    let acceptConnection!: (socket: net.Socket) => void;
    const accepted = new Promise<net.Socket>((resolve) => {
      acceptConnection = resolve;
    });
    const server = net.createServer(acceptConnection);
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("test server did not allocate a TCP port"));
          return;
        }
        resolve(address.port);
      });
    });
    const failures: Error[] = [];
    const connection = createWorkerConnection({
      endpoint: {
        kind: "websocket",
        url: `ws://127.0.0.1:${port}${WORKER_PUBLIC_INGRESS_PATH}`,
      },
      connectParams: FRAME_CONNECT_PARAMS,
      onConnectionFailure: (error) => {
        if (error) {
          failures.push(error);
        }
      },
    });
    const starting = connection.start();
    const peer = await accepted;

    try {
      await connection.stop();
      await expect(starting).rejects.toBeInstanceOf(WorkerConnectionStoppedError);
      expect(failures).toEqual([]);
    } finally {
      peer.destroy();
      await connection.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});

describe("worker connection reconnect backoff", () => {
  it("staggers twenty workers recovering from transient Gateway transport loss", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test gateway did not allocate a TCP port");
    }

    let available = true;
    let transportInterrupted = false;
    const unavailableWorkers = new Set<string>();
    const recoveredWorkers = new Set<string>();
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(rawDataToString(data)) as {
          id: string;
          params: { admission: WorkerConnectParams["admission"] };
        };
        const admission = frame.params.admission;
        if (!available) {
          unavailableWorkers.add(admission.environmentId);
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: {
                code: "INVALID_REQUEST",
                message: "gateway temporarily unavailable",
                details: { reason: "gateway-unavailable" },
                retryable: true,
              },
            }),
          );
          return;
        }
        if (transportInterrupted) {
          recoveredWorkers.add(admission.environmentId);
        }
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "worker-hello-ok",
              environmentId: admission.environmentId,
              sessionId: admission.sessionId,
              ownerEpoch: admission.ownerEpoch,
              rpcSetVersion: admission.rpcSetVersion,
              protocolFeatures: [...admission.handshake.protocolFeatures],
              credentialExpiresAtMs: Date.now() + 60_000,
              policy: { heartbeatIntervalMs: 60_000, maxPayload: 25 * 1024 * 1024 },
            },
          }),
        );
      });
    });

    const workers = Array.from({ length: 20 }, (_, index) =>
      createWorkerConnection({
        endpoint: {
          kind: "websocket",
          url: `ws://127.0.0.1:${address.port}${WORKER_PUBLIC_INGRESS_PATH}`,
        },
        connectParams: {
          ...FRAME_CONNECT_PARAMS,
          admission: {
            ...FRAME_CONNECT_PARAMS.admission,
            environmentId: `reconnect-worker-${index}`,
          },
        },
        admissionDeadlineMs: 10_000,
      }),
    );

    let randomDraw = 0;
    const random = vi
      .spyOn(Math, "random")
      .mockImplementation(() => ((randomDraw++ % 20) + 1) / 21);
    const retryDelays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    const timeout = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) => {
        if (typeof delay === "number" && delay >= 250 && delay <= 275) {
          retryDelays.push(delay);
        }
        return originalSetTimeout(callback, delay, ...args);
      });

    try {
      await Promise.all(workers.map((worker) => worker.start()));
      const readyAgain = workers.map(
        (worker) =>
          new Promise<void>((resolve) => {
            const unsubscribe = worker.onReady(() => {
              unsubscribe();
              resolve();
            });
          }),
      );

      available = false;
      transportInterrupted = true;
      for (const socket of server.clients) {
        socket.close(1012, "gateway-unavailable");
      }
      await vi.waitFor(() => expect(unavailableWorkers.size).toBe(20), {
        timeout: 3_000,
        interval: 5,
      });
      available = true;
      await Promise.all(readyAgain);

      expect(recoveredWorkers.size).toBe(20);
      expect(retryDelays).toHaveLength(20);
      expect(new Set(retryDelays).size).toBeGreaterThanOrEqual(10);
      expect(Math.max(...retryDelays)).toBeLessThanOrEqual(30_000);
    } finally {
      random.mockRestore();
      timeout.mockRestore();
      await Promise.all(workers.map((worker) => worker.stop()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
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
    const terminalErrors: Error[] = [];
    connection.onTerminalError((error) => terminalErrors.push(error));
    const exit = connection.waitForExit();

    await expect(connection.stop()).resolves.toBeUndefined();
    await expect(exit).resolves.toEqual({ kind: "stopped" });
    await expect(connection.stop()).resolves.toBeUndefined();

    expect(connection.state).toEqual({ kind: "stopped" });
    expect(listeners.throwingCalls()).toBe(1);
    expect(listeners.observed).toEqual(["stopped"]);
    expect(terminalErrors).toEqual([new WorkerConnectionStoppedError()]);
  });

  it("settles fencing and reaches later listeners when an earlier listener throws", async () => {
    const connection = createIdleConnection();
    const listeners = installThrowingThenHealthyListeners(connection);
    const terminalErrors: Error[] = [];
    connection.onTerminalError((error) => terminalErrors.push(error));

    expect(() => connection.fence("owner-epoch-mismatch")).not.toThrow();
    await expect(connection.waitForExit()).resolves.toEqual({
      kind: "fenced",
      reason: "owner-epoch-mismatch",
    });

    expect(connection.state).toEqual({ kind: "fenced", reason: "owner-epoch-mismatch" });
    expect(listeners.throwingCalls()).toBe(1);
    expect(listeners.observed).toEqual(["fenced"]);
    expect(terminalErrors).toEqual([new WorkerFencedError("owner-epoch-mismatch")]);
  });

  it("keeps terminal errors bound to their emitted state during nested transitions", () => {
    const connection = createIdleConnection();
    const terminalErrors: Error[] = [];
    connection.onStateChange((state) => {
      if (state.kind === "fenced") {
        void connection.stop();
      }
    });
    connection.onTerminalError((error) => terminalErrors.push(error));

    connection.fence("owner-epoch-mismatch");

    expect(terminalErrors).toEqual([
      new WorkerConnectionStoppedError(),
      new WorkerFencedError("owner-epoch-mismatch"),
    ]);
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
