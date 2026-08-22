import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Bearer-token auth modes that are interchangeable (oauth tokens and raw tokens). */
const BEARER_AUTH_MODES = new Set(["oauth", "token"]);

function isCompatibleAuthModeType(mode: string | undefined, type: string | undefined): boolean {
  if (!mode || !type) {
    return false;
  }
  if (mode === type) {
    return true;
  }
  return BEARER_AUTH_MODES.has(mode) && BEARER_AUTH_MODES.has(type);
}

/** True when a stored credential may resolve the declared auth.profiles entry. */
export function isAuthProfileConfigCompatible(params: {
  cfg?: OpenClawConfig;
  profileId: string;
  provider: string;
  mode: "api_key" | "token" | "oauth";
}): boolean {
  const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
  if (profileConfig && profileConfig.provider !== params.provider) {
    return false;
  }
  if (profileConfig && !isCompatibleAuthModeType(profileConfig.mode, params.mode)) {
    return false;
  }
  return true;
}
