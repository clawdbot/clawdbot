import type { MoltbotConfig } from "../../config/config.js";
import type { AuthProfileStore } from "./types.js";

export function resolveAuthProfileDisplayLabel(params: {
  cfg?: MoltbotConfig;
  store: AuthProfileStore;
  profileId: string;
}): string {
  const { cfg, store, profileId } = params;
  const profile = store.profiles[profileId];
  const configEmail = cfg?.auth?.profiles?.[profileId]?.email?.trim();
  const email =
    configEmail ||
    (profile && "email" in profile ? (profile.email as string | undefined)?.trim() : undefined);
  if (email) return `${profileId} (${email})`;
  return profileId;
}
