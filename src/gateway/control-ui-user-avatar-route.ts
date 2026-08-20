import { normalizeControlUiBasePath } from "./control-ui-shared.js";

export const CONTROL_UI_USER_AVATAR_PATH_PREFIX = "/api/users/";
export const CONTROL_UI_USER_AVATAR_PATH_SUFFIX = "/avatar";

export function buildControlUiUserAvatarPath(
  profileId: string,
  revision?: string | number,
  basePath?: string | null,
): string {
  const path = `${normalizeControlUiBasePath(basePath)}${CONTROL_UI_USER_AVATAR_PATH_PREFIX}${encodeURIComponent(profileId)}${CONTROL_UI_USER_AVATAR_PATH_SUFFIX}`;
  return revision === undefined ? path : `${path}?v=${encodeURIComponent(String(revision))}`;
}

/**
 * Canonicalizes valid browser avatar URLs. Gateway malformed-route ownership
 * stays in the general resource parser so lazy-only route grammar remains out of startup.
 */
export function canonicalizeControlUiUserAvatarPath(
  pathname: string,
  basePath: string,
): string | undefined {
  const normalizedBasePath = normalizeControlUiBasePath(basePath);
  const canonicalPathname = pathname.startsWith(CONTROL_UI_USER_AVATAR_PATH_PREFIX)
    ? pathname
    : normalizedBasePath &&
        pathname.startsWith(`${normalizedBasePath}${CONTROL_UI_USER_AVATAR_PATH_PREFIX}`)
      ? pathname.slice(normalizedBasePath.length)
      : "";
  if (!canonicalPathname.endsWith(CONTROL_UI_USER_AVATAR_PATH_SUFFIX)) {
    return undefined;
  }
  const encoded = canonicalPathname.slice(
    CONTROL_UI_USER_AVATAR_PATH_PREFIX.length,
    -CONTROL_UI_USER_AVATAR_PATH_SUFFIX.length,
  );
  if (!encoded || encoded.includes("/")) {
    return undefined;
  }
  try {
    decodeURIComponent(encoded);
    return canonicalPathname;
  } catch {
    return undefined;
  }
}
