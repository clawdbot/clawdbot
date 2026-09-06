import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** One persisted workspace owner for file browsing, diff state, and media containment. */
export function resolveSessionWorkspaceRoots(
  cfg: OpenClawConfig,
  agentId: string,
  entry: Pick<SessionEntry, "spawnedCwd" | "spawnedWorkspaceDir">,
) {
  const spawnedCwd = normalizeOptionalString(entry.spawnedCwd);
  const spawnedWorkspaceDir = normalizeOptionalString(entry.spawnedWorkspaceDir);
  const configuredWorkspaceDir =
    spawnedCwd || spawnedWorkspaceDir
      ? undefined
      : normalizeOptionalString(resolveAgentWorkspaceDir(cfg, agentId));
  return {
    spawnedCwd,
    root: spawnedWorkspaceDir ?? spawnedCwd ?? configuredWorkspaceDir,
    // The diff operates in the selected cwd while browsing contains the entire workspace.
    diffCwd: spawnedCwd ?? spawnedWorkspaceDir ?? configuredWorkspaceDir,
  };
}
