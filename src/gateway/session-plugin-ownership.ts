import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";

export type PluginSessionOwnershipAction = "adopt" | "delete" | "fork" | "link" | "patch" | "reset";

/** Plugin callers may access an existing session only when they own its exact row. */
export function resolvePluginSessionOwnershipError(params: {
  action: PluginSessionOwnershipAction;
  entry: SessionEntry | undefined;
  key: string;
  pluginOwnerId: string | null | undefined;
}): ErrorShape | undefined {
  const pluginOwnerId = normalizeOptionalString(params.pluginOwnerId);
  if (
    !pluginOwnerId ||
    !params.entry ||
    normalizeOptionalString(params.entry.pluginOwnerId) === pluginOwnerId
  ) {
    return undefined;
  }
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `Plugin "${pluginOwnerId}" cannot ${params.action} session "${params.key}" because it did not create it.`,
  );
}
