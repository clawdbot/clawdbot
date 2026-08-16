const USER_PROFILE_AVATAR_PATH = /^\/api\/users\/([^/]+)\/avatar$/u;

export function formatUserProfileAvatarPath(profileId: string, revision?: string | number): string {
  const path = `/api/users/${encodeURIComponent(profileId)}/avatar`;
  return revision === undefined ? path : `${path}?v=${encodeURIComponent(String(revision))}`;
}

export function matchUserProfileAvatarPath(pathname: string): string | undefined {
  const profileId = USER_PROFILE_AVATAR_PATH.exec(pathname)?.[1];
  if (!profileId) {
    return undefined;
  }
  try {
    return decodeURIComponent(profileId);
  } catch {
    return undefined;
  }
}

export function canonicalizeUserProfileAvatarPath(
  pathname: string,
  controlUiBasePath: string,
): string | undefined {
  if (matchUserProfileAvatarPath(pathname) !== undefined) {
    return pathname;
  }
  if (!controlUiBasePath || !pathname.startsWith(`${controlUiBasePath}/`)) {
    return undefined;
  }
  const canonicalPath = pathname.slice(controlUiBasePath.length);
  return matchUserProfileAvatarPath(canonicalPath) !== undefined ? canonicalPath : undefined;
}
