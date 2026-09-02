import { z } from "zod";
import { isManagedGitHubProfileId } from "../config/github-identity-profile-id.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  deleteHiddenGitHubSecretRecord,
  listHiddenGitHubSecretRecordNames,
  readHiddenGitHubSecretRecord,
  writeHiddenGitHubSecretRecord,
} from "../secrets/store/secret-store.js";
import {
  githubOAuthTimestamp as timestamp,
  githubOAuthProfileId,
  githubOAuthScopes,
  githubOAuthRefreshFields,
  githubOAuthDeviceFields,
  validGitHubDeviceTiming,
} from "../shared/github-oauth-values.js";
import type { GitHubOAuthTokenPair } from "./github-oauth-client.js";
import type { GitHubToolAccount } from "./github-tool-account.js";

const OAUTH_RECORD_PREFIX = "github-oauth-";
const OPAQUE_ID_PATTERN = /^[a-f0-9]{32}$/u;
const DEVICE_REQUEST_ID_PATTERN = /^github-device-[a-f0-9]{32}$/u;
const requestIdSchema = z.string().regex(DEVICE_REQUEST_ID_PATTERN);
const scope = z.enum(["system", "agent"]);
const agentId = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => normalizeAgentId(value) === value);
const authorValue = z.string().refine((value) => value.trim().length > 0);
// Zod drops __proto__ before strict-object checks; shared records reject that extra key.
function strictRecord<T extends z.ZodRawShape>(shape: T) {
  return z
    .unknown()
    .refine(
      (value) => value === null || typeof value !== "object" || !Object.hasOwn(value, "__proto__"),
    )
    .pipe(z.strictObject(shape));
}
const identityConfig = strictRecord({
  profileId: githubOAuthProfileId,
  kind: z.literal("oauth").optional(),
  gitAuthor: strictRecord({ name: authorValue.optional(), email: authorValue.optional() })
    .refine((author) => Object.keys(author).length > 0)
    .optional(),
}).nullable();
const agentLifecycleBinding = strictRecord({
  agentId,
  provenance: strictRecord({
    agentId,
    createdVia: z.enum(["operator", "agent", "claw"]),
    creatorAgentId: agentId.nullable(),
    createdAtMs: timestamp,
  }).nullable(),
}).refine(
  (binding) => binding.provenance === null || binding.provenance.agentId === binding.agentId,
);
const authorizationFields = {
  agentId,
  scope,
  expectedIdentity: identityConfig,
  // Invalid bindings were historically discarded for System records, but never for agents.
  agentLifecycleBinding: agentLifecycleBinding.optional().catch(undefined),
};
function validAgentBinding(record: z.infer<z.ZodObject<typeof authorizationFields>>): boolean {
  return record.scope === "agent"
    ? record.agentLifecycleBinding?.agentId === record.agentId
    : record.agentLifecycleBinding === undefined;
}
function omitMissingAgentBinding<T extends { agentLifecycleBinding?: unknown }>(record: T): T {
  if (record.agentLifecycleBinding === undefined) {
    delete record.agentLifecycleBinding;
  }
  return record;
}
const deviceRecordSchema = strictRecord({
  version: z.literal(1),
  requestId: requestIdSchema,
  ...githubOAuthDeviceFields,
  ...authorizationFields,
})
  .refine(validAgentBinding)
  .refine(validGitHubDeviceTiming)
  .transform(omitMissingAgentBinding);
const pendingInitialSchema = strictRecord({
  requestId: requestIdSchema,
  scope,
  agentId,
  expectedIdentity: identityConfig,
  agentLifecycleBinding: authorizationFields.agentLifecycleBinding,
})
  .refine(validAgentBinding)
  .transform(omitMissingAgentBinding);
const oauthRecordSchema = strictRecord({
  version: z.literal(1),
  profileId: githubOAuthProfileId,
  agentId,
  scope,
  ...githubOAuthRefreshFields,
  scopes: githubOAuthScopes.refine((values) => {
    // Shared records require canonical ordering; personal records preserve their scope order.
    const canonical = [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
    return (
      canonical.length === values.length &&
      canonical.every((value, index) => value === values[index])
    );
  }),
  createdAtMs: timestamp,
  pendingInitial: pendingInitialSchema.optional(),
  pendingRefresh: z.literal(true).optional(),
  refreshFailure: z.enum(["expired", "failed"]).optional(),
}).refine(
  (record) =>
    record.accessExpiresAtMs > record.createdAtMs &&
    record.refreshExpiresAtMs > record.accessExpiresAtMs &&
    (!record.pendingInitial ||
      (record.pendingInitial.scope === record.scope &&
        record.pendingInitial.agentId === record.agentId)) &&
    !(record.pendingInitial && record.pendingRefresh) &&
    !(record.pendingRefresh && record.refreshFailure),
);

export type GitHubIdentityScope = z.infer<typeof scope>;
export type GitHubDeviceAuthorizationRecord = Readonly<z.infer<typeof deviceRecordSchema>>;
type GitHubOAuthPendingInitial = Readonly<z.infer<typeof pendingInitialSchema>>;
export type GitHubOAuthRecord = Readonly<Omit<z.infer<typeof oauthRecordSchema>, "scopes">> & {
  readonly scopes: readonly string[];
};

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

function parseGitHubRecord<T>(raw: string, schema: z.ZodType<T>): T | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function writeGitHubDeviceAuthorizationRecord(
  record: GitHubDeviceAuthorizationRecord,
): void {
  const parsed = parseGitHubRecord(JSON.stringify(record), deviceRecordSchema);
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
  const record = raw === undefined ? undefined : parseGitHubRecord(raw, deviceRecordSchema);
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
  const parsed = parseGitHubRecord(JSON.stringify(record), oauthRecordSchema);
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
  const record = raw === undefined ? undefined : parseGitHubRecord(raw, oauthRecordSchema);
  return record?.profileId === profileId ? record : undefined;
}

export function inspectGitHubOAuthRecord(
  profileId: string,
): { state: "missing" } | { state: "invalid" } | { state: "valid"; record: GitHubOAuthRecord } {
  const raw = readHiddenGitHubSecretRecord({ name: githubOAuthRecordName(profileId) });
  if (raw === undefined) {
    return { state: "missing" };
  }
  const record = parseGitHubRecord(raw, oauthRecordSchema);
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
