import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import { sessionToolOverridesEqual } from "../session-tool-overrides.js";

export function resolveSessionPatchExpectationError(
  patch: SessionsPatchParams,
): string | undefined {
  if (patch.expectedPermissionMode !== undefined && patch.permissionMode === undefined) {
    return "expectedPermissionMode requires a permissionMode replacement.";
  }
  if (patch.expectedToolOverrides !== undefined && patch.toolOverrides === undefined) {
    return "expectedToolOverrides requires a toolOverrides replacement.";
  }
  return undefined;
}

export function sessionPatchExpectationsChanged(
  entry: SessionEntry | undefined,
  patch: SessionsPatchParams,
): boolean {
  return (
    (patch.expectedPermissionMode !== undefined &&
      (entry?.permissionMode ?? null) !== patch.expectedPermissionMode) ||
    (patch.expectedToolOverrides !== undefined &&
      !sessionToolOverridesEqual(entry?.toolOverrides, patch.expectedToolOverrides))
  );
}

export function sessionPatchTargetIdentity(patch: SessionsPatchParams) {
  return {
    key: patch.key,
    ...(patch.agentId ? { agentId: patch.agentId } : {}),
    ...(patch.expectedSessionId !== undefined
      ? { expectedSessionId: patch.expectedSessionId }
      : {}),
    ...(patch.expectedLifecycleRevision !== undefined
      ? { expectedLifecycleRevision: patch.expectedLifecycleRevision }
      : {}),
    ...(patch.expectedPermissionMode !== undefined
      ? { expectedPermissionMode: patch.expectedPermissionMode }
      : {}),
    ...(patch.expectedToolOverrides !== undefined
      ? { expectedToolOverrides: patch.expectedToolOverrides }
      : {}),
    expectedMarkedUnreadAt: patch.expectedMarkedUnreadAt,
  };
}
