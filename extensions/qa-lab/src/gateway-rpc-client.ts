// Qa Lab plugin module implements gateway rpc client behavior.
import { formatErrorMessage, toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
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

function formatQaGatewayRpcError(error: unknown, logs: () => string) {
  const details = formatErrorMessage(error);
  return new Error(`${details}${formatQaGatewayLogsForError(logs())}`, { cause: error });
}

function runQueuedQaGatewayRpc<T>(queue: Promise<void>, task: () => Promise<T>) {
  const run = queue.then(task, task);
  const nextQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return { run, nextQueue };
}

function qaGatewayDeadlineError() {
  return new Error("gateway request deadline exceeded");
}

function waitForQaGatewayRpcDeadline<T>(run: Promise<T>, deadlineMs: number) {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(qaGatewayDeadlineError());
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(qaGatewayDeadlineError()), remainingMs);
    void run.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        const rejectionError: Error = toErrorObject(error, "Gateway RPC request failed");
        reject(rejectionError);
      },
    );
  });
}

export async function startQaGatewayRpcClient(params: {
  wsUrl: string;
  token: string;
  logs: () => string;
}): Promise<QaGatewayRpcClient> {
  const wrapError = (error: unknown) => formatQaGatewayRpcError(error, params.logs);
  let stopped = false;
  let queue = Promise.resolve();
  const assertNotStopped = () => {
    if (stopped) {
      throw new Error("gateway rpc client already stopped");
    }
  };

  return {
    async request(method, rpcParams, opts) {
      try {
        assertNotStopped();
      } catch (error) {
        throw wrapError(error);
      }
      try {
        const { run, nextQueue } = runQueuedQaGatewayRpc(queue, async () => {
          assertNotStopped();
          const remainingMs =
            opts?.deadlineMs === undefined ? undefined : opts.deadlineMs - Date.now();
          if (remainingMs !== undefined && remainingMs <= 0) {
            throw qaGatewayDeadlineError();
          }
          return await callGatewayFromCli(
            method,
            {
              url: params.wsUrl,
              token: params.token,
              timeout: String(
                remainingMs === undefined
                  ? (opts?.timeoutMs ?? 20_000)
                  : Math.min(opts?.timeoutMs ?? 20_000, remainingMs),
              ),
              expectFinal: opts?.expectFinal,
              json: true,
            },
            rpcParams ?? {},
            {
              clientName: "gateway-client",
              deviceIdentity: null,
              expectFinal: opts?.expectFinal,
              mode: "backend",
              progress: false,
              scopes: ["operator.admin"],
            },
          );
        });
        // Caller deadline rejection must not release serialization. The queue stays on
        // the underlying run, which rechecks expiry before dispatch when its turn arrives.
        queue = nextQueue;
        return await (opts?.deadlineMs === undefined
          ? run
          : waitForQaGatewayRpcDeadline(run, opts.deadlineMs));
      } catch (error) {
        throw wrapError(error);
      }
    },
    async stop() {
      stopped = true;
    },
  };
}
