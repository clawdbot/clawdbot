import { type Static, Type } from "typebox";
import {
  ComputerActParamsSchema,
  ComputerUseCapabilityDescriptorSchema,
  ScreenSnapshotParamsSchema,
  compileComputerUseValidator,
} from "../plugins/computer-use-contract.js";

const ExecutionOwnerSchema = Type.Required(Type.Pick(ScreenSnapshotParamsSchema, ["executionId"]));
const ExecutionCloseFields = {
  ...ExecutionOwnerSchema.properties,
  reason: Type.String({ minLength: 1, maxLength: 64 }),
};

export const NodeWorkerComputerCloseParamsSchema = Type.Object(
  { action: Type.Literal("__close_execution"), ...ExecutionCloseFields },
  { additionalProperties: false },
);
const NodeWorkerComputerInputSchema = Type.Union([
  Type.Object({ operation: Type.Literal("capabilities") }, { additionalProperties: false }),
  Type.Object(
    {
      operation: Type.Literal("snapshot"),
      providerGeneration:
        ComputerUseCapabilityDescriptorSchema.properties.provider.properties.generation,
      params: Type.Intersect([ScreenSnapshotParamsSchema, ExecutionOwnerSchema]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("act"),
      providerGeneration:
        ComputerUseCapabilityDescriptorSchema.properties.provider.properties.generation,
      params: Type.Intersect([ComputerActParamsSchema, ExecutionOwnerSchema]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("close"),
      ...ExecutionCloseFields,
    },
    { additionalProperties: false },
  ),
]);

export type NodeWorkerComputerInput = Static<typeof NodeWorkerComputerInputSchema>;

const validateInput = compileComputerUseValidator(NodeWorkerComputerInputSchema);

/** Private carrier for the existing registered Computer Use provider, never arbitrary node commands. */
export function parseNodeWorkerComputerInput(raw?: string | null): NodeWorkerComputerInput {
  if (!raw || Buffer.byteLength(raw, "utf8") > 128 * 1024) {
    throw new Error("INVALID_REQUEST: invalid worker computer request size");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("INVALID_REQUEST: malformed worker computer request");
  }
  if (!validateInput(value)) {
    throw new Error("INVALID_REQUEST: invalid worker computer request");
  }
  return value;
}
