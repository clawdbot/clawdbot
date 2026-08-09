import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  MemoryAuthorizationConformanceScenario,
  MemoryAuthorizationConformanceStore,
} from "./authorization-conformance.js";

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Avoid Array.isArray's any[] narrowing while retaining the runtime boundary check. */
function isReadonlyArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function hasTextFields<const Field extends string>(
  value: unknown,
  fields: readonly Field[],
): value is Record<Field, string> {
  if (!isRecord(value)) {
    return false;
  }
  return fields.every((field) => isNonEmptyText(value[field]));
}

export function isConformanceEvidenceExpired(expiresAt: string | undefined, now: string): boolean {
  if (expiresAt === undefined) {
    return false;
  }
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  return !Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs) || expiresAtMs <= nowMs;
}

/** Host facts used to authorize a plan must be bounded, even though policy data may not be. */
export function hasCurrentConformanceEvidenceExpiry(expiresAt: unknown, now: string): boolean {
  return isNonEmptyText(expiresAt) && !isConformanceEvidenceExpired(expiresAt, now);
}

/** Resolves policy principals only from current host-declared evidence. */
export function resolveActiveConformancePrincipalIds(
  scenario: MemoryAuthorizationConformanceScenario,
): ReadonlySet<string> | undefined {
  const refs = scenario.context.principalRefs;
  if (!isReadonlyArray(refs) || refs.length === 0 || !isReadonlyArray(scenario.principals)) {
    return undefined;
  }
  const principalIds = new Set<string>();
  for (const ref of refs) {
    if (!hasTextFields(ref, ["principalId", "evidenceRevision"])) {
      return undefined;
    }
    // One context principal must map to exactly one current host fact.
    if (principalIds.has(ref.principalId)) {
      return undefined;
    }
    const facts = scenario.principals.filter(
      (fact) => hasTextFields(fact, ["principalId"]) && fact.principalId === ref.principalId,
    );
    const fact = facts[0];
    if (
      facts.length !== 1 ||
      !fact ||
      !hasTextFields(fact, ["principalId", "evidenceRevision"]) ||
      fact.status !== "active" ||
      fact.evidenceRevision !== ref.evidenceRevision ||
      !hasCurrentConformanceEvidenceExpiry(fact.expiresAt, scenario.now)
    ) {
      return undefined;
    }
    principalIds.add(fact.principalId);
  }
  return principalIds;
}

/** Checks only the selected mount's required membership, so unrelated stale facts stay inert. */
export function requiredConformanceMembershipFailure(params: {
  scenario: MemoryAuthorizationConformanceScenario;
  store: MemoryAuthorizationConformanceStore;
  activePrincipalIds: ReadonlySet<string>;
}): "membership-stale" | undefined {
  const { activePrincipalIds, scenario, store } = params;
  const requirement = store.requiredMembership;
  if (!requirement) {
    return undefined;
  }
  if (
    !hasTextFields(requirement, ["principalId", "groupId", "provider"]) ||
    !activePrincipalIds.has(requirement.principalId) ||
    !isReadonlyArray(scenario.context.membershipRefs) ||
    !isReadonlyArray(scenario.memberships)
  ) {
    return "membership-stale";
  }
  const refs = scenario.context.membershipRefs.filter(
    (ref) =>
      hasTextFields(ref, [
        "principalId",
        "groupId",
        "provider",
        "evidenceRevision",
        "hostFactsRevision",
      ]) &&
      ref.principalId === requirement.principalId &&
      ref.groupId === requirement.groupId &&
      ref.provider === requirement.provider,
  );
  const facts = scenario.memberships.filter(
    (fact) =>
      hasTextFields(fact, [
        "principalId",
        "groupId",
        "provider",
        "evidenceRevision",
        "hostFactsRevision",
      ]) &&
      fact.principalId === requirement.principalId &&
      fact.groupId === requirement.groupId &&
      fact.provider === requirement.provider,
  );
  const ref = refs[0];
  const fact = facts[0];
  if (
    refs.length !== 1 ||
    facts.length !== 1 ||
    !ref ||
    !fact ||
    fact.status !== "active" ||
    fact.provider !== ref.provider ||
    fact.evidenceRevision !== ref.evidenceRevision ||
    fact.hostFactsRevision !== ref.hostFactsRevision ||
    fact.hostFactsRevision !== scenario.context.hostFactsRevision ||
    !hasCurrentConformanceEvidenceExpiry(fact.expiresAt, scenario.now)
  ) {
    // A missing required fact is a removed or refresh-needed membership snapshot, never a grant.
    return "membership-stale";
  }
  return undefined;
}
