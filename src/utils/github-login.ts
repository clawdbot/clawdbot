const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;

export function normalizeGitHubLogin(value: string): string | undefined {
  const login = value.trim();
  return GITHUB_LOGIN_PATTERN.test(login) ? login : undefined;
}
