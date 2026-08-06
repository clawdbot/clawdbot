/** Stable SecretRef owner identity for one agent-scoped auth profile. */
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";

/** Tuple encoding distinguishes agents and avoids path/profile separator collisions. */
export function resolveAuthProfileSecretOwnerId(params: {
  agentDir?: string;
  profileId: string;
}): string {
  return JSON.stringify([resolveAuthProfileDatabasePath(params.agentDir), params.profileId]);
}
