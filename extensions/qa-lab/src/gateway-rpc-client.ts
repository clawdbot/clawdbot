import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { callGatewayFromCli } from "openclaw/plugin-sdk/browser-node-runtime";
import { formatQaGatewayLogsForError } from "./gateway-log-redaction.js";

type QaGatewayRpcRequestOptions = {
  expectFinal?: boolean;
  timeoutMs?: number;
};

export type QaGatewayRpcClient = {
  request(method: string, rpcParams?: unknown, opts?: QaGatewayRpcRequestOptions): Promise<unknown>;
  stop(): Promise<void>;
};

function formatQaGatewayRpcError(error: unknown, logs: () => string) {
  const details = formatErrorMessage(error);
  return new Error(`${details}${formatQaGatewayLogsForError(logs())}`);
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

  return {
    async request(method, rpcParams, opts) {
      if (stopped) {
        throw wrapError(new Error("gateway rpc client already stopped"));
      }
      try {
        const { run, nextQueue } = runQueuedQaGatewayRpc(
          queue,
          async () =>
            await callGatewayFromCli(
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
                expectFinal: opts?.expectFinal,
                progress: false,
              },
            ),
        );
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
