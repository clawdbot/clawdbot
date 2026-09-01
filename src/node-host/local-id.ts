import { resolveStateDir } from "../config/paths.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
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
  return await getOrCreatePromise(
    localNodeIdByStateDir,
    stateDir,
    async () => (await loadNodeHostConfig(env))?.nodeId ?? null,
    { cacheRejections: false },
  );
}
