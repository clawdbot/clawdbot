import { Type } from "typebox";
import { optionalPositiveIntegerSchema } from "../schema/typebox.js";

export function gatewayCallOptionSchemaProperties() {
  return {
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: optionalPositiveIntegerSchema(),
  };
}
