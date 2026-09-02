/**
 * Operator-facing remediation for apply_patch workspace containment.
 *
 * Which control imposed the boundary decides which remedy is true, so the runtime owner
 * names its own source rather than the tool guessing from configuration it cannot see.
 */
import { isHostRootEscapeError } from "./sandbox-paths.js";
import { withToolOperatorHint } from "./tool-operator-hint.js";

/** Which layer contained apply_patch, and therefore which remedy actually lifts it. */
export type ApplyPatchContainmentSource = "config" | "session" | "worker";

const HINTS: Record<ApplyPatchContainmentSource, string> = {
  config:
    "apply_patch is workspace-contained by configuration. Both tools.exec.applyPatch.workspaceOnly " +
    "(default true) and tools.fs.workspaceOnly impose this independently, so clearing one can leave " +
    "the other in force. tools.exec.mode does not affect it.",
  session:
    "apply_patch is workspace-contained by this session's permission mode. Only a full permission " +
    "mode lifts it; configuration settings do not override a session mode.",
  worker:
    "apply_patch is workspace-contained by default on worker placements, which do not read " +
    "tools.exec.applyPatch.workspaceOnly or tools.fs.workspaceOnly. Only an explicit full session " +
    "permission mode lifts it here.",
};

/**
 * Name the control that contained this write, for the operator log only. Applies to host
 * workspace-root rejections; sandbox bridges enforce their own mount boundary, report it in
 * their own message, and are left untouched because host controls cannot lift a mount.
 */
export function withApplyPatchContainmentHint(
  error: unknown,
  source: ApplyPatchContainmentSource | undefined,
): unknown {
  return source && isHostRootEscapeError(error)
    ? withToolOperatorHint(error, HINTS[source])
    : error;
}
