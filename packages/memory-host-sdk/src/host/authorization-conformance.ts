import type {
  AudienceRef,
  MemoryAuthorizationReasonCode,
  MemoryOperation,
} from "./authorization.js";

export type MemoryAuthorizationConformancePrincipal = Readonly<{
  principalId: string;
}>;

export type MemoryAuthorizationConformanceStore = Readonly<{
  storeId: string;
  agentId: string;
  placementCapabilities: readonly MemoryOperation[];
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

export type MemoryAuthorizationConformancePlanBinding = Readonly<{
  contextFingerprint: string;
  agentId: string;
  sessionIdentityRevision: string;
  subjectRevision: string;
  deliveryRevision: string;
  policyRevision: string;
  operation: MemoryOperation;
  expiresAt: string;
}>;

export type MemoryAuthorizationConformanceScenario = Readonly<{
  id: string;
  now: string;
  principals: readonly MemoryAuthorizationConformancePrincipal[];
  stores: readonly MemoryAuthorizationConformanceStore[];
  resources: readonly MemoryAuthorizationConformanceResource[];
  policyEntries: readonly MemoryAuthorizationConformancePolicyEntry[];
  viewStoreIds: readonly string[];
  context: Readonly<{
    contextFingerprint: string;
    agentId: string;
    sessionIdentityRevision: string;
    subjectRevision: string;
    deliveryRevision: string;
    policyRevision: string;
    operation: MemoryOperation;
    principalIds: readonly string[];
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
      handle: string;
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
      | "denial-non-disclosure"
      | "prefilter-superset"
      | "duplicate-prefilter-candidate";
  }>[];
}>;

const OPERATION_REQUIREMENTS: Readonly<Record<MemoryOperation, readonly MemoryOperation[]>> = {
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
};

function audienceKey(audience: AudienceRef): string {
  return `${audience.kind}\0${audience.id}`;
}

function isExpired(expiresAt: string | undefined, now: string): boolean {
  if (expiresAt === undefined) {
    return false;
  }
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  return !Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs) || expiresAtMs <= nowMs;
}

function policyEntryMatches(params: {
  entry: MemoryAuthorizationConformancePolicyEntry;
  scenario: MemoryAuthorizationConformanceScenario;
  resource: MemoryAuthorizationConformanceResource;
  operation: MemoryOperation;
}): boolean {
  const { entry, scenario, resource, operation } = params;
  return (
    entry.operation === operation &&
    (entry.resourceId === "*" || entry.resourceId === resource.resourceId) &&
    (entry.principalId === "*" || scenario.context.principalIds.includes(entry.principalId)) &&
    !isExpired(entry.expiresAt, scenario.now)
  );
}

function planBindingFailure(
  scenario: MemoryAuthorizationConformanceScenario,
): MemoryAuthorizationReasonCode | null {
  const { context, plan } = scenario;
  if (isExpired(plan.expiresAt, scenario.now)) {
    return "plan-expired";
  }
  if (plan.contextFingerprint !== context.contextFingerprint) {
    return "invalid-context";
  }
  if (plan.agentId !== context.agentId || plan.operation !== context.operation) {
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

  const store = scenario.stores.find((entry) => entry.storeId === resource.storeId);
  if (
    !store ||
    store.agentId !== scenario.context.agentId ||
    resource.agentId !== scenario.context.agentId ||
    !scenario.viewStoreIds.includes(resource.storeId)
  ) {
    return { allowed: false, reasonCode: "outside-view" };
  }
  if (isExpired(resource.expiresAt, scenario.now)) {
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

  const requiredOperations = OPERATION_REQUIREMENTS[scenario.context.operation];
  for (const operation of requiredOperations) {
    if (
      scenario.policyEntries.some(
        (entry) =>
          entry.effect === "deny" && policyEntryMatches({ entry, scenario, resource, operation }),
      )
    ) {
      return { allowed: false, reasonCode: "explicit-deny" };
    }
  }
  for (const operation of requiredOperations) {
    const placed = store.placementCapabilities.includes(operation);
    const explicitlyAllowed = scenario.policyEntries.some(
      (entry) =>
        entry.effect === "allow" && policyEntryMatches({ entry, scenario, resource, operation }),
    );
    if (!placed && !explicitlyAllowed) {
      return { allowed: false, reasonCode: "default-deny" };
    }
  }

  return {
    allowed: true,
    reasonCode: "allowed",
    handle: `authorized:${resource.resourceId}:${resource.revision}`,
  };
}

function baseScenario(
  id: string,
  overrides: Partial<MemoryAuthorizationConformanceScenario> = {},
): MemoryAuthorizationConformanceScenario {
  const now = "2026-07-29T12:00:00.000Z";
  const userAudience = { kind: "user", id: "principal-owner" } as const;
  const context = {
    contextFingerprint: "context-revision-1",
    agentId: "agent-a",
    sessionIdentityRevision: "session-revision-1",
    subjectRevision: "subject-revision-1",
    deliveryRevision: "delivery-revision-1",
    policyRevision: "policy-revision-1",
    operation: "read" as const,
    principalIds: ["principal-owner"],
    deliveryAudiences: [userAudience],
    lineagePolicySetIds: ["lineage-1"],
  };
  const scenario: MemoryAuthorizationConformanceScenario = {
    id,
    now,
    principals: [{ principalId: "principal-owner" }],
    stores: [
      {
        storeId: "store-a",
        agentId: "agent-a",
        placementCapabilities: [],
      },
    ],
    resources: [
      {
        resourceId: "resource-a",
        agentId: "agent-a",
        storeId: "store-a",
        revision: "resource-revision-1",
        audiences: [userAudience],
      },
    ],
    policyEntries: [
      {
        effect: "allow",
        principalId: "principal-owner",
        resourceId: "resource-a",
        operation: "retrieve",
      },
      {
        effect: "allow",
        principalId: "principal-owner",
        resourceId: "resource-a",
        operation: "read",
      },
    ],
    viewStoreIds: ["store-a"],
    context,
    plan: {
      contextFingerprint: context.contextFingerprint,
      agentId: context.agentId,
      sessionIdentityRevision: context.sessionIdentityRevision,
      subjectRevision: context.subjectRevision,
      deliveryRevision: context.deliveryRevision,
      policyRevision: context.policyRevision,
      operation: context.operation,
      expiresAt: "2026-07-29T12:05:00.000Z",
    },
    ...overrides,
  };
  return scenario;
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
  const cases: MemoryAuthorizationConformanceScenario[] = [];

  const denyPrecedence = baseScenario("deny-precedence");
  cases.push({
    ...denyPrecedence,
    policyEntries: [
      ...denyPrecedence.policyEntries,
      {
        effect: "deny",
        principalId: "principal-owner",
        resourceId: "resource-a",
        operation: "read",
      },
    ],
  });

  const permissionImplication = baseScenario("permission-implication");
  cases.push({
    ...permissionImplication,
    policyEntries: permissionImplication.policyEntries.filter(
      (entry) => entry.operation !== "retrieve",
    ),
  });

  cases.push(baseScenario("permission-complete"));

  const crossAgent = baseScenario("cross-agent-cell");
  cases.push({
    ...crossAgent,
    resources: crossAgent.resources.map((resource) =>
      Object.assign({}, resource, { agentId: "agent-b" }),
    ),
  });

  const staleContext = baseScenario("plan-context-revision");
  cases.push({
    ...staleContext,
    context: { ...staleContext.context, subjectRevision: "subject-revision-2" },
  });

  const expiredPlan = baseScenario("plan-expiry");
  cases.push({
    ...expiredPlan,
    plan: { ...expiredPlan.plan, expiresAt: "2026-07-29T11:59:59.000Z" },
  });

  const audienceIntersection = baseScenario("delivery-audience-intersection");
  cases.push({
    ...audienceIntersection,
    context: {
      ...audienceIntersection.context,
      deliveryAudiences: [{ kind: "conversation", id: "conversation-b" }],
    },
  });

  const delegationIntersection = baseScenario("delegation-intersection");
  cases.push({
    ...delegationIntersection,
    context: {
      ...delegationIntersection.context,
      delegation: {
        allowedOperations: ["retrieve"],
        maximumAudiences: delegationIntersection.context.deliveryAudiences,
      },
    },
  });

  const lineage = baseScenario("lineage-requirements");
  cases.push({
    ...lineage,
    resources: lineage.resources.map((resource) =>
      Object.assign({}, resource, {
        requiredLineagePolicySetIds: ["lineage-1", "lineage-2"],
      }),
    ),
  });

  const prefilter = baseScenario("prefilter-superset");
  cases.push({
    ...prefilter,
    resources: [
      ...prefilter.resources,
      {
        resourceId: "resource-denied",
        agentId: "agent-b",
        storeId: "store-a",
        revision: "resource-revision-2",
        audiences: prefilter.context.deliveryAudiences,
      },
    ],
  });

  return cases.map((scenario) => ({
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
  return !actual.allowed || actual.handle === (expected as { handle: string }).handle;
}

function isSafeDeniedDecision(decision: MemoryAuthorizationConformanceDecision): boolean {
  return !decision.allowed && Object.keys(decision).toSorted().join("\0") === "allowed\0reasonCode";
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
