/**
 * Shared Gateway tool schema fragments.
 *
 * Keeps gateway URL/token/timeout parameters aligned across tools that call Gateway methods.
 */
import { Type } from "typebox";
import { optionalPositiveIntegerSchema } from "../schema/typebox.js";

/** Returns optional gateway URL/token/timeout schema properties for tool params. */
export function gatewayCallOptionSchemaProperties() {
  return {
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: optionalPositiveIntegerSchema(),
  };
}
