import { normalizeSecretInput } from "../utils/normalize-secret-input.js";

const AWS_BEARER_ENV = "AWS_BEARER_TOKEN_BEDROCK";
const AWS_ACCESS_KEY_ENV = "AWS_ACCESS_KEY_ID";
const AWS_SECRET_KEY_ENV = "AWS_SECRET_ACCESS_KEY";
const AWS_PROFILE_ENV = "AWS_PROFILE";

export type ResolvedProviderAuth = {
  apiKey?: string;
  profileId?: string;
  source: string;
  mode: "api-key" | "oauth" | "token" | "aws-sdk";
};

export type ProviderAuthErrorCode = "missing-api-key" | "missing-provider-auth";

export class ProviderAuthError extends Error {
  readonly code: ProviderAuthErrorCode;
  readonly provider: string;

  constructor(code: ProviderAuthErrorCode, provider: string, message: string) {
    super(message);
    this.name = "ProviderAuthError";
    this.code = code;
    this.provider = provider;
  }
}

export class MissingProviderAuthError extends ProviderAuthError {
  readonly mode: ResolvedProviderAuth["mode"];
  readonly source: string;

  constructor(provider: string, auth: ResolvedProviderAuth) {
    super("missing-api-key", provider, formatMissingAuthError(auth, provider));
    this.name = "MissingProviderAuthError";
    this.mode = auth.mode;
    this.source = auth.source;
  }
}

export function isProviderAuthError(
  err: unknown,
  code?: ProviderAuthErrorCode,
): err is ProviderAuthError {
  return err instanceof ProviderAuthError && (!code || err.code === code);
}

export function isMissingProviderAuthError(err: unknown): err is MissingProviderAuthError {
  return err instanceof MissingProviderAuthError;
}

export function resolveAwsSdkEnvVarName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env[AWS_BEARER_ENV]?.trim()) {
    return AWS_BEARER_ENV;
  }
  if (env[AWS_ACCESS_KEY_ENV]?.trim() && env[AWS_SECRET_KEY_ENV]?.trim()) {
    return AWS_ACCESS_KEY_ENV;
  }
  if (env[AWS_PROFILE_ENV]?.trim()) {
    return AWS_PROFILE_ENV;
  }
  return undefined;
}

export function formatMissingAuthError(auth: ResolvedProviderAuth, provider: string): string {
  return `No API key resolved for provider "${provider}" (auth mode: ${auth.mode}, checked: ${auth.source}).`;
}

export function requireApiKey(auth: ResolvedProviderAuth, provider: string): string {
  const key = normalizeSecretInput(auth.apiKey);
  if (key) {
    return key;
  }
  throw new MissingProviderAuthError(provider, auth);
}
