import { resolveStateDir } from "../config/paths.js";
import { loadDeviceIdentityIfPresent } from "../infra/device-identity.js";

const localNodeIdByStateDir = new Map<string, string>();

// Keep successful primary identity reads process-stable, without creating credentials.
// Misses remain retryable because a node may create its identity after Gateway startup.
export async function resolveLocalNodeId(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const stateDir = resolveStateDir(env);
  const cached = localNodeIdByStateDir.get(stateDir);
  if (cached) {
    return cached;
  }
  const nodeId = loadDeviceIdentityIfPresent({ env })?.deviceId ?? null;
  if (nodeId) {
    localNodeIdByStateDir.set(stateDir, nodeId);
  }
  return nodeId;
}
