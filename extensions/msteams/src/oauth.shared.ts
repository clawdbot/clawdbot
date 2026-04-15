export const MSTEAMS_OAUTH_REDIRECT_URI = "http://localhost:8086/oauth2callback";
export const MSTEAMS_OAUTH_CALLBACK_PORT = 8086;
export const MSTEAMS_OAUTH_CALLBACK_PATH = "/oauth2callback";
export const MSTEAMS_DEFAULT_TOKEN_FETCH_TIMEOUT_MS = 10_000;

export const MSTEAMS_DEFAULT_DELEGATED_SCOPES = [
  "ChatMessage.Send",
  "ChannelMessage.Send",
  "Chat.ReadWrite",
  "offline_access",
] as const;

export function buildMSTeamsAuthEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`;
}

export function buildMSTeamsTokenEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

export type MSTeamsDelegatedTokens = {
  accessToken: string;
  refreshToken: string;
  /** Unix ms, 5-min buffer pre-applied */
  expiresAt: number;
  scopes: string[];
  userPrincipalName?: string;
};

export type MSTeamsDelegatedOAuthContext = {
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  log: (msg: string) => void;
  note: (message: string, title?: string) => Promise<void>;
  prompt: (message: string) => Promise<string>;
  progress: { update: (msg: string) => void; stop: (msg?: string) => void };
};
