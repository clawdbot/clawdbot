// Qa Lab plugin module implements gateway rpc client behavior.
import { formatErrorMessage, toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import {
  GatewayClient,
  startGatewayClientWhenEventLoopReady,
} from "openclaw/plugin-sdk/gateway-runtime";
import { formatQaGatewayLogsForError } from "./gateway-log-redaction.js";

type QaGatewayRpcRequestOptions = {
  deadlineMs?: number;
  expectFinal?: boolean;
  timeoutMs?: number;
};

type QaGatewayRpcClient = {
  request(method: string, rpcParams?: unknown, opts?: QaGatewayRpcRequestOptions): Promise<unknown>;
  stop(): Promise<void>;
};

type QaGatewayConnectionGate = {
  connected: boolean;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

const QA_GATEWAY_RPC_TIMEOUT_MS = 20_000;

function createQaGatewayConnectionGate(): QaGatewayConnectionGate {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // A terminal reconnect error can arrive without an active request waiter.
  void promise.catch(() => {});
  return { connected: false, promise, reject: rejectPromise, resolve: resolvePromise };
}

function formatQaGatewayRpcError(error: unknown, logs: () => string) {
  const cause = toErrorObject(error, "Gateway RPC request failed");
  const details = formatErrorMessage(cause);
  return new Error(`${details}${formatQaGatewayLogsForError(logs())}`, { cause });
}

function qaGatewayDeadlineError() {
  return new Error("gateway request deadline exceeded");
}

async function waitForQaGatewayConnection(
  gate: QaGatewayConnectionGate,
  expiresAt: number,
): Promise<void> {
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) {
    throw qaGatewayDeadlineError();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      gate.promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(qaGatewayDeadlineError()), remainingMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function startQaGatewayRpcClient(params: {
  wsUrl: string;
  token: string;
  logs: () => string;
  scopes?: Array<"operator.read" | "operator.write" | "operator.admin">;
}): Promise<QaGatewayRpcClient> {
  const wrapError = (error: unknown) => formatQaGatewayRpcError(error, params.logs);
  let stopped = false;
  let connection = createQaGatewayConnectionGate();
  const assertNotStopped = () => {
    if (stopped) {
      throw new Error("gateway rpc client already stopped");
    }
  };

  const client = new GatewayClient({
    url: params.wsUrl,
    token: params.token,
    requestTimeoutMs: QA_GATEWAY_RPC_TIMEOUT_MS,
    clientName: "gateway-client",
    deviceIdentity: null,
    mode: "backend",
    scopes: params.scopes ?? ["operator.admin"],
    onHelloOk: () => {
      connection.connected = true;
      connection.resolve();
    },
    onClose: () => {
      if (!stopped && connection.connected) {
        connection = createQaGatewayConnectionGate();
      }
    },
    onReconnectPaused: (info) => {
      const error = new Error(
        `gateway reconnect paused (${info.code}): ${info.reason}${info.detailCode ? ` [${info.detailCode}]` : ""}`,
      );
      if (connection.connected) {
        connection = createQaGatewayConnectionGate();
      }
      connection.reject(error);
    },
  });

  try {
    const startupExpiresAt = Date.now() + QA_GATEWAY_RPC_TIMEOUT_MS;
    const readiness = await startGatewayClientWhenEventLoopReady(client, {
      timeoutMs: QA_GATEWAY_RPC_TIMEOUT_MS,
    });
    if (!readiness.ready) {
      throw new Error("gateway event loop readiness timeout");
    }
    await waitForQaGatewayConnection(connection, startupExpiresAt);
  } catch (error) {
    stopped = true;
    await client.stopAndWait().catch(() => {});
    throw wrapError(error);
  }

  return {
    async request(method, rpcParams, opts) {
      try {
        assertNotStopped();
        const startedAt = Date.now();
        const expiresAt = Math.min(
          startedAt + (opts?.timeoutMs ?? QA_GATEWAY_RPC_TIMEOUT_MS),
          opts?.deadlineMs ?? Infinity,
        );
        while (true) {
          const requestConnection = connection;
          await waitForQaGatewayConnection(requestConnection, expiresAt);
          assertNotStopped();
          const remainingMs = expiresAt - Date.now();
          if (remainingMs <= 0) {
            throw qaGatewayDeadlineError();
          }
          let requestSent = false;
          try {
            return await client.request(method, rpcParams ?? {}, {
              expectFinal: opts?.expectFinal,
              onSent: () => {
                requestSent = true;
              },
              timeoutMs: remainingMs,
            });
          } catch (error) {
            if (requestSent || formatErrorMessage(error) !== "gateway not connected") {
              throw error;
            }
            assertNotStopped();
            // A close can race between gate resolution and request dispatch. No frame was sent,
            // so waiting for the next hello and retrying is safe even for non-idempotent methods.
            if (connection === requestConnection && connection.connected) {
              connection = createQaGatewayConnectionGate();
            }
          }
        }
      } catch (error) {
        throw wrapError(error);
      }
    },
    async stop() {
      stopped = true;
      connection.reject(new Error("gateway rpc client stopped"));
      await client.stopAndWait();
    },
  };
}
