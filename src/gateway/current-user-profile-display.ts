import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getUserProfileDisplay } from "../state/user-profiles.js";
import { formatUserProfileAvatarPath } from "./user-profiles-http-path.js";

export type CurrentUserProfileDisplay =
  | {
      kind: "resolved";
      profileId: string;
      label?: string;
      avatarUrl: string;
      hasUploadedAvatar: boolean;
    }
  | { kind: "unresolved" };

export type CurrentUserProfileDisplayResolver = (senderId: string) => CurrentUserProfileDisplay;

export function resolveCurrentUserProfileDisplay(senderId: string): CurrentUserProfileDisplay {
  try {
    const profile = getUserProfileDisplay(senderId);
    const label = normalizeOptionalString(profile.displayName);
    return {
      kind: "resolved",
      profileId: profile.id,
      ...(label ? { label } : {}),
      avatarUrl: formatUserProfileAvatarPath(profile.id, profile.avatarRevision),
      hasUploadedAvatar: profile.hasAvatar,
    };
  } catch {
    // Durable ids can also be channel sender ids; only profile ids resolve here.
    return { kind: "unresolved" };
  }
}
