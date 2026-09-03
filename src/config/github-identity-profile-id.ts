export const MANAGED_GITHUB_PROFILE_ID_PATTERN = /^ghp_[a-f0-9]{32}$/u;

export function isManagedGitHubProfileId(value: string): boolean {
  return MANAGED_GITHUB_PROFILE_ID_PATTERN.test(value);
}
