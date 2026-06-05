// Control UI shared URL helpers.
// Normalizes base paths and avatar URLs for browser/gateway surfaces.
import {
  isAvatarHttpUrl,
  isAvatarImageDataUrl,
  looksLikeAvatarPath,
} from "../shared/avatar-policy.js";

const CONTROL_UI_AVATAR_PREFIX = "/avatar";

/** Normalizes a Control UI base path to either "" or a leading-slash path without trailing slash. */
export function normalizeControlUiBasePath(basePath?: string): string {
  if (!basePath) {
    return "";
  }
  let normalized = basePath.trim();
  if (!normalized) {
    return "";
  }
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized === "/") {
    return "";
  }
  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/** Builds the gateway-served avatar URL for an agent under the provided base path. */
export function buildControlUiAvatarUrl(basePath: string, agentId: string): string {
  return basePath
    ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/${agentId}`
    : `${CONTROL_UI_AVATAR_PREFIX}/${agentId}`;
}

/** Resolves the assistant avatar URL that Control UI should render for the active agent. */
export function resolveAssistantAvatarUrl(params: {
  avatar?: string | null;
  agentId?: string | null;
  basePath?: string;
}): string | undefined {
  const avatar = params.avatar?.trim();
  if (!avatar) {
    return undefined;
  }
  if (isAvatarHttpUrl(avatar) || isAvatarImageDataUrl(avatar)) {
    return avatar;
  }

  const basePath = normalizeControlUiBasePath(params.basePath);
  const baseAvatarPrefix = basePath
    ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/`
    : `${CONTROL_UI_AVATAR_PREFIX}/`;
  if (basePath && avatar.startsWith(`${CONTROL_UI_AVATAR_PREFIX}/`)) {
    return `${basePath}${avatar}`;
  }
  if (avatar.startsWith(baseAvatarPrefix)) {
    return avatar;
  }

  if (!params.agentId) {
    return avatar;
  }
  // Local filesystem-ish avatar config is exposed through the gateway avatar
  // route instead of being handed directly to the browser.
  if (looksLikeAvatarPath(avatar)) {
    return buildControlUiAvatarUrl(basePath, params.agentId);
  }
  return avatar;
}

/** URL prefix for gateway-served Control UI avatar assets. */
export { CONTROL_UI_AVATAR_PREFIX };
