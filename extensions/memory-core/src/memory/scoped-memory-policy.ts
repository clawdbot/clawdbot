import type {
  AudienceRef,
  MemoryAuthorizationReasonCode,
  MemoryOperation,
} from "openclaw/plugin-sdk/memory-authorization";
import { MEMORY_AUTHORIZATION_CONTRACT_VERSION } from "openclaw/plugin-sdk/memory-authorization";
import {
  type MemoryAuthorizationConformanceAdapter,
  type MemoryAuthorizationConformanceDecision,
  type MemoryAuthorizationConformanceResource,
  type MemoryAuthorizationConformanceScenario,
} from "openclaw/plugin-sdk/memory-authorization-conformance";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  type MemoryPolicyEntryRow,
  type ScopedMemoryDatabase,
  type ScopedMemoryScopeKind,
  withScopedMemoryDatabase,
} from "./scoped-memory-db.js";

const OPERATION_REQUIREMENTS = {
  retrieve: ["retrieve"],
  read: ["retrieve", "read"],
  append: ["append"],
  replace: ["append", "replace"],
  derive: ["retrieve", "read", "derive"],
  deposit: ["deposit"],
  project: ["project"],
  publish: ["publish"],
  import: ["import"],
  export: ["export"],
  delete: ["delete"],
  sync: ["sync"],
  status: ["status"],
  "policy-admin": ["policy-admin"],
} as const satisfies Readonly<Record<MemoryOperation, readonly MemoryOperation[]>>;

export type ScopedMemoryPolicyEvaluation = Readonly<{
  allowed: boolean;
  reasonCode: "allowed" | "explicit-deny" | "default-deny" | "outside-view" | "revision-stale";
  policyRevisionId?: string;
  policyRevocationEpoch?: number;
}>;

type ScopedMemoryPolicyAudience = Readonly<{
  kind: ScopedMemoryScopeKind;
  id: string;
}>;

function normalizePolicyText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes("\0")) {
    throw new TypeError(`${label} must not be empty`);
  }
  return normalized;
}

function entryMatchesScopedPolicy(params: {
  entry: MemoryPolicyEntryRow;
  principalIds: ReadonlySet<string>;
  audiences: readonly ScopedMemoryPolicyAudience[];
  operation: MemoryOperation;
  nowMs: number;
}): boolean {
  return (
    params.entry.operation === params.operation &&
    (params.entry.principal_id === "*" || params.principalIds.has(params.entry.principal_id)) &&
    (params.entry.audience_kind === "*" ||
      params.audiences.some(
        (audience) =>
          audience.kind === params.entry.audience_kind && audience.id === params.entry.audience_id,
      )) &&
    (params.entry.expires_at === null || params.entry.expires_at > params.nowMs)
  );
}

/**
 * Evaluate one current persisted store policy. This is deliberately a pure plugin-owned policy
 * operation: the core supplies only already-verified principals and delivery audiences later.
 */
export function evaluateBuiltinScopedMemoryPolicy(params: {
  agentId: string;
  storeId: string;
  principalIds: readonly string[];
  deliveryAudiences: readonly ScopedMemoryPolicyAudience[];
  operation: MemoryOperation;
  nowMs?: number;
}): ScopedMemoryPolicyEvaluation {
  const agentId = normalizeAgentId(params.agentId);
  const storeId = normalizePolicyText(params.storeId, "storeId");
  const principalIds = new Set(
    params.principalIds.map((principalId) => normalizePolicyText(principalId, "principalId")),
  );
  const audiences = params.deliveryAudiences.map((audience) =>
    Object.freeze({
      kind: audience.kind,
      id: normalizePolicyText(audience.id, "delivery audience id"),
    }),
  );
  const nowMs = params.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("nowMs must be finite");
  }
  return withScopedMemoryDatabase(agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const current = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("memory_stores as store")
        .innerJoin("memory_storage_roots as root", "root.storage_root_id", "store.storage_root_id")
        .innerJoin("memory_policies as policy", "policy.policy_id", "store.policy_id")
        .innerJoin(
          "memory_policy_revisions as revision",
          "revision.revision_id",
          "policy.current_revision_id",
        )
        .select([
          "store.audience_kind",
          "store.audience_id",
          "root.authority_kind",
          "root.authority_owner_id",
          "root.default_capabilities_json",
          "policy.current_revision_id",
          "policy.revocation_epoch",
        ])
        .where("store.store_id", "=", storeId)
        .where("store.agent_id", "=", agentId)
        .where("store.lifecycle_state", "=", "active")
        .where("root.lifecycle_state", "=", "active")
        .where("policy.lifecycle_state", "=", "active")
        .where("revision.lifecycle_state", "=", "active"),
    );
    if (!current) {
      return Object.freeze({ allowed: false, reasonCode: "revision-stale" });
    }
    if (
      !audiences.some(
        (audience) =>
          audience.kind === current.audience_kind && audience.id === current.audience_id,
      )
    ) {
      return Object.freeze({
        allowed: false,
        reasonCode: "outside-view",
        policyRevisionId: current.current_revision_id,
        policyRevocationEpoch: current.revocation_epoch,
      });
    }
    // A private user mount is self-owned at this phase. Delivery routing cannot substitute for
    // the verified subject: otherwise a caller could name Alice's audience while acting as Bob.
    if (current.authority_kind === "user" && !principalIds.has(current.authority_owner_id)) {
      return Object.freeze({
        allowed: false,
        reasonCode: "outside-view",
        policyRevisionId: current.current_revision_id,
        policyRevocationEpoch: current.revocation_epoch,
      });
    }
    let defaultCapabilities: readonly MemoryOperation[];
    try {
      const parsed = JSON.parse(current.default_capabilities_json) as unknown;
      if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
        throw new TypeError("invalid policy capabilities");
      }
      defaultCapabilities = parsed.filter((entry): entry is MemoryOperation =>
        Object.hasOwn(OPERATION_REQUIREMENTS, entry),
      );
    } catch {
      return Object.freeze({
        allowed: false,
        reasonCode: "revision-stale",
        policyRevisionId: current.current_revision_id,
        policyRevocationEpoch: current.revocation_epoch,
      });
    }
    const entries = executeSqliteQuerySync(
      database,
      db
        .selectFrom("memory_policy_entries")
        .selectAll()
        .where("policy_revision_id", "=", current.current_revision_id),
    ).rows;
    const requirements = OPERATION_REQUIREMENTS[params.operation];
    for (const operation of requirements) {
      if (
        entries.some(
          (entry) =>
            entry.effect === "deny" &&
            entryMatchesScopedPolicy({ entry, principalIds, audiences, operation, nowMs }),
        )
      ) {
        return Object.freeze({
          allowed: false,
          reasonCode: "explicit-deny",
          policyRevisionId: current.current_revision_id,
          policyRevocationEpoch: current.revocation_epoch,
        });
      }
    }
    for (const operation of requirements) {
      const allowed =
        defaultCapabilities.includes(operation) ||
        entries.some(
          (entry) =>
            entry.effect === "allow" &&
            entryMatchesScopedPolicy({ entry, principalIds, audiences, operation, nowMs }),
        );
      if (!allowed) {
        return Object.freeze({
          allowed: false,
          reasonCode: "default-deny",
          policyRevisionId: current.current_revision_id,
          policyRevocationEpoch: current.revocation_epoch,
        });
      }
    }
    return Object.freeze({
      allowed: true,
      reasonCode: "allowed",
      policyRevisionId: current.current_revision_id,
      policyRevocationEpoch: current.revocation_epoch,
    });
  });
}

function audienceKey(audience: AudienceRef): string {
  return `${audience.kind}\0${audience.id}`;
}

function isCurrentExpiry(expiresAt: unknown, now: string): expiresAt is string {
  if (typeof expiresAt !== "string" || !expiresAt) {
    return false;
  }
  const expiryMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  return Number.isFinite(expiryMs) && Number.isFinite(nowMs) && expiryMs > nowMs;
}

function isExpired(expiresAt: string | undefined, now: string): boolean {
  return expiresAt !== undefined && !isCurrentExpiry(expiresAt, now);
}

function sameSet<T>(
  actual: readonly T[],
  expected: readonly T[],
  key: (value: T) => string,
): boolean {
  const actualKeys = actual.map(key);
  const expectedKeys = expected.map(key);
  return (
    actualKeys.length === new Set(actualKeys).size &&
    expectedKeys.length === new Set(expectedKeys).size &&
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((value) => expectedKeys.includes(value))
  );
}

function mountKey(mount: MemoryAuthorizationConformanceScenario["plan"]["mounts"][number]): string {
  return JSON.stringify([
    mount.storeId,
    mount.agentId,
    mount.audienceRevision,
    mount.capabilities.toSorted(),
  ]);
}

function planFailure(
  scenario: MemoryAuthorizationConformanceScenario,
): MemoryAuthorizationReasonCode | undefined {
  const { context, plan } = scenario;
  if (!isCurrentExpiry(plan.expiresAt, scenario.now)) {
    return "plan-expired";
  }
  if (
    !plan.planId ||
    plan.contextFingerprint !== context.contextFingerprint ||
    plan.runId !== context.runId
  ) {
    return "invalid-context";
  }
  if (plan.sessionId !== context.sessionId) {
    return "session-rebound";
  }
  if (plan.agentId !== context.agentId || plan.operation !== context.operation) {
    return "outside-view";
  }
  if (!sameSet(plan.mounts, scenario.viewMounts, mountKey)) {
    return "outside-view";
  }
  if (plan.mounts.some((mount) => mount.agentId !== context.agentId)) {
    return "outside-view";
  }
  if (!sameSet(plan.allowedEgressAudiences, context.deliveryAudiences, audienceKey)) {
    return "outside-view";
  }
  if (
    plan.sessionIdentityRevision !== context.sessionIdentityRevision ||
    plan.subjectRevision !== context.subjectRevision ||
    plan.policyRevision !== context.policyRevision ||
    plan.hostFactsRevision !== context.hostFactsRevision
  ) {
    return "revision-stale";
  }
  return plan.deliveryRevision === context.deliveryRevision ? undefined : "delivery-rebound";
}

function activePrincipalIds(
  scenario: MemoryAuthorizationConformanceScenario,
): ReadonlySet<string> | undefined {
  const ids = new Set<string>();
  for (const ref of scenario.context.principalRefs) {
    const facts = scenario.principals.filter((fact) => fact.principalId === ref.principalId);
    const fact = facts[0];
    if (
      ids.has(ref.principalId) ||
      facts.length !== 1 ||
      !fact ||
      fact.status !== "active" ||
      fact.evidenceRevision !== ref.evidenceRevision ||
      !isCurrentExpiry(fact.expiresAt, scenario.now)
    ) {
      return undefined;
    }
    ids.add(ref.principalId);
  }
  return ids.size > 0 ? ids : undefined;
}

function membershipFailure(params: {
  scenario: MemoryAuthorizationConformanceScenario;
  store: MemoryAuthorizationConformanceScenario["stores"][number];
  principalIds: ReadonlySet<string>;
}): "membership-stale" | undefined {
  const requirement = params.store.requiredMembership;
  if (!requirement) {
    return undefined;
  }
  if (!params.principalIds.has(requirement.principalId)) {
    return "membership-stale";
  }
  const refs = params.scenario.context.membershipRefs.filter(
    (entry) =>
      entry.principalId === requirement.principalId &&
      entry.groupId === requirement.groupId &&
      entry.provider === requirement.provider,
  );
  const facts = params.scenario.memberships.filter(
    (entry) =>
      entry.principalId === requirement.principalId &&
      entry.groupId === requirement.groupId &&
      entry.provider === requirement.provider,
  );
  const ref = refs[0];
  const fact = facts[0];
  if (
    refs.length !== 1 ||
    facts.length !== 1 ||
    !ref ||
    !fact ||
    fact.status !== "active" ||
    fact.evidenceRevision !== ref.evidenceRevision ||
    fact.hostFactsRevision !== ref.hostFactsRevision ||
    fact.hostFactsRevision !== params.scenario.context.hostFactsRevision ||
    !isCurrentExpiry(fact.expiresAt, params.scenario.now)
  ) {
    return "membership-stale";
  }
  return undefined;
}

function entryMatches(params: {
  scenario: MemoryAuthorizationConformanceScenario;
  resource: MemoryAuthorizationConformanceResource;
  operation: MemoryOperation;
  principalIds: ReadonlySet<string>;
  effect: "allow" | "deny";
}): boolean {
  return params.scenario.policyEntries.some(
    (entry) =>
      entry.effect === params.effect &&
      entry.operation === params.operation &&
      (entry.resourceId === "*" || entry.resourceId === params.resource.resourceId) &&
      (entry.principalId === "*" || params.principalIds.has(entry.principalId)) &&
      !isExpired(entry.expiresAt, params.scenario.now),
  );
}

/**
 * Plugin-owned reference implementation for the reusable host fixtures. It deliberately does not
 * call the host evaluator: admission compares two independent policy implementations.
 */
function evaluateBuiltinScopedMemoryConformanceScenario(params: {
  scenario: MemoryAuthorizationConformanceScenario;
  resource: MemoryAuthorizationConformanceResource;
}): MemoryAuthorizationConformanceDecision {
  const { resource, scenario } = params;
  const failedPlan = planFailure(scenario);
  if (failedPlan) {
    return { allowed: false, reasonCode: failedPlan };
  }
  const principalIds = activePrincipalIds(scenario);
  if (!principalIds) {
    return { allowed: false, reasonCode: "identity-revoked" };
  }
  const store = scenario.stores.find((entry) => entry.storeId === resource.storeId);
  const mount = scenario.plan.mounts.find((entry) => entry.storeId === resource.storeId);
  const requirements = OPERATION_REQUIREMENTS[scenario.context.operation];
  if (
    !store ||
    !mount ||
    store.agentId !== scenario.context.agentId ||
    resource.agentId !== scenario.context.agentId ||
    mount.agentId !== scenario.context.agentId ||
    !requirements.every((operation) => mount.capabilities.includes(operation))
  ) {
    return { allowed: false, reasonCode: "outside-view" };
  }
  const staleMembership = membershipFailure({ scenario, store, principalIds });
  if (staleMembership) {
    return { allowed: false, reasonCode: staleMembership };
  }
  if (isExpired(resource.expiresAt, scenario.now)) {
    return { allowed: false, reasonCode: "revision-stale" };
  }
  const audiences = new Set(resource.audiences.map(audienceKey));
  if (
    scenario.context.deliveryAudiences.some((audience) => !audiences.has(audienceKey(audience)))
  ) {
    return { allowed: false, reasonCode: "outside-view" };
  }
  if (
    scenario.context.delegation &&
    (!scenario.context.delegation.allowedOperations.includes(scenario.context.operation) ||
      scenario.context.deliveryAudiences.some(
        (audience) =>
          !scenario.context.delegation!.maximumAudiences.some(
            (maximum) => audienceKey(maximum) === audienceKey(audience),
          ),
      ))
  ) {
    return { allowed: false, reasonCode: "default-deny" };
  }
  if (
    resource.requiredLineagePolicySetIds?.some(
      (policySetId) => !scenario.context.lineagePolicySetIds.includes(policySetId),
    )
  ) {
    return { allowed: false, reasonCode: "lineage-deny" };
  }
  for (const operation of requirements) {
    if (entryMatches({ scenario, resource, operation, principalIds, effect: "deny" })) {
      return { allowed: false, reasonCode: "explicit-deny" };
    }
  }
  for (const operation of requirements) {
    if (
      !store.placementCapabilities.includes(operation) &&
      !entryMatches({ scenario, resource, operation, principalIds, effect: "allow" })
    ) {
      return { allowed: false, reasonCode: "default-deny" };
    }
  }
  return {
    allowed: true,
    reasonCode: "allowed",
    handle: {
      version: MEMORY_AUTHORIZATION_CONTRACT_VERSION,
      handleId: "memory-core-conformance-handle",
      planId: scenario.plan.planId,
      contextFingerprint: scenario.plan.contextFingerprint,
      resourceRevision: resource.revision,
      policyRevision: scenario.plan.policyRevision,
      expiresAt: scenario.plan.expiresAt,
    },
  };
}

export const builtinScopedMemoryConformanceAdapter: MemoryAuthorizationConformanceAdapter =
  Object.freeze({
    evaluate: evaluateBuiltinScopedMemoryConformanceScenario,
    // The prefilter intentionally over-fetches fixture resources; the evaluator is authoritative.
    prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
  });
