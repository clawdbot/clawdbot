// Install download test utilities provide fake download responses and paths.
import path from "node:path";

/** Points OpenClaw state at a workspace-local temp dir for install tests. */
export function setTempStateDir(workspaceDir: string): string {
  const stateDir = path.join(workspaceDir, "state");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return stateDir;
}
