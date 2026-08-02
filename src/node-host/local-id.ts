import { resolveStateDir } from "../config/paths.js";
import { loadNodeHostConfig } from "./config.js";

const localNodeIdByStateDir = new Map<string, Promise<string | null>>();

/**
 * Resolve the same-install node host from canonical shared SQLite state.
 * Node-host config changes require restart, so this fact stays process-stable.
 */
export async function resolveLocalNodeId(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const stateDir = resolveStateDir(env);
  let pending = localNodeIdByStateDir.get(stateDir);
  if (!pending) {
    pending = loadNodeHostConfig(env).then((config) => config?.nodeId ?? null);
    localNodeIdByStateDir.set(stateDir, pending);
  }
  try {
    return await pending;
  } catch (error) {
    if (localNodeIdByStateDir.get(stateDir) === pending) {
      localNodeIdByStateDir.delete(stateDir);
    }
    throw error;
  }
}
