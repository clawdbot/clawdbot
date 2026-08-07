import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import { ADMIN_SCOPE } from "./method-scopes.js";

export type PluginSessionOwnershipAction =
  | "abort"
  | "adopt"
  | "delete"
  | "fork"
  | "link"
  | "patch"
  | "reset";

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

/**
 * Resolves the gateway dispatch options that scope a session mutation to the
 * owning plugin. Non-plugin callers (no plugin id) pass through unchanged;
 * plugin callers without an admin-scoped client get a synthetic admin client
 * so the ownership-bound method accepts the owner-scoped request.
 */
export function resolvePluginOwnedCleanupOptions(
  params:
    | {
        client?: { connect?: { scopes?: readonly string[] } } | null;
        pluginId?: string;
      }
    | undefined,
):
  | { pluginRuntimeOwnerId: string; forceSyntheticClient?: boolean; syntheticScopes?: string[] }
  | undefined {
  const pluginId = normalizeOptionalString(params?.pluginId);
  if (!pluginId) {
    return undefined;
  }
  const scopes = Array.isArray(params?.client?.connect?.scopes)
    ? params?.client?.connect?.scopes
    : [];
  return {
    pluginRuntimeOwnerId: pluginId,
    ...(scopes.includes(ADMIN_SCOPE)
      ? {}
      : { forceSyntheticClient: true, syntheticScopes: [ADMIN_SCOPE] }),
  };
}
