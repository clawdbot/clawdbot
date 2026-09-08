import type { OAuthCredentials } from "../../llm/utils/oauth/types.js";

export type ApiKeyCredential = {
  type: "api_key";
  key: string;
};

export type OAuthCredential = {
  type: "oauth";
} & OAuthCredentials;

export type TokenCredential = {
  type: "token";
  token: string;
  expires?: number;
};

export type AuthCredential = ApiKeyCredential | OAuthCredential | TokenCredential;

export type AuthStorageData = Record<string, AuthCredential>;

export type LockResult<T> = {
  result: T;
  next?: string;
};

export interface AuthStorageBackend {
  readonly migrationOwnerAgentDir?: string;
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
  withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}
