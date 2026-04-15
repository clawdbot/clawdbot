export function buildProfileQuery(profile?: string): string {
  return profile ? `?profile=${encodeURIComponent(profile)}` : "";
}

export function withBaseUrl(baseUrl: string | undefined, path: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return path;
  }
  return `${trimmed.replace(/\/$/, "")}${path}`;
}
