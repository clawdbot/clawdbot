export const CLIENT_ID_KEYS = ["OPENCLAW_GEMINI_OAUTH_CLIENT_ID", "GEMINI_CLI_OAUTH_CLIENT_ID"];
export const CLIENT_SECRET_KEYS = [
  "OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET",
  "GEMINI_CLI_OAUTH_CLIENT_SECRET",
];
export const REDIRECT_URI = "http://localhost:8085/oauth2callback";
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
export const CODE_ASSIST_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";
export const CODE_ASSIST_ENDPOINT_DAILY = "https://daily-cloudcode-pa.sandbox.googleapis.com";
export const CODE_ASSIST_ENDPOINT_AUTOPUSH = "https://autopush-cloudcode-pa.sandbox.googleapis.com";
export const LOAD_CODE_ASSIST_ENDPOINTS = [
  CODE_ASSIST_ENDPOINT_PROD,
  CODE_ASSIST_ENDPOINT_DAILY,
  CODE_ASSIST_ENDPOINT_AUTOPUSH,
];
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
export const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

export const TIER_FREE = "free-tier";
export const TIER_LEGACY = "legacy-tier";
export const TIER_STANDARD = "standard-tier";

export type GeminiCliOAuthCredentials = {
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  projectId?: string;
};

export type GeminiCliOAuthContext = {
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  log: (msg: string) => void;
  note: (message: string, title?: string) => Promise<void>;
  prompt: (message: string) => Promise<string>;
  progress: { update: (msg: string) => void; stop: (msg?: string) => void };
};
