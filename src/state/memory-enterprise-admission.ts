import type {
  MemoryVerifiedMembership,
  VerifiedPrincipalRef,
} from "../memory-host-sdk/host/authorization.js";
import {
  readCurrentMemoryEnterpriseMembership,
  recheckMemoryEnterprisePrincipal,
  recheckMemoryEnterpriseProfileLink,
  type MemoryEnterprisePrincipal,
  type MemoryEnterpriseProfileLink,
} from "./memory-enterprise-identity.js";
import type { VerifiedEnterpriseOidcIdentity } from "./memory-enterprise-verifier.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";

type EnterpriseAdmission = Readonly<{
  userPrincipalId: string;
  enterprisePrincipalId: string;
  providerId: string;
  tenant: string;
  groups: readonly string[];
  evidenceRevision: string;
  observedAt: number;
  expiresAt: number;
  profileLinkRevision: string;
}>;

export type CurrentEnterpriseMemoryFacts = Readonly<{
  verifiedPrincipals: readonly VerifiedPrincipalRef[];
  verifiedMemberships: readonly MemoryVerifiedMembership[];
}>;

// JWT group values remain process-local admission material. SQLite retains only
// HMAC-reduced group refs, so a restart fails closed until Gateway admits fresh
// provider evidence instead of reconstructing a role from durable raw claims.
const admissionsByUser = new Map<string, EnterpriseAdmission>();

function admissionKey(userPrincipalId: string, providerId: string): string {
  return `${userPrincipalId}\u0000${providerId}`;
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

/** Test lifecycle hook; production admissions are bounded by provider evidence expiry. */
export function clearMemoryEnterpriseAdmissionsForTest(): void {
  admissionsByUser.clear();
}

/**
 * Gateway calls this only after core verification, persistence, and the explicit
 * profile link have succeeded. It retains no bearer token and cannot be replayed
 * for another Gateway user because every later read rechecks that exact link.
 */
export function admitVerifiedEnterpriseIdentityForMemory(params: {
  userPrincipalId: string;
  principal: MemoryEnterprisePrincipal;
  profileLink: MemoryEnterpriseProfileLink;
  identity: VerifiedEnterpriseOidcIdentity;
}): void {
  if (
    params.profileLink.enterprisePrincipalId !== params.principal.principalId ||
    params.profileLink.userPrincipalId !== params.userPrincipalId ||
    params.identity.providerId !== params.principal.providerId ||
    params.identity.evidenceRevision !== params.principal.evidenceRevision
  ) {
    throw new Error("enterprise memory admission requires one current verified profile link");
  }
  admissionsByUser.set(
    admissionKey(params.userPrincipalId, params.identity.providerId),
    Object.freeze({
      userPrincipalId: params.userPrincipalId,
      enterprisePrincipalId: params.principal.principalId,
      providerId: params.identity.providerId,
      tenant: params.identity.tenant,
      groups: Object.freeze([...params.identity.groups]),
      evidenceRevision: params.identity.evidenceRevision,
      observedAt: params.identity.observedAt,
      expiresAt: params.identity.expiresAt,
      profileLinkRevision: params.profileLink.revision,
    }),
  );
}

/**
 * Materialize only current, linked enterprise facts for a Gateway user. Any
 * revocation, evidence refresh, expiry, process restart, or profile reassignment
 * removes the facts before the memory host can select a role audience.
 */
export function readCurrentEnterpriseMemoryFactsForUser(params: {
  userPrincipalId: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): CurrentEnterpriseMemoryFacts {
  const now = params.now ?? Date.now();
  const verifiedPrincipals: VerifiedPrincipalRef[] = [];
  const verifiedMemberships: MemoryVerifiedMembership[] = [];
  for (const admission of admissionsByUser.values()) {
    if (admission.userPrincipalId !== params.userPrincipalId || admission.expiresAt <= now) {
      continue;
    }
    const link = recheckMemoryEnterpriseProfileLink({
      enterprisePrincipalId: admission.enterprisePrincipalId,
      userPrincipalId: admission.userPrincipalId,
      providerId: admission.providerId,
      now,
      options: params.options,
    });
    if (!link || link.revision !== admission.profileLinkRevision) {
      continue;
    }
    const principal = recheckMemoryEnterprisePrincipal({
      principalId: admission.enterprisePrincipalId,
      providerId: admission.providerId,
      now,
      options: params.options,
    });
    if (!principal || principal.evidenceRevision !== admission.evidenceRevision) {
      continue;
    }
    const memberships = admission.groups.flatMap((group) => {
      const snapshot = readCurrentMemoryEnterpriseMembership({
        principalId: admission.enterprisePrincipalId,
        providerId: admission.providerId,
        tenant: admission.tenant,
        group,
        now,
        options: params.options,
      });
      if (!snapshot || snapshot.evidenceRevision !== admission.evidenceRevision) {
        return [];
      }
      return [
        Object.freeze({
          snapshotId: snapshot.snapshotId,
          principalId: admission.userPrincipalId,
          sourcePrincipalId: admission.enterprisePrincipalId,
          groupId: group,
          provider: admission.providerId,
          evidenceRevision: admission.evidenceRevision,
          profileLinkRevision: link.revision,
          observedAt: iso(snapshot.observedAt),
          expiresAt: iso(snapshot.expiresAt),
        }) satisfies MemoryVerifiedMembership,
      ];
    });
    if (memberships.length === 0) {
      continue;
    }
    verifiedPrincipals.push({
      principalId: principal.principalId,
      assurance: "oidc",
      evidenceRevision: principal.evidenceRevision,
      expiresAt: iso(principal.expiresAt),
    });
    verifiedMemberships.push(...memberships);
  }
  return Object.freeze({
    verifiedPrincipals: Object.freeze(verifiedPrincipals),
    verifiedMemberships: Object.freeze(verifiedMemberships),
  });
}
