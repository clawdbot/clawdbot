import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getUserProfileListItem } from "../state/user-profiles.js";
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
    const profile = getUserProfileListItem(senderId);
    const label = normalizeOptionalString(profile.displayName);
    return {
      kind: "resolved",
      profileId: profile.id,
      ...(label ? { label } : {}),
      avatarUrl: formatUserProfileAvatarPath(profile.id, profile.updatedAt),
      hasUploadedAvatar: profile.hasAvatar,
    };
  } catch {
    // Durable ids can also be channel sender ids; only profile ids resolve here.
    return { kind: "unresolved" };
  }
}
