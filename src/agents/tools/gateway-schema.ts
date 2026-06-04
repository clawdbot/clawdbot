import { Type } from "typebox";
import { optionalPositiveIntegerSchema } from "../schema/typebox.js";

/**
 * Shared TypeBox schema fragments for tools that call the Gateway.
 *
 * Keeping gateway options centralized prevents drift between tool schemas and
 * gateway call option parsing.
 */
/** Returns optional gateway URL/token/timeout schema properties for tool params. */
export function gatewayCallOptionSchemaProperties() {
  return {
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: optionalPositiveIntegerSchema(),
  };
}
