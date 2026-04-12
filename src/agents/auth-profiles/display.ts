import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAuthProfileMetadata } from "./identity.js";
import type { AuthProfileStore } from "./types.js";

export function resolveAuthProfileDisplayLabel(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  profileId: string;
}): string {
  const { displayName, email } = resolveAuthProfileMetadata(params);
  if (displayName) {
    return `${params.profileId} (${displayName})`;
  }
  if (email) {
    return `${params.profileId} (${email})`;
  }
  return params.profileId;
}
