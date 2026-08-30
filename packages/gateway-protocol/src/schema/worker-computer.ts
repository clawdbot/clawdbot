import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import {
  WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WorkerErrorResponseFrameSchema,
  WorkerFrameIdSchema,
  WorkerIdentifierSchema,
} from "./worker-protocol-primitives.js";

export const WORKER_COMPUTER_PROTOCOL_FEATURE = "worker-computer-v1";

export const WorkerComputerParamsSchema = closedObject({
  command: Type.Enum(["screen.snapshot", "computer.act"] as const, { type: "string" }),
  paramsJson: Type.String({ minLength: 2, maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000 })),
  idempotencyKey: Type.Optional(WorkerIdentifierSchema),
});

// Desktop snapshots use the already bounded image transport budget; ordinary
// worker command requests retain the smaller control-frame ceiling.
export const WorkerComputerResultSchema = closedObject({
  resultJson: Type.String({ minLength: 2, maxLength: WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES }),
});

export const WorkerComputerResponseFrameSchema = Type.Union([
  closedObject({
    type: Type.Literal("res"),
    id: WorkerFrameIdSchema,
    ok: Type.Literal(true),
    payload: WorkerComputerResultSchema,
  }),
  WorkerErrorResponseFrameSchema,
]);

export type WorkerComputerParams = Static<typeof WorkerComputerParamsSchema>;
export type WorkerComputerResult = Static<typeof WorkerComputerResultSchema>;
export type WorkerComputerResponseFrame = Static<typeof WorkerComputerResponseFrameSchema>;
