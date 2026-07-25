/** Stable SecretRef owner identity for one agent-scoped auth profile. */
import { resolveAuthStorePath } from "../agents/auth-profiles/paths.js";

/** Tuple encoding distinguishes agents and avoids path/profile separator collisions. */
export function resolveAuthProfileSecretOwnerId(params: {
  agentDir?: string;
  profileId: string;
}): string {
  return JSON.stringify([resolveAuthStorePath(params.agentDir), params.profileId]);
}
