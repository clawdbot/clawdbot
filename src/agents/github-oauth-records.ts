import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isManagedGitHubProfileId } from "../config/github-identity-profile-id.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  deleteHiddenGitHubSecretRecord,
  listHiddenGitHubSecretRecordNames,
  readHiddenGitHubSecretRecord,
  writeHiddenGitHubSecretRecord,
} from "../secrets/store/secret-store.js";
import type { AgentLifecycleBinding } from "./agent-lifecycle-registry.js";
import type { GitHubOAuthTokenPair } from "./github-oauth-client.js";
import type { GitHubToolAccount } from "./github-tool-account.js";

const GITHUB_DEVICE_VERIFICATION_URI = "https://github.com/login/device";
const OAUTH_RECORD_PREFIX = "github-oauth-";
const OPAQUE_ID_PATTERN = /^[a-f0-9]{32}$/u;
const DEVICE_REQUEST_ID_PATTERN = /^github-device-[a-f0-9]{32}$/u;
const DEVICE_CODE_PATTERN = /^[A-Za-z0-9_-]{40}$/u;
const USER_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/u;
const MAX_DEVICE_LIFETIME_MS = 15 * 60_000;
const MAX_POLL_INTERVAL_MS = 60_000;
const MAX_TOKEN_LENGTH = 2_048;
const MAX_SCOPE_COUNT = 32;
const MAX_SCOPE_LENGTH = 64;

export type GitHubIdentityScope = "system" | "agent";

export type GitHubDeviceAuthorizationRecord = Readonly<{
  version: 1;
  requestId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: typeof GITHUB_DEVICE_VERIFICATION_URI;
  createdAtMs: number;
  expiresAtMs: number;
  pollIntervalMs: number;
  nextPollAtMs: number;
  agentId: string;
  scope: GitHubIdentityScope;
  expectedIdentity: GitHubToolIdentityConfig | null;
  agentLifecycleBinding?: AgentLifecycleBinding;
}>;

type GitHubOAuthPendingInitial = Readonly<{
  requestId: string;
  scope: GitHubIdentityScope;
  agentId: string;
  expectedIdentity: GitHubToolIdentityConfig | null;
  agentLifecycleBinding?: AgentLifecycleBinding;
}>;

export type GitHubOAuthRecord = Readonly<{
  version: 1;
  profileId: string;
  agentId: string;
  scope: GitHubIdentityScope;
  accountId: number;
  login: string;
  refreshToken: string;
  accessExpiresAtMs: number;
  refreshExpiresAtMs: number;
  scopes: readonly string[];
  createdAtMs: number;
  pendingInitial?: GitHubOAuthPendingInitial;
  pendingRefresh?: true;
  refreshFailure?: "expired" | "failed";
}>;

export function createGitHubOAuthRecord(params: {
  profileId: string;
  scope: GitHubIdentityScope;
  agentId: string;
  account: GitHubToolAccount;
  tokens: GitHubOAuthTokenPair;
  now: number;
  pendingInitial?: GitHubOAuthPendingInitial;
  pendingRefresh?: true;
}): GitHubOAuthRecord {
  return {
    version: 1,
    profileId: params.profileId,
    scope: params.scope,
    agentId: params.agentId,
    accountId: params.account.accountId,
    login: params.account.login,
    refreshToken: params.tokens.refreshToken,
    accessExpiresAtMs: params.now + params.tokens.expiresInSeconds * 1_000,
    refreshExpiresAtMs: params.now + params.tokens.refreshTokenExpiresInSeconds * 1_000,
    scopes: params.tokens.scopes,
    createdAtMs: params.now,
    ...(params.pendingInitial ? { pendingInitial: params.pendingInitial } : {}),
    ...(params.pendingRefresh ? { pendingRefresh: true } : {}),
  };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseIdentityConfig(value: unknown): GitHubToolIdentityConfig | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const keys = [
    ...(value.gitAuthor === undefined ? [] : ["gitAuthor"]),
    ...(value.kind === undefined ? [] : ["kind"]),
    "profileId",
  ].toSorted();
  const profileId = typeof value.profileId === "string" ? value.profileId : "";
  if (
    !hasExactKeys(value, keys) ||
    !isManagedGitHubProfileId(profileId) ||
    (value.kind !== undefined && value.kind !== "oauth")
  ) {
    return undefined;
  }
  if (value.gitAuthor === undefined) {
    return { profileId, ...(value.kind === "oauth" ? { kind: "oauth" } : {}) };
  }
  if (!isRecord(value.gitAuthor)) {
    return undefined;
  }
  const authorKeys = Object.keys(value.gitAuthor).toSorted();
  if (
    authorKeys.length === 0 ||
    authorKeys.some((key) => key !== "email" && key !== "name") ||
    (value.gitAuthor.name !== undefined &&
      (typeof value.gitAuthor.name !== "string" || !value.gitAuthor.name.trim())) ||
    (value.gitAuthor.email !== undefined &&
      (typeof value.gitAuthor.email !== "string" || !value.gitAuthor.email.trim()))
  ) {
    return undefined;
  }
  return {
    profileId,
    ...(value.kind === "oauth" ? { kind: "oauth" } : {}),
    gitAuthor: {
      ...(typeof value.gitAuthor.name === "string" ? { name: value.gitAuthor.name } : {}),
      ...(typeof value.gitAuthor.email === "string" ? { email: value.gitAuthor.email } : {}),
    },
  };
}

function parseScope(value: unknown): GitHubIdentityScope | undefined {
  return value === "system" || value === "agent" ? value : undefined;
}

function parseCanonicalAgentId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 128) {
    return undefined;
  }
  const normalized = normalizeAgentId(value);
  return normalized === value ? value : undefined;
}

function parseAgentLifecycleBinding(value: unknown): AgentLifecycleBinding | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["agentId", "provenance"])) {
    return undefined;
  }
  const agentId = parseCanonicalAgentId(value.agentId);
  if (!agentId) {
    return undefined;
  }
  if (value.provenance === null) {
    return { agentId, provenance: null };
  }
  if (
    !isRecord(value.provenance) ||
    !hasExactKeys(value.provenance, ["agentId", "createdAtMs", "createdVia", "creatorAgentId"])
  ) {
    return undefined;
  }
  const provenanceAgentId = parseCanonicalAgentId(value.provenance.agentId);
  const creatorAgentId =
    value.provenance.creatorAgentId === null
      ? null
      : parseCanonicalAgentId(value.provenance.creatorAgentId);
  if (
    provenanceAgentId !== agentId ||
    (value.provenance.createdVia !== "operator" &&
      value.provenance.createdVia !== "agent" &&
      value.provenance.createdVia !== "claw") ||
    creatorAgentId === undefined ||
    !isTimestamp(value.provenance.createdAtMs)
  ) {
    return undefined;
  }
  return {
    agentId,
    provenance: {
      agentId,
      createdVia: value.provenance.createdVia,
      creatorAgentId,
      createdAtMs: value.provenance.createdAtMs,
    },
  };
}

function githubDeviceRecordName(requestId: string): string {
  if (!DEVICE_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error("GitHub device authorization request id is invalid.");
  }
  return requestId;
}

function githubOAuthRecordName(profileId: string): string {
  if (!isManagedGitHubProfileId(profileId)) {
    throw new Error("Managed GitHub profile id is invalid.");
  }
  return `${OAUTH_RECORD_PREFIX}${profileId.slice("ghp_".length)}`;
}

function parseGitHubOAuthProfileId(name: string): string | undefined {
  const opaqueId = name.startsWith(OAUTH_RECORD_PREFIX)
    ? name.slice(OAUTH_RECORD_PREFIX.length)
    : "";
  return OPAQUE_ID_PATTERN.test(opaqueId) ? `ghp_${opaqueId}` : undefined;
}

function parseGitHubDeviceAuthorizationRecord(
  raw: string,
): GitHubDeviceAuthorizationRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const expectedIdentity = parseIdentityConfig(value.expectedIdentity);
  const scope = parseScope(value.scope);
  const agentId = parseCanonicalAgentId(value.agentId);
  const agentLifecycleBinding =
    value.agentLifecycleBinding === undefined
      ? undefined
      : parseAgentLifecycleBinding(value.agentLifecycleBinding);
  const keys = [
    "agentId",
    ...(value.agentLifecycleBinding === undefined ? [] : ["agentLifecycleBinding"]),
    "createdAtMs",
    "deviceCode",
    "expectedIdentity",
    "expiresAtMs",
    "nextPollAtMs",
    "pollIntervalMs",
    "requestId",
    "scope",
    "userCode",
    "verificationUri",
    "version",
  ].toSorted();
  if (
    !hasExactKeys(value, keys) ||
    value.version !== 1 ||
    typeof value.requestId !== "string" ||
    !DEVICE_REQUEST_ID_PATTERN.test(value.requestId) ||
    typeof value.deviceCode !== "string" ||
    !DEVICE_CODE_PATTERN.test(value.deviceCode) ||
    typeof value.userCode !== "string" ||
    !USER_CODE_PATTERN.test(value.userCode) ||
    value.verificationUri !== GITHUB_DEVICE_VERIFICATION_URI ||
    !isTimestamp(value.createdAtMs) ||
    !isTimestamp(value.expiresAtMs) ||
    value.expiresAtMs <= value.createdAtMs ||
    value.expiresAtMs - value.createdAtMs > MAX_DEVICE_LIFETIME_MS ||
    !isTimestamp(value.pollIntervalMs) ||
    value.pollIntervalMs < 1_000 ||
    value.pollIntervalMs > MAX_POLL_INTERVAL_MS ||
    !isTimestamp(value.nextPollAtMs) ||
    value.nextPollAtMs < value.createdAtMs ||
    value.nextPollAtMs > value.expiresAtMs ||
    !agentId ||
    !scope ||
    (scope === "agent"
      ? !agentLifecycleBinding || agentLifecycleBinding.agentId !== agentId
      : agentLifecycleBinding !== undefined) ||
    expectedIdentity === undefined
  ) {
    return undefined;
  }
  return {
    version: 1,
    requestId: value.requestId,
    deviceCode: value.deviceCode,
    userCode: value.userCode,
    verificationUri: GITHUB_DEVICE_VERIFICATION_URI,
    createdAtMs: value.createdAtMs,
    expiresAtMs: value.expiresAtMs,
    pollIntervalMs: value.pollIntervalMs,
    nextPollAtMs: value.nextPollAtMs,
    agentId,
    scope,
    expectedIdentity,
    ...(agentLifecycleBinding ? { agentLifecycleBinding } : {}),
  };
}

function parseScopes(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length > MAX_SCOPE_COUNT ||
    value.some(
      (scope) =>
        typeof scope !== "string" ||
        scope.length < 1 ||
        scope.length > MAX_SCOPE_LENGTH ||
        !/^[a-z0-9:_-]+$/u.test(scope),
    )
  ) {
    return undefined;
  }
  const normalized = [...new Set(value)].toSorted((left, right) => left.localeCompare(right));
  return normalized.length === value.length &&
    normalized.every((scope, index) => scope === value[index])
    ? normalized
    : undefined;
}

function parsePendingInitial(value: unknown): GitHubOAuthPendingInitial | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const expectedIdentity = parseIdentityConfig(value.expectedIdentity);
  const scope = parseScope(value.scope);
  const agentId = parseCanonicalAgentId(value.agentId);
  const agentLifecycleBinding =
    value.agentLifecycleBinding === undefined
      ? undefined
      : parseAgentLifecycleBinding(value.agentLifecycleBinding);
  const keys = [
    "agentId",
    ...(value.agentLifecycleBinding === undefined ? [] : ["agentLifecycleBinding"]),
    "expectedIdentity",
    "requestId",
    "scope",
  ].toSorted();
  if (
    !hasExactKeys(value, keys) ||
    typeof value.requestId !== "string" ||
    !DEVICE_REQUEST_ID_PATTERN.test(value.requestId) ||
    !scope ||
    !agentId ||
    expectedIdentity === undefined ||
    (scope === "agent"
      ? !agentLifecycleBinding || agentLifecycleBinding.agentId !== agentId
      : agentLifecycleBinding !== undefined)
  ) {
    return undefined;
  }
  return {
    requestId: value.requestId,
    scope,
    agentId,
    expectedIdentity,
    ...(agentLifecycleBinding ? { agentLifecycleBinding } : {}),
  };
}

function parseGitHubOAuthRecord(raw: string): GitHubOAuthRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const required = [
    "accessExpiresAtMs",
    "accountId",
    "agentId",
    "createdAtMs",
    "login",
    "profileId",
    "refreshExpiresAtMs",
    "refreshToken",
    "scope",
    "scopes",
    "version",
  ];
  const keys = [
    ...required,
    ...(value.pendingInitial === undefined ? [] : ["pendingInitial"]),
    ...(value.pendingRefresh === undefined ? [] : ["pendingRefresh"]),
    ...(value.refreshFailure === undefined ? [] : ["refreshFailure"]),
  ];
  const scope = parseScope(value.scope);
  const agentId = parseCanonicalAgentId(value.agentId);
  const scopes = parseScopes(value.scopes);
  const profileId = typeof value.profileId === "string" ? value.profileId : "";
  const pendingInitial =
    value.pendingInitial === undefined ? undefined : parsePendingInitial(value.pendingInitial);
  if (
    !hasExactKeys(value, keys.toSorted()) ||
    value.version !== 1 ||
    !isManagedGitHubProfileId(profileId) ||
    (value.pendingInitial !== undefined &&
      (!pendingInitial || pendingInitial.scope !== scope || pendingInitial.agentId !== agentId)) ||
    (value.pendingRefresh !== undefined && value.pendingRefresh !== true) ||
    (value.pendingInitial !== undefined && value.pendingRefresh !== undefined) ||
    (value.pendingRefresh !== undefined && value.refreshFailure !== undefined) ||
    (value.refreshFailure !== undefined &&
      value.refreshFailure !== "expired" &&
      value.refreshFailure !== "failed") ||
    !agentId ||
    !scope ||
    !Number.isSafeInteger(value.accountId) ||
    Number(value.accountId) <= 0 ||
    typeof value.login !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value.login) ||
    typeof value.refreshToken !== "string" ||
    value.refreshToken.length < 1 ||
    value.refreshToken.length > MAX_TOKEN_LENGTH ||
    /[\r\n]/u.test(value.refreshToken) ||
    !isTimestamp(value.createdAtMs) ||
    !isTimestamp(value.accessExpiresAtMs) ||
    !isTimestamp(value.refreshExpiresAtMs) ||
    value.accessExpiresAtMs <= value.createdAtMs ||
    value.refreshExpiresAtMs <= value.accessExpiresAtMs ||
    !scopes
  ) {
    return undefined;
  }
  return {
    version: 1,
    profileId,
    agentId,
    scope,
    accountId: Number(value.accountId),
    login: value.login,
    refreshToken: value.refreshToken,
    accessExpiresAtMs: value.accessExpiresAtMs,
    refreshExpiresAtMs: value.refreshExpiresAtMs,
    scopes,
    createdAtMs: value.createdAtMs,
    ...(pendingInitial ? { pendingInitial } : {}),
    ...(value.pendingRefresh === true ? { pendingRefresh: true } : {}),
    ...(value.refreshFailure === "expired" || value.refreshFailure === "failed"
      ? { refreshFailure: value.refreshFailure }
      : {}),
  };
}

export function writeGitHubDeviceAuthorizationRecord(
  record: GitHubDeviceAuthorizationRecord,
): void {
  const parsed = parseGitHubDeviceAuthorizationRecord(JSON.stringify(record));
  if (!parsed || parsed.requestId !== record.requestId) {
    throw new Error("GitHub device authorization record is invalid.");
  }
  writeHiddenGitHubSecretRecord({
    name: githubDeviceRecordName(record.requestId),
    value: JSON.stringify(parsed),
  });
}

export function readGitHubDeviceAuthorizationRecord(
  requestId: string,
): GitHubDeviceAuthorizationRecord | undefined {
  const raw = readHiddenGitHubSecretRecord({ name: githubDeviceRecordName(requestId) });
  const record = raw === undefined ? undefined : parseGitHubDeviceAuthorizationRecord(raw);
  return record?.requestId === requestId ? record : undefined;
}

export function deleteGitHubDeviceAuthorizationRecord(requestId: string): void {
  deleteHiddenGitHubSecretRecord({ name: githubDeviceRecordName(requestId) });
}

export function listGitHubDeviceAuthorizationRecords(): Array<{
  requestId: string;
  record: GitHubDeviceAuthorizationRecord | undefined;
}> {
  return listHiddenGitHubSecretRecordNames({ prefix: "github-device" }).flatMap((name) => {
    const requestId = name;
    if (!DEVICE_REQUEST_ID_PATTERN.test(requestId)) {
      return [];
    }
    return [{ requestId, record: readGitHubDeviceAuthorizationRecord(requestId) }];
  });
}

export function writeGitHubOAuthRecord(record: GitHubOAuthRecord): void {
  const parsed = parseGitHubOAuthRecord(JSON.stringify(record));
  if (!parsed || parsed.profileId !== record.profileId) {
    throw new Error("GitHub OAuth record is invalid.");
  }
  writeHiddenGitHubSecretRecord({
    name: githubOAuthRecordName(record.profileId),
    value: JSON.stringify(parsed),
  });
}

function readGitHubOAuthRecord(profileId: string): GitHubOAuthRecord | undefined {
  const raw = readHiddenGitHubSecretRecord({ name: githubOAuthRecordName(profileId) });
  const record = raw === undefined ? undefined : parseGitHubOAuthRecord(raw);
  return record?.profileId === profileId ? record : undefined;
}

export function inspectGitHubOAuthRecord(
  profileId: string,
): { state: "missing" } | { state: "invalid" } | { state: "valid"; record: GitHubOAuthRecord } {
  const raw = readHiddenGitHubSecretRecord({ name: githubOAuthRecordName(profileId) });
  if (raw === undefined) {
    return { state: "missing" };
  }
  const record = parseGitHubOAuthRecord(raw);
  return record?.profileId === profileId ? { state: "valid", record } : { state: "invalid" };
}

export function deleteGitHubOAuthRecord(profileId: string): void {
  deleteHiddenGitHubSecretRecord({ name: githubOAuthRecordName(profileId) });
}

export function listGitHubOAuthRecords(): Array<{
  profileId: string;
  record: GitHubOAuthRecord | undefined;
}> {
  return listHiddenGitHubSecretRecordNames({ prefix: "github-oauth" }).flatMap((name) => {
    const profileId = parseGitHubOAuthProfileId(name);
    if (!profileId) {
      return [];
    }
    return [{ profileId, record: readGitHubOAuthRecord(profileId) }];
  });
}
