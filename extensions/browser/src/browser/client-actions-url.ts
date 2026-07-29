/**
 * URL helpers for browser client action requests.
 */
/** Build a query string for profile-scoped browser requests. */
export function buildProfileQuery(profile?: string): string {
  return profile ? `?profile=${encodeURIComponent(profile)}` : "";
}

/** Prefix a browser-control path with an optional base URL. */
export function withBaseUrl(baseUrl: string | undefined, path: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return path;
  }
  return `${trimmed.replace(/\/$/, "")}${path}`;
}
