// Update Clawtributors.Types script supports OpenClaw repository automation.
export type MapConfig = {
  ensureLogins?: string[];
  displayName?: Record<string, string>;
  nameToLogin?: Record<string, string>;
  emailToLogin?: Record<string, string>;
  seedCommit?: string;
};

export type ApiContributor = {
  id?: number;
  login?: string;
  html_url?: string;
  avatar_url?: string;
  name?: string;
  email?: string;
  contributions?: number;
};

export type User = {
  id?: number;
  login: string;
  html_url: string;
  avatar_url: string;
};

export type Entry = {
  key: string;
  login?: string;
  display: string;
  html_url: string | null;
  avatar_url: string;
  lines: number;
  commits: number;
  prs: number;
  score: number;
  firstCommitDate: string;
};
