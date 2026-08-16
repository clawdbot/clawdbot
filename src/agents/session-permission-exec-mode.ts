import type { ExecMode } from "../infra/exec-approvals.js";
import type { PreparedSessionPermissionPolicy } from "./tool-fs-policy.types.js";

export function resolveSessionPermissionExecMode(
  policy: Pick<PreparedSessionPermissionPolicy, "mode">,
): ExecMode {
  switch (policy.mode) {
    case "read-only":
      return "deny";
    case "guarded":
      return "ask";
    case "workspace":
      return "auto";
    case "full":
      return "full";
  }
}
