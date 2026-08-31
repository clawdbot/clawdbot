/** Stable SecretRef owner identity for one agent-scoped auth profile. */
import { resolveSharedAuthStorePath } from "../agents/auth-profiles/path-resolve.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";

/** Tuple encoding distinguishes agents and avoids path/profile separator collisions. */
export function resolveAuthProfileSecretOwnerId(params: {
  agentDir?: string;
  profileId: string;
}): string {
  const storePath = params.agentDir
    ? resolveAuthProfileDatabasePath(params.agentDir)
    : resolveSharedAuthStorePath();
  return JSON.stringify([storePath, params.profileId]);
}
