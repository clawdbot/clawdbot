// Control UI shared URL helpers.
// Normalizes base paths and avatar URLs for browser/gateway surfaces.
import { CONTROL_UI_CHANNEL_AVATAR_PATH_PREFIX } from "./control-ui-contract.js";

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

/** Builds the authenticated conversation-avatar URL for a session. */
export function buildControlUiChannelAvatarUrl(basePath: string, sessionKey: string): string {
  return `${basePath}${CONTROL_UI_CHANNEL_AVATAR_PATH_PREFIX}/${encodeURIComponent(sessionKey)}`;
}

/** URL prefix for gateway-served Control UI avatar assets. */
export { CONTROL_UI_AVATAR_PREFIX };
