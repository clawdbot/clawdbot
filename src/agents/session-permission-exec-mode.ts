import type { ExecMode } from "../infra/exec-approvals.js";
import type { PreparedSessionPermissionPolicy } from "./tool-fs-policy.types.js";

const EXEC_MODE_BY_PERMISSION_MODE = {
  "read-only": "deny",
  guarded: "ask",
  workspace: "auto",
  full: "full",
} as const satisfies Record<PreparedSessionPermissionPolicy["mode"], ExecMode>;

export function resolveSessionPermissionCoreToolPolicy(
  policy: Pick<PreparedSessionPermissionPolicy, "mode">,
) {
  const workspaceOnly = policy.mode !== "full";
  return {
    workspaceOnly,
    readOnly: policy.mode === "read-only",
    applyPatchWorkspaceOnly: workspaceOnly,
    execMode: EXEC_MODE_BY_PERMISSION_MODE[policy.mode],
    bypassHostApprovalFloors: policy.mode === "full",
  };
}

export function resolveSessionPermissionExecMode(
  policy: Pick<PreparedSessionPermissionPolicy, "mode">,
): ExecMode {
  return resolveSessionPermissionCoreToolPolicy(policy).execMode;
}
