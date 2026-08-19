import { createHash, createPublicKey, verify } from "node:crypto";
import type {
  EnterpriseIdentityProviderAdapter,
  EnterpriseIdentityProviderAuthority,
  EnterpriseIdentityMembershipClaim,
  EnterpriseIdentityDirectoryAccessTokenResult,
} from "../plugins/enterprise-identity-provider-types.js";
import {
  persistMemoryEnterpriseIdentity,
  type MemoryEnterpriseMembershipSnapshot,
  type MemoryEnterprisePrincipal,
} from "./memory-enterprise-identity.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";

type JsonRecord = Record<string, unknown>;
const MAX_ENTERPRISE_GROUPS_PER_SNAPSHOT = 1_000;
const MAX_DIRECTORY_MEMBERSHIP_PAGES = 100;
const JWKS_CACHE_TTL_MS = 5 * 60_000;
const jwksByUri = new Map<string, Readonly<{ expiresAt: number; jwks: EnterpriseOidcJwks }>>();

/** Test lifecycle hook; production authority snapshots deliberately keep the bounded JWKS cache. */
export function clearEnterpriseOidcJwksCacheForTest(): void {
  jwksByUri.clear();
}

// Node's WebCrypto `JsonWebKey` intentionally omits JOSE's key-id extension;
// the issuer's JWKS contract supplies it and we use it only for key selection.
export type EnterpriseOidcJsonWebKey = JsonWebKey & Readonly<{ kid?: string }>;

export type EnterpriseOidcJwks = Readonly<{ keys: readonly EnterpriseOidcJsonWebKey[] }>;

export type VerifiedEnterpriseOidcIdentity = Readonly<{
  providerId: string;
  issuer: string;
  tenant: string;
  subject: string;
  groups: readonly string[];
  evidenceRevision: string;
  observedAt: number;
  expiresAt: number;
}>;

export type EnterpriseOidcVerification =
  | Readonly<{ kind: "verified"; identity: VerifiedEnterpriseOidcIdentity }>
  | Readonly<{
      kind: "denied";
      reason:
        | "malformed-token"
        | "unsupported-algorithm"
        | "unknown-key"
        | "invalid-signature"
        | "wrong-issuer"
        | "wrong-audience"
        | "wrong-tenant"
        | "wrong-nonce"
        | "missing-required-claim"
        | "wrong-assurance"
        | "expired"
        | "not-yet-valid"
        | "stale-snapshot"
        | "missing-subject"
        | "invalid-groups"
        | "incomplete-membership-snapshot"
        | "provider-unavailable";
    }>;

export type PersistedEnterpriseOidcIdentity = Readonly<{
  principal: MemoryEnterprisePrincipal;
  memberships: readonly MemoryEnterpriseMembershipSnapshot[];
}>;

function base64urlJson(value: string): JsonRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

function readText(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readTimestamp(record: JsonRecord, key: string): number | undefined {
  const seconds = record[key];
  return typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 0
    ? seconds * 1_000
    : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    return undefined;
  }
  return Object.freeze([...new Set(value)].toSorted());
}

function readAudiences(value: unknown): readonly string[] | undefined {
  if (typeof value === "string" && value.trim()) {
    return Object.freeze([value]);
  }
  return readStringArray(value);
}

function hasAuthorizedParty(
  audiences: readonly string[],
  claims: JsonRecord,
  authority: EnterpriseIdentityProviderAuthority,
): boolean {
  const clientId = authority.authorizationCodeFlow.clientId;
  if (!audiences.includes(clientId)) {
    return false;
  }
  const azp = readText(claims, "azp");
  if (azp !== undefined && azp !== clientId) {
    return false;
  }
  return audiences.length <= 1 || azp === clientId;
}

function readGroups(
  value: unknown,
  maxGroups: number,
  roleGroupIds: readonly string[],
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  if (value.length > Math.min(maxGroups, MAX_ENTERPRISE_GROUPS_PER_SNAPSHOT)) {
    return undefined;
  }
  const allowedGroups = new Set(roleGroupIds);
  const groups = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      return undefined;
    }
    if (allowedGroups.has(entry)) {
      groups.add(entry);
    }
  }
  return Object.freeze([...groups].toSorted());
}

function hasIncompleteMembershipIndicator(
  claims: JsonRecord,
  membership: EnterpriseIdentityMembershipClaim,
): boolean {
  return (membership.incompleteIndicators ?? []).some((indicator) => {
    const value = claims[indicator.claim];
    if (indicator.kind === "truthy-claim") {
      return Boolean(value);
    }
    return Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as JsonRecord)[indicator.key],
    );
  });
}

type MembershipResolution =
  | Readonly<{ kind: "verified"; groups: readonly string[] }>
  | Readonly<{
      kind: "denied";
      reason: "invalid-groups" | "incomplete-membership-snapshot" | "provider-unavailable";
    }>;

async function resolveGoogleWorkspaceDirectoryGroups(params: {
  adapter: EnterpriseIdentityProviderAdapter;
  authority: EnterpriseIdentityProviderAuthority;
  claims: JsonRecord;
}): Promise<MembershipResolution> {
  const membership = params.authority.membership;
  if (membership.kind !== "google-workspace-directory") {
    throw new Error("Google Workspace membership resolution requires directory authority");
  }
  const email = readText(params.claims, membership.verifiedEmailClaim);
  if (!email || !params.adapter.acquireDirectoryAccessToken) {
    return { kind: "denied", reason: "incomplete-membership-snapshot" };
  }
  let access: EnterpriseIdentityDirectoryAccessTokenResult;
  try {
    access = await params.adapter.acquireDirectoryAccessToken();
  } catch {
    return { kind: "denied", reason: "provider-unavailable" };
  }
  if (access.kind !== "available" || !access.accessToken.trim()) {
    return { kind: "denied", reason: "provider-unavailable" };
  }
  const allowedGroups = new Set(membership.roleGroupResourceNames);
  const groups = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_DIRECTORY_MEMBERSHIP_PAGES; page += 1) {
    const url = new URL(
      "https://cloudidentity.googleapis.com/v1/groups/-/memberships:searchTransitiveGroups",
    );
    url.searchParams.set(
      "query",
      `member_key_id == '${email.replaceAll("'", "\\'")}' && 'cloudidentity.googleapis.com/groups.discussion_forum' in labels`,
    );
    if (membership.customerId) {
      url.searchParams.set(
        "query",
        `${url.searchParams.get("query")} && parent == 'customers/${membership.customerId}'`,
      );
    }
    url.searchParams.set("pageSize", "1000");
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: "application/json", authorization: `Bearer ${access.accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return { kind: "denied", reason: "provider-unavailable" };
    }
    if (!response.ok) {
      return { kind: "denied", reason: "provider-unavailable" };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { kind: "denied", reason: "invalid-groups" };
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { kind: "denied", reason: "invalid-groups" };
    }
    const record = payload as JsonRecord;
    const memberships = record.memberships;
    if (!Array.isArray(memberships) || memberships.length > 1_000) {
      return { kind: "denied", reason: "invalid-groups" };
    }
    for (const entry of memberships) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return { kind: "denied", reason: "invalid-groups" };
      }
      const group = (entry as JsonRecord).group;
      if (typeof group !== "string" || !group.startsWith("groups/")) {
        return { kind: "denied", reason: "invalid-groups" };
      }
      if (allowedGroups.has(group)) {
        groups.add(group);
        if (
          groups.size > membership.maxGroups ||
          groups.size > MAX_ENTERPRISE_GROUPS_PER_SNAPSHOT
        ) {
          return { kind: "denied", reason: "invalid-groups" };
        }
      }
    }
    const nextPageToken = record.nextPageToken;
    if (nextPageToken === undefined) {
      return { kind: "verified", groups: Object.freeze([...groups].toSorted()) };
    }
    if (typeof nextPageToken !== "string" || !nextPageToken) {
      return { kind: "denied", reason: "invalid-groups" };
    }
    pageToken = nextPageToken;
  }
  return { kind: "denied", reason: "invalid-groups" };
}

function hasRequiredClaims(
  claims: JsonRecord,
  requiredClaims: readonly { claim: string; value: string | boolean }[] | undefined,
): boolean {
  return (requiredClaims ?? []).every((required) => claims[required.claim] === required.value);
}

function hasRequiredAssurance(
  claims: JsonRecord,
  authority: EnterpriseIdentityProviderAuthority,
  now: number,
): boolean {
  const authenticatedAt = readTimestamp(claims, "auth_time");
  if (
    authenticatedAt === undefined ||
    authenticatedAt > now ||
    now - authenticatedAt > authority.assurance.maxAuthenticationAgeMs
  ) {
    return false;
  }
  const acceptedAcrValues = authority.assurance.acceptedAcrValues ?? [];
  if (acceptedAcrValues.length > 0 && !acceptedAcrValues.includes(readText(claims, "acr") ?? "")) {
    return false;
  }
  const requiredAmrValues = authority.assurance.requiredAmrValues ?? [];
  const amr = readStringArray(claims.amr);
  return (
    requiredAmrValues.length === 0 ||
    Boolean(amr && requiredAmrValues.every((value) => amr.includes(value)))
  );
}

function selectAuthority(
  adapter: EnterpriseIdentityProviderAdapter,
  issuer: string,
): EnterpriseIdentityProviderAuthority | undefined {
  return adapter.authorities.find(
    (authority) => authority.issuer === issuer || authority.acceptedIssuerAliases?.includes(issuer),
  );
}

async function resolveRegisteredJwks(
  jwksUri: string,
  now: number,
  forceRefresh = false,
): Promise<EnterpriseOidcJwks | undefined> {
  const cached = jwksByUri.get(jwksUri);
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.jwks;
  }
  try {
    const response = await fetch(jwksUri, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return undefined;
    }
    const parsed: unknown = await response.json();
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { keys?: unknown }).keys)
    ) {
      return undefined;
    }
    const jwks = Object.freeze({ keys: Object.freeze((parsed as EnterpriseOidcJwks).keys) });
    jwksByUri.set(jwksUri, Object.freeze({ jwks, expiresAt: now + JWKS_CACHE_TTL_MS }));
    return jwks;
  } catch {
    return undefined;
  }
}

/**
 * Core owns all claim validation and signature verification. An adapter only
 * contributes sealed static authority metadata and cannot construct a fact.
 */
export async function verifyEnterpriseOidcIdentity(params: {
  adapter: EnterpriseIdentityProviderAdapter;
  token: string;
  /** One-time Gateway transaction nonce. Enterprise admission has no token-only path. */
  expectedNonce: string;
  now?: number;
}): Promise<EnterpriseOidcVerification> {
  const token = params.token.trim();
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    return { kind: "denied", reason: "malformed-token" };
  }
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const header = base64urlJson(encodedHeader);
  const claims = base64urlJson(encodedClaims);
  if (!header || !claims) {
    return { kind: "denied", reason: "malformed-token" };
  }
  if (header.alg !== "RS256") {
    return { kind: "denied", reason: "unsupported-algorithm" };
  }
  const issuer = readText(claims, "iss");
  if (!issuer) {
    return { kind: "denied", reason: "wrong-issuer" };
  }
  const authority = selectAuthority(params.adapter, issuer);
  if (!authority || authority.algorithm !== "RS256") {
    return { kind: "denied", reason: "wrong-issuer" };
  }
  const audiences = readAudiences(claims.aud);
  if (
    !audiences ||
    !audiences.some((audience) => authority.audiences.includes(audience)) ||
    !hasAuthorizedParty(audiences, claims, authority)
  ) {
    return { kind: "denied", reason: "wrong-audience" };
  }
  const tenantMatches =
    authority.tenantBinding.kind === "issuer"
      ? true
      : readText(claims, authority.tenantBinding.claim) === authority.tenantBinding.value;
  if (!tenantMatches) {
    return { kind: "denied", reason: "wrong-tenant" };
  }
  const now = params.now ?? Date.now();
  const expiresAt = readTimestamp(claims, "exp");
  const issuedAt = readTimestamp(claims, "iat");
  const notBefore = readTimestamp(claims, "nbf");
  if (!expiresAt || !issuedAt) {
    return { kind: "denied", reason: "expired" };
  }
  if (expiresAt <= now) {
    return { kind: "denied", reason: "expired" };
  }
  if (notBefore !== undefined && notBefore > now) {
    return { kind: "denied", reason: "not-yet-valid" };
  }
  if (issuedAt > now || now - issuedAt > authority.maxSnapshotAgeMs) {
    return { kind: "denied", reason: "stale-snapshot" };
  }
  const keyId = readText(header, "kid");
  if (!keyId) {
    return { kind: "denied", reason: "unknown-key" };
  }
  let jwks = await resolveRegisteredJwks(authority.jwksUri, now);
  if (!jwks) {
    return { kind: "denied", reason: "provider-unavailable" };
  }
  let key = jwks.keys.find(
    (candidate) =>
      candidate.kid === keyId &&
      candidate.kty === "RSA" &&
      candidate.use !== "enc" &&
      (candidate.alg === undefined || candidate.alg === "RS256") &&
      (candidate.key_ops === undefined || candidate.key_ops.includes("verify")),
  );
  // A cached JWKS can legitimately predate a key rotation. Refresh once for
  // an unknown key id, then fail closed rather than broadening key selection.
  if (!key) {
    jwks = await resolveRegisteredJwks(authority.jwksUri, now, true);
    key = jwks?.keys.find(
      (candidate) =>
        candidate.kid === keyId &&
        candidate.kty === "RSA" &&
        candidate.use !== "enc" &&
        (candidate.alg === undefined || candidate.alg === "RS256") &&
        (candidate.key_ops === undefined || candidate.key_ops.includes("verify")),
    );
  }
  if (!key) {
    return { kind: "denied", reason: "unknown-key" };
  }
  let validSignature = false;
  try {
    validSignature = verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedClaims}`, "utf8"),
      createPublicKey({ key, format: "jwk" }),
      Buffer.from(encodedSignature, "base64url"),
    );
  } catch {
    return { kind: "denied", reason: "unknown-key" };
  }
  if (!validSignature) {
    return { kind: "denied", reason: "invalid-signature" };
  }
  if (readText(claims, "nonce") !== params.expectedNonce) {
    return { kind: "denied", reason: "wrong-nonce" };
  }
  const subject = readText(claims, "sub");
  if (!subject) {
    return { kind: "denied", reason: "missing-subject" };
  }
  if (!hasRequiredClaims(claims, authority.requiredClaims)) {
    return { kind: "denied", reason: "missing-required-claim" };
  }
  if (!hasRequiredAssurance(claims, authority, now)) {
    return { kind: "denied", reason: "wrong-assurance" };
  }
  const groups =
    authority.membership.kind === "google-workspace-directory"
      ? await resolveGoogleWorkspaceDirectoryGroups({ adapter: params.adapter, authority, claims })
      : (() => {
          if (hasIncompleteMembershipIndicator(claims, authority.membership)) {
            return { kind: "denied", reason: "incomplete-membership-snapshot" } as const;
          }
          const groupValue = claims[authority.membership.claim];
          if (groupValue === undefined && authority.membership.required) {
            return { kind: "denied", reason: "incomplete-membership-snapshot" } as const;
          }
          if (groupValue !== undefined && !Array.isArray(groupValue)) {
            return { kind: "denied", reason: "incomplete-membership-snapshot" } as const;
          }
          const resolved =
            groupValue === undefined
              ? Object.freeze([])
              : readGroups(
                  groupValue,
                  authority.membership.maxGroups,
                  authority.membership.roleGroupIds,
                );
          return resolved
            ? ({ kind: "verified", groups: resolved } as const)
            : ({ kind: "denied", reason: "invalid-groups" } as const);
        })();
  if (groups.kind !== "verified") {
    return groups;
  }
  // The digest is an opaque revision token. Raw claims and bearer JWT bytes
  // never cross into SQLite, audit output, or a memory authorization context.
  const evidenceRevision = `oidc1_${createHash("sha256")
    .update(`${encodedHeader}.${encodedClaims}`)
    .digest("base64url")}`;
  return {
    kind: "verified",
    identity: Object.freeze({
      providerId: params.adapter.providerPrefix,
      issuer: authority.issuer,
      tenant: authority.tenantId,
      subject,
      groups: groups.groups,
      evidenceRevision,
      observedAt: now,
      expiresAt: Math.min(
        expiresAt,
        issuedAt + authority.maxSnapshotAgeMs,
        readTimestamp(claims, "auth_time")! + authority.assurance.maxAuthenticationAgeMs,
      ),
    }),
  };
}

/**
 * The verifier is the sole state writer for upstream identity claims. It
 * persists reduced principal and membership evidence only after core has
 * accepted the signature and every authority-bound claim above.
 */
export function persistVerifiedEnterpriseOidcIdentity(params: {
  identity: VerifiedEnterpriseOidcIdentity;
  options?: OpenClawStateDatabaseOptions;
}): PersistedEnterpriseOidcIdentity {
  return persistMemoryEnterpriseIdentity({
    verified: {
      providerId: params.identity.providerId,
      issuer: params.identity.issuer,
      tenant: params.identity.tenant,
      subject: params.identity.subject,
      evidenceRevision: params.identity.evidenceRevision,
      observedAt: params.identity.observedAt,
      expiresAt: params.identity.expiresAt,
    },
    groups: params.identity.groups,
    options: params.options,
  });
}
