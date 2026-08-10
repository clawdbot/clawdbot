import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  hasCurrentConformanceEvidenceExpiry,
  isConformanceEvidenceExpired,
  requiredConformanceMembershipFailure,
  resolveActiveConformancePrincipalIds,
} from "./authorization-conformance-evidence.js";
import { createMemoryAuthorizationConformanceScenarios } from "./authorization-conformance-scenarios.js";
import { MEMORY_AUTHORIZATION_OPERATION_REQUIREMENTS } from "./authorization-operation-requirements.js";
import {
  MEMORY_AUTHORIZATION_CONTRACT_VERSION,
  type AuthorizedResourceHandle,
  type AudienceRef,
  type MemoryAuthorizationReasonCode,
  type MemoryOperation,
} from "./authorization.js";

export type MemoryAuthorizationConformancePrincipal =
  | Readonly<{
      principalId: string;
      status: "active";
      evidenceRevision: string;
      expiresAt: string;
    }>
  | Readonly<{
      principalId: string;
      status: "revoked";
      evidenceRevision: string;
      expiresAt?: string;
    }>;

/** Context claims bind a policy principal to one declared host-evidence revision. */
export type MemoryAuthorizationConformancePrincipalRef = Readonly<{
  principalId: string;
  evidenceRevision: string;
}>;

export type MemoryAuthorizationConformanceMembership =
  | Readonly<{
      principalId: string;
      groupId: string;
      provider: string;
      status: "active";
      evidenceRevision: string;
      hostFactsRevision: string;
      expiresAt: string;
    }>
  | Readonly<{
      principalId: string;
      groupId: string;
      provider: string;
      status: "revoked";
      evidenceRevision: string;
      hostFactsRevision: string;
      expiresAt?: string;
    }>;

/** Context claims bind a membership to one declared host-evidence revision. */
export type MemoryAuthorizationConformanceMembershipRef = Readonly<{
  principalId: string;
  groupId: string;
  provider: string;
  evidenceRevision: string;
  hostFactsRevision: string;
}>;

export type MemoryAuthorizationConformanceMembershipRequirement = Readonly<{
  principalId: string;
  groupId: string;
  /** The selected mount admits membership evidence from this provider only. */
  provider: string;
}>;

export type MemoryAuthorizationConformanceStore = Readonly<{
  storeId: string;
  agentId: string;
  placementCapabilities: readonly MemoryOperation[];
  /** A mount-specific group check; stores without one remain direct-principal stores. */
  requiredMembership?: MemoryAuthorizationConformanceMembershipRequirement;
}>;

export type MemoryAuthorizationConformanceResource = Readonly<{
  resourceId: string;
  agentId: string;
  storeId: string;
  revision: string;
  audiences: readonly AudienceRef[];
  expiresAt?: string;
  requiredLineagePolicySetIds?: readonly string[];
}>;

export type MemoryAuthorizationConformancePolicyEntry = Readonly<{
  effect: "allow" | "deny";
  principalId: string;
  resourceId: string;
  operation: MemoryOperation;
  expiresAt?: string;
}>;

/**
 * Fixture-only representation of a plan mount. Real plans retain opaque mount handles;
 * conformance names the backing store so it can prove the plan matches the computed view.
 */
export type MemoryAuthorizationConformanceMount = Readonly<{
  storeId: string;
  agentId: string;
  capabilities: readonly MemoryOperation[];
  audienceRevision: string;
}>;

export type MemoryAuthorizationConformancePlanBinding = Readonly<{
  planId: string;
  contextFingerprint: string;
  runId: string;
  agentId: string;
  sessionId: string;
  sessionIdentityRevision: string;
  subjectRevision: string;
  deliveryRevision: string;
  policyRevision: string;
  hostFactsRevision: string;
  operation: MemoryOperation;
  mounts: readonly MemoryAuthorizationConformanceMount[];
  allowedEgressAudiences: readonly AudienceRef[];
  expiresAt: string;
}>;

export type MemoryAuthorizationConformanceScenario = Readonly<{
  id: string;
  now: string;
  principals: readonly MemoryAuthorizationConformancePrincipal[];
  memberships: readonly MemoryAuthorizationConformanceMembership[];
  stores: readonly MemoryAuthorizationConformanceStore[];
  resources: readonly MemoryAuthorizationConformanceResource[];
  policyEntries: readonly MemoryAuthorizationConformancePolicyEntry[];
  /** The current plugin-computed view that the issued plan must reproduce exactly. */
  viewMounts: readonly MemoryAuthorizationConformanceMount[];
  context: Readonly<{
    contextFingerprint: string;
    runId: string;
    agentId: string;
    sessionId: string;
    sessionIdentityRevision: string;
    subjectRevision: string;
    deliveryRevision: string;
    policyRevision: string;
    hostFactsRevision: string;
    operation: MemoryOperation;
    principalRefs: readonly MemoryAuthorizationConformancePrincipalRef[];
    membershipRefs: readonly MemoryAuthorizationConformanceMembershipRef[];
    deliveryAudiences: readonly AudienceRef[];
    lineagePolicySetIds: readonly string[];
    delegation?: Readonly<{
      allowedOperations: readonly MemoryOperation[];
      maximumAudiences: readonly AudienceRef[];
    }>;
  }>;
  plan: MemoryAuthorizationConformancePlanBinding;
}>;

export type MemoryAuthorizationConformanceDecision =
  | Readonly<{
      allowed: true;
      reasonCode: "allowed";
      handle: AuthorizedResourceHandle;
    }>
  | Readonly<{
      allowed: false;
      reasonCode: MemoryAuthorizationReasonCode;
    }>;

export type MemoryAuthorizationConformanceAdapter = Readonly<{
  evaluate(params: {
    scenario: MemoryAuthorizationConformanceScenario;
    resource: MemoryAuthorizationConformanceResource;
  }): MemoryAuthorizationConformanceDecision | Promise<MemoryAuthorizationConformanceDecision>;
  prefilter(
    scenario: MemoryAuthorizationConformanceScenario,
  ): readonly string[] | Promise<readonly string[]>;
}>;

export type MemoryAuthorizationConformanceCase = Readonly<{
  id: string;
  scenario: MemoryAuthorizationConformanceScenario;
  expected: Readonly<Record<string, MemoryAuthorizationConformanceDecision>>;
}>;

export type MemoryAuthorizationConformanceReport = Readonly<{
  ok: boolean;
  failures: readonly Readonly<{
    caseId: string;
    invariant:
      | "decision"
      | "authorized-handle"
      | "denial-non-disclosure"
      | "prefilter-superset"
      | "duplicate-prefilter-candidate";
  }>[];
}>;

function audienceKey(audience: AudienceRef): string {
  return `${audience.kind}\0${audience.id}`;
}

function hasExactlyTheSameUniqueSet<T>(
  actual: readonly T[],
  expected: readonly T[],
  key: (value: T) => string,
): boolean {
  const actualKeys = actual.map(key);
  const expectedKeys = expected.map(key);
  const actualSet = new Set(actualKeys);
  const expectedSet = new Set(expectedKeys);
  return (
    actualKeys.length === actualSet.size &&
    expectedKeys.length === expectedSet.size &&
    actualSet.size === expectedSet.size &&
    [...actualSet].every((key) => expectedSet.has(key))
  );
}

function mountKey(mount: MemoryAuthorizationConformanceMount): string {
  return JSON.stringify([
    mount.storeId,
    mount.agentId,
    mount.audienceRevision,
    [...mount.capabilities].sort(),
  ]);
}

function policyEntryMatches(params: {
  entry: MemoryAuthorizationConformancePolicyEntry;
  resource: MemoryAuthorizationConformanceResource;
  operation: MemoryOperation;
  activePrincipalIds: ReadonlySet<string>;
  now: string;
}): boolean {
  const { activePrincipalIds, entry, now, resource, operation } = params;
  return (
    entry.operation === operation &&
    (entry.resourceId === "*" || entry.resourceId === resource.resourceId) &&
    (entry.principalId === "*" || activePrincipalIds.has(entry.principalId)) &&
    !isConformanceEvidenceExpired(entry.expiresAt, now)
  );
}

function planBindingFailure(
  scenario: MemoryAuthorizationConformanceScenario,
): MemoryAuthorizationReasonCode | null {
  const { context, plan } = scenario;
  if (!hasCurrentConformanceEvidenceExpiry(plan.expiresAt, scenario.now)) {
    return "plan-expired";
  }
  if (!isNonEmptyText(plan.planId)) {
    return "invalid-context";
  }
  if (plan.contextFingerprint !== context.contextFingerprint) {
    return "invalid-context";
  }
  if (plan.runId !== context.runId) {
    return "invalid-context";
  }
  if (plan.sessionId !== context.sessionId) {
    return "session-rebound";
  }
  if (plan.agentId !== context.agentId || plan.operation !== context.operation) {
    return "outside-view";
  }
  if (
    !hasExactlyTheSameUniqueSet(plan.mounts, scenario.viewMounts, mountKey) ||
    plan.mounts.some((mount) => new Set(mount.capabilities).size !== mount.capabilities.length)
  ) {
    return "outside-view";
  }
  if (plan.mounts.some((mount) => mount.agentId !== context.agentId)) {
    return "outside-view";
  }
  if (
    !hasExactlyTheSameUniqueSet(plan.allowedEgressAudiences, context.deliveryAudiences, audienceKey)
  ) {
    return "outside-view";
  }
  if (
    plan.sessionIdentityRevision !== context.sessionIdentityRevision ||
    plan.subjectRevision !== context.subjectRevision ||
    plan.policyRevision !== context.policyRevision
  ) {
    return "revision-stale";
  }
  if (plan.deliveryRevision !== context.deliveryRevision) {
    return "delivery-rebound";
  }
  if (plan.hostFactsRevision !== context.hostFactsRevision) {
    return "revision-stale";
  }
  return null;
}

/** Pure reference evaluator used to compare backend policy implementations. */
export function evaluateMemoryAuthorizationConformanceScenario(params: {
  scenario: MemoryAuthorizationConformanceScenario;
  resource: MemoryAuthorizationConformanceResource;
}): MemoryAuthorizationConformanceDecision {
  const { resource, scenario } = params;
  const bindingFailure = planBindingFailure(scenario);
  if (bindingFailure) {
    return { allowed: false, reasonCode: bindingFailure };
  }

  const activePrincipalIds = resolveActiveConformancePrincipalIds(scenario);
  if (!activePrincipalIds) {
    return { allowed: false, reasonCode: "identity-revoked" };
  }

  const store = scenario.stores.find((entry) => entry.storeId === resource.storeId);
  const mount = scenario.plan.mounts.find((entry) => entry.storeId === resource.storeId);
  if (
    !store ||
    !mount ||
    store.agentId !== scenario.context.agentId ||
    resource.agentId !== scenario.context.agentId ||
    mount.agentId !== scenario.context.agentId ||
    !MEMORY_AUTHORIZATION_OPERATION_REQUIREMENTS[scenario.context.operation].every((operation) =>
      mount.capabilities.includes(operation),
    )
  ) {
    return { allowed: false, reasonCode: "outside-view" };
  }
  const membershipFailure = requiredConformanceMembershipFailure({
    scenario,
    store,
    activePrincipalIds,
  });
  if (membershipFailure) {
    return { allowed: false, reasonCode: membershipFailure };
  }
  if (isConformanceEvidenceExpired(resource.expiresAt, scenario.now)) {
    return { allowed: false, reasonCode: "revision-stale" };
  }

  const resourceAudiences = new Set(resource.audiences.map(audienceKey));
  if (
    scenario.context.deliveryAudiences.some(
      (audience) => !resourceAudiences.has(audienceKey(audience)),
    )
  ) {
    return { allowed: false, reasonCode: "outside-view" };
  }

  const delegation = scenario.context.delegation;
  if (delegation) {
    const maximumAudiences = new Set(delegation.maximumAudiences.map(audienceKey));
    if (
      !delegation.allowedOperations.includes(scenario.context.operation) ||
      scenario.context.deliveryAudiences.some(
        (audience) => !maximumAudiences.has(audienceKey(audience)),
      )
    ) {
      return { allowed: false, reasonCode: "default-deny" };
    }
  }

  const inheritedPolicies = new Set(scenario.context.lineagePolicySetIds);
  if (
    resource.requiredLineagePolicySetIds?.some((policySetId) => !inheritedPolicies.has(policySetId))
  ) {
    return { allowed: false, reasonCode: "lineage-deny" };
  }

  const requiredOperations =
    MEMORY_AUTHORIZATION_OPERATION_REQUIREMENTS[scenario.context.operation];
  for (const operation of requiredOperations) {
    if (
      scenario.policyEntries.some(
        (entry) =>
          entry.effect === "deny" &&
          policyEntryMatches({
            entry,
            resource,
            operation,
            activePrincipalIds,
            now: scenario.now,
          }),
      )
    ) {
      return { allowed: false, reasonCode: "explicit-deny" };
    }
  }
  for (const operation of requiredOperations) {
    const placed = store.placementCapabilities.includes(operation);
    const explicitlyAllowed = scenario.policyEntries.some(
      (entry) =>
        entry.effect === "allow" &&
        policyEntryMatches({
          entry,
          resource,
          operation,
          activePrincipalIds,
          now: scenario.now,
        }),
    );
    if (!placed && !explicitlyAllowed) {
      return { allowed: false, reasonCode: "default-deny" };
    }
  }

  return {
    allowed: true,
    reasonCode: "allowed",
    handle: {
      version: MEMORY_AUTHORIZATION_CONTRACT_VERSION,
      handleId: "reference-issued-handle",
      planId: scenario.plan.planId,
      contextFingerprint: scenario.plan.contextFingerprint,
      resourceRevision: resource.revision,
      policyRevision: scenario.plan.policyRevision,
      expiresAt: scenario.plan.expiresAt,
    },
  };
}

function expectedFor(
  scenario: MemoryAuthorizationConformanceScenario,
): Readonly<Record<string, MemoryAuthorizationConformanceDecision>> {
  return Object.fromEntries(
    scenario.resources.map((resource) => [
      resource.resourceId,
      evaluateMemoryAuthorizationConformanceScenario({ scenario, resource }),
    ]),
  );
}

/** Deterministic generated cases spanning every Phase 0 policy invariant. */
export function createMemoryAuthorizationConformanceCases(): MemoryAuthorizationConformanceCase[] {
  return createMemoryAuthorizationConformanceScenarios().map((scenario) => ({
    id: scenario.id,
    scenario,
    expected: expectedFor(scenario),
  }));
}

function decisionsMatch(
  actual: MemoryAuthorizationConformanceDecision,
  expected: MemoryAuthorizationConformanceDecision,
): boolean {
  if (actual.allowed !== expected.allowed || actual.reasonCode !== expected.reasonCode) {
    return false;
  }
  return true;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function expiresNoLaterThan(expiresAt: string, maximumExpiresAt: string): boolean {
  const expiresAtMs = Date.parse(expiresAt);
  const maximumExpiresAtMs = Date.parse(maximumExpiresAt);
  // A handle can be narrower than its plan, but never survive the plan that issued it.
  return (
    Number.isFinite(expiresAtMs) &&
    Number.isFinite(maximumExpiresAtMs) &&
    expiresAtMs <= maximumExpiresAtMs
  );
}

function hasAuthorizedResourceHandle(params: {
  decision: MemoryAuthorizationConformanceDecision;
  scenario: MemoryAuthorizationConformanceScenario;
  resource: MemoryAuthorizationConformanceResource;
}): boolean {
  const { decision, resource, scenario } = params;
  if (!decision.allowed || !isRecord(decision.handle)) {
    return false;
  }
  const handle = decision.handle;
  const prototype = Object.getPrototypeOf(handle);
  const ownKeys = Reflect.ownKeys(handle);
  // The opaque ID has no prescribed encoding; its surrounding facts prevent it becoming a bearer grant.
  return (
    (prototype === Object.prototype || prototype === null) &&
    ownKeys.length === 7 &&
    ownKeys.includes("version") &&
    ownKeys.includes("handleId") &&
    ownKeys.includes("planId") &&
    ownKeys.includes("contextFingerprint") &&
    ownKeys.includes("resourceRevision") &&
    ownKeys.includes("policyRevision") &&
    ownKeys.includes("expiresAt") &&
    handle.version === MEMORY_AUTHORIZATION_CONTRACT_VERSION &&
    isNonEmptyText(handle.handleId) &&
    isNonEmptyText(handle.planId) &&
    isNonEmptyText(handle.contextFingerprint) &&
    isNonEmptyText(handle.resourceRevision) &&
    isNonEmptyText(handle.policyRevision) &&
    isNonEmptyText(handle.expiresAt) &&
    handle.planId === scenario.plan.planId &&
    handle.contextFingerprint === scenario.plan.contextFingerprint &&
    handle.resourceRevision === resource.revision &&
    handle.policyRevision === scenario.plan.policyRevision &&
    hasCurrentConformanceEvidenceExpiry(handle.expiresAt, scenario.now) &&
    expiresNoLaterThan(handle.expiresAt, scenario.plan.expiresAt)
  );
}

function isSafeDeniedDecision(decision: MemoryAuthorizationConformanceDecision): boolean {
  const prototype = Object.getPrototypeOf(decision);
  const ownKeys = Reflect.ownKeys(decision);
  return (
    (prototype === Object.prototype || prototype === null) &&
    ownKeys.length === 2 &&
    ownKeys.includes("allowed") &&
    ownKeys.includes("reasonCode") &&
    !decision.allowed
  );
}

/** Runs the reusable suite without taking a dependency on a specific test framework. */
export async function runMemoryAuthorizationConformanceSuite(
  adapter: MemoryAuthorizationConformanceAdapter,
): Promise<MemoryAuthorizationConformanceReport> {
  const failures: Array<MemoryAuthorizationConformanceReport["failures"][number]> = [];
  for (const testCase of createMemoryAuthorizationConformanceCases()) {
    const prefilter = [...(await adapter.prefilter(testCase.scenario))];
    if (new Set(prefilter).size !== prefilter.length) {
      failures.push({
        caseId: testCase.id,
        invariant: "duplicate-prefilter-candidate",
      });
    }
    for (const resource of testCase.scenario.resources) {
      const decision = await adapter.evaluate({ scenario: testCase.scenario, resource });
      const expected = testCase.expected[resource.resourceId];
      if (!expected || !decisionsMatch(decision, expected)) {
        failures.push({ caseId: testCase.id, invariant: "decision" });
      }
      if (
        decision.allowed &&
        !hasAuthorizedResourceHandle({ decision, scenario: testCase.scenario, resource })
      ) {
        failures.push({ caseId: testCase.id, invariant: "authorized-handle" });
      }
      if (!decision.allowed && !isSafeDeniedDecision(decision)) {
        failures.push({ caseId: testCase.id, invariant: "denial-non-disclosure" });
      }
      if (expected?.allowed && !prefilter.includes(resource.resourceId)) {
        failures.push({ caseId: testCase.id, invariant: "prefilter-superset" });
      }
    }
  }
  return Object.freeze({
    ok: failures.length === 0,
    failures: Object.freeze(failures.map((failure) => Object.freeze(failure))),
  });
}

export const referenceMemoryAuthorizationConformanceAdapter: MemoryAuthorizationConformanceAdapter =
  Object.freeze({
    evaluate: evaluateMemoryAuthorizationConformanceScenario,
    prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
  });
