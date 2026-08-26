import type { SessionPermissionMode } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";

const SESSION_PERMISSION_ROOT_REQUIRED_MESSAGE =
  "permission mode requires a session root; choose Default or a rooted session";

export function resolveSessionPermissionRootError(
  permissionMode: SessionPermissionMode | null | undefined,
  sessionRoot: string | undefined,
): string | undefined {
  return permissionMode && !sessionRoot ? SESSION_PERMISSION_ROOT_REQUIRED_MESSAGE : undefined;
}

export function applySessionPermissionMode(
  entry: Pick<SessionEntry, "permissionMode" | "sessionRoot">,
  permissionMode: SessionPermissionMode | null | undefined,
): string | undefined {
  if (permissionMode === null) {
    delete entry.permissionMode;
    return undefined;
  }
  const error = resolveSessionPermissionRootError(permissionMode, entry.sessionRoot);
  if (!error && permissionMode) {
    entry.permissionMode = permissionMode;
  }
  return error;
}
