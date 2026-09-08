import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Value } from "typebox/value";
import type { WorkerProtocolCloseReason } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  type WorkerComputerParams,
  type WorkerComputerResult,
  WorkerComputerResultSchema,
} from "../../../packages/gateway-protocol/src/schema/worker-computer.js";
import {
  WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH,
  WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES,
} from "../../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import { redactSensitiveText } from "../../logging/redact.js";
import {
  ComputerActParamsSchema,
  ScreenSnapshotParamsSchema,
} from "../../plugins/computer-use-contract.js";
import { NodeWorkerComputerCloseParamsSchema } from "../../worker/node-computer-protocol.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";

export type WorkerComputerExecutor = (params: {
  identity: WorkerConnectionIdentity;
  request: WorkerComputerParams;
  signal?: AbortSignal;
  assertCurrent: () => void;
}) => Promise<WorkerComputerResult>;

type WorkerComputerAdmission = { ok: true } | { ok: false; closeReason: WorkerProtocolCloseReason };

export function createWorkerComputerRpc(params: {
  execute?: WorkerComputerExecutor;
  validate(identity: WorkerConnectionIdentity): WorkerComputerAdmission;
}) {
  return async (
    identity: WorkerConnectionIdentity,
    request: WorkerComputerParams,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; result: WorkerComputerResult }
    | { ok: false; closeReason: WorkerProtocolCloseReason }
    | { ok: false; reason: WorkerProtocolCloseReason; message?: string }
  > => {
    const admitted = params.validate(identity);
    if (!admitted.ok) {
      return admitted;
    }
    if (!params.execute) {
      return { ok: false, reason: "gateway-unavailable" };
    }
    const assertCurrent = () => {
      signal?.throwIfAborted();
      const current = params.validate(identity);
      if (!current.ok) {
        throw new Error(`Worker computer authority closed: ${current.closeReason}`);
      }
    };
    let commandParams: unknown;
    try {
      commandParams = JSON.parse(request.paramsJson);
    } catch {
      return { ok: false, closeReason: "invalid-frame" };
    }
    try {
      const schema =
        request.command === "screen.snapshot"
          ? ScreenSnapshotParamsSchema
          : ComputerActParamsSchema;
      const closing =
        request.command === "computer.act" &&
        Value.Check(NodeWorkerComputerCloseParamsSchema, commandParams);
      if (!closing && !Value.Check(schema, commandParams)) {
        return { ok: false, closeReason: "invalid-frame" };
      }
      assertCurrent();
      const result = await params.execute({ identity, request, signal, assertCurrent });
      const current = params.validate(identity);
      if (!current.ok) {
        return current;
      }
      signal?.throwIfAborted();
      const response = {
        type: "res",
        id: "x".repeat(WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH),
        ok: true,
        payload: result,
      };
      if (
        !Value.Check(WorkerComputerResultSchema, result) ||
        Buffer.byteLength(JSON.stringify(response), "utf8") >
          WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES
      ) {
        throw new Error("Computer result exceeds the worker image transport limit.");
      }
      return { ok: true, result };
    } catch (error) {
      const current = params.validate(identity);
      if (!current.ok) {
        return current;
      }
      const message = error instanceof Error ? error.message : "Worker computer operation failed";
      return {
        ok: false,
        reason: "gateway-unavailable",
        message: truncateUtf16Safe(redactSensitiveText(message, { mode: "tools" }), 256),
      };
    }
  };
}
