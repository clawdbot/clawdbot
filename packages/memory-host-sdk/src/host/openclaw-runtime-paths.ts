// Pure path owners; importing memory helpers must not initialize core runtime paths.
import path from "node:path";
import { resolveDefaultAgentWorkspaceDir as resolveCoreDefaultAgentWorkspaceDir } from "../../../../src/agents/workspace-default-path.js";
import { resolveStateDirFromHome } from "../../../../src/config/state-dir.js";
import { resolveRequiredHomeDir, resolveUserPath } from "../../../../src/infra/home-dir.js";
export { resolveUserPath };

/** Keep effective-home expansion at the memory-host boundary, before state selection. */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env);
  }
  const home = resolveRequiredHomeDir(env);
  return resolveStateDirFromHome(env, () => home);
}

/** Preserve memory-host override expansion without re-expanding an effective home. */
export function resolveDefaultAgentWorkspaceDir(env: NodeJS.ProcessEnv): string {
  const workspaceDir = env.OPENCLAW_WORKSPACE_DIR?.trim();
  if (workspaceDir) {
    return resolveUserPath(workspaceDir, env);
  }
  if (env.OPENCLAW_STATE_DIR?.trim()) {
    return path.join(resolveStateDir(env), "workspace");
  }
  return resolveCoreDefaultAgentWorkspaceDir(env);
}
