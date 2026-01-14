export type MapConfig = {
  ensureLogins?: string[];
  displayName?: Record<string, string>;
  nameToLogin?: Record<string, string>;
  emailToLogin?: Record<string, string>;
  placeholderAvatar?: string;
  seedCommit?: string;
};

export type ApiContributor = {
  login?: string;
  html_url?: string;
  avatar_url?: string;
  name?: string;
  email?: string;
  contributions?: number;
};

export type User = {
  login: string;
  html_url: string;
  avatar_url: string;
};

export type Entry = {
  key: string;
  login?: string;
  display: string;
  html_url: string;
  avatar_url: string;
  lines: number;
};

