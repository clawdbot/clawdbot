import {
  type ExecAsk,
  type ExecMode,
  type ExecSecurity,
  resolveExecPolicyForMode,
} from "../infra/exec-approvals-core.js";
import { maxAsk, minSecurity } from "../infra/exec-approvals-policy.js";
import type { PreparedSessionPermissionPolicy } from "./tool-fs-policy.types.js";

const EXEC_MODE_BY_PERMISSION_MODE = {
  "read-only": "deny",
  guarded: "ask",
  workspace: "auto",
  full: "full",
} as const satisfies Record<PreparedSessionPermissionPolicy["mode"], ExecMode>;

export const SESSION_PERMISSION_BY_EXEC_MODE = {
  deny: "read-only",
  allowlist: "guarded",
  ask: "guarded",
  auto: "workspace",
  full: "full",
} as const satisfies Record<ExecMode, PreparedSessionPermissionPolicy["mode"]>;

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

export function resolveSessionPermissionExecPolicy(
  policy: Pick<PreparedSessionPermissionPolicy, "mode">,
  overrides?: { mode?: ExecMode; security?: ExecSecurity; ask?: ExecAsk },
): { mode?: ExecMode; security: ExecSecurity; ask: ExecAsk } {
  const mode = resolveSessionPermissionExecMode(policy);
  const base = resolveExecPolicyForMode(mode);
  const override = overrides?.mode ? resolveExecPolicyForMode(overrides.mode) : base;
  // Overrides may tighten a session mode, never loosen it. Dispatch can echo
  // the session mode alongside explicit security/ask, so clamp both inputs.
  const security = minSecurity(
    base.security,
    minSecurity(override.security, overrides?.security ?? "full"),
  );
  const ask = maxAsk(base.ask, maxAsk(override.ask, overrides?.ask ?? "off"));
  // Retaining a changed mode would make downstream normalization erase the tightening.
  return { mode: security === base.security && ask === base.ask ? mode : undefined, security, ask };
}
