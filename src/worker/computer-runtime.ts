import { Value } from "typebox/value";
import {
  WorkerComputerParamsSchema,
  type WorkerComputerParams,
  type WorkerComputerResponseFrame,
} from "../../packages/gateway-protocol/src/schema/worker-computer.js";
import {
  createComputerTool,
  type ComputerToolTransport,
  type ComputerContextEpoch,
} from "../agents/tools/computer-tool.js";
import type { WorkerComputerLaunchDescriptor } from "./launch-descriptor.js";

export function createWorkerComputerTool(params: {
  descriptor: WorkerComputerLaunchDescriptor;
  requestComputer(request: WorkerComputerParams): Promise<WorkerComputerResponseFrame>;
  runId: string;
  contextEpoch?: ComputerContextEpoch;
  registerRunCleanup: NonNullable<Parameters<typeof createComputerTool>[0]>["registerRunCleanup"];
}) {
  let closing: Promise<WorkerComputerResponseFrame> | undefined;
  const close = (request: WorkerComputerParams) =>
    (closing ??= Promise.resolve().then(() => params.requestComputer(request)));
  const transport: ComputerToolTransport = {
    computerUse: params.descriptor.computerUse,
    resolveNode: async (query, signal) => {
      signal?.throwIfAborted();
      if (query !== undefined && query !== params.descriptor.nodeId) {
        throw new Error("Computer input is bound to this session's desktop.");
      }
      return params.descriptor;
    },
    invoke: async ({ nodeId, command, commandParams, timeoutMs, idempotencyKey, signal }) => {
      signal?.throwIfAborted();
      if (nodeId !== params.descriptor.nodeId) {
        throw new Error("Computer input is bound to this session's desktop.");
      }
      const isClose = command === "computer.act" && commandParams.action === "__close_execution";
      if (closing && !isClose) {
        throw new Error("Computer execution is closed.");
      }
      const request = {
        command,
        paramsJson: JSON.stringify(commandParams),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      };
      if (!Value.Check(WorkerComputerParamsSchema, request)) {
        throw new Error("Computer request exceeds the worker protocol limits.");
      }
      // Close fences pending input before the tool queue drains. Keep its result
      // for normal run cleanup, which must still report a failed native close.
      const abort = () => {
        void close({
          command: "computer.act",
          paramsJson: JSON.stringify({
            action: "__close_execution",
            executionId: commandParams.executionId,
            reason: "Worker computer invocation aborted",
          }),
        }).catch(() => {});
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const response = await (isClose
          ? close(request)
          : params.requestComputer(request).catch((error: unknown) => {
              abort();
              throw error;
            }));
        signal?.throwIfAborted();
        if (!response.ok) {
          throw new Error(response.error.message);
        }
        return JSON.parse(response.payload.resultJson) as unknown;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  };
  return createComputerTool({
    transport,
    contextEpoch: params.contextEpoch,
    idempotencyScope: params.runId,
    registerRunCleanup: params.registerRunCleanup,
  });
}
