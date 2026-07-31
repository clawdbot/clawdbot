// Qa Lab plugin module implements gateway rpc client behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { formatQaGatewayLogsForError } from "./gateway-log-redaction.js";

type QaGatewayRpcRequestOptions = {
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
          return await callGatewayFromCli(
            method,
            {
              url: params.wsUrl,
              token: params.token,
              timeout: String(opts?.timeoutMs ?? 20_000),
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
        queue = nextQueue;
        return await run;
      } catch (error) {
        throw wrapError(error);
      }
    },
    async stop() {
      stopped = true;
    },
  };
}
