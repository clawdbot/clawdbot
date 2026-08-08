import { describe, expect, it } from "vitest";
import {
  COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
  LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
  MEMORY_AUTHORIZATION_CAPABILITY_NAMES,
  MEMORY_AUTHORIZATION_CONTRACT_VERSION,
  createMemoryAuthorizationConformanceCases,
  evaluateMemoryAuthorizationConformanceScenario,
  hasCompleteMemoryAuthorizationCapabilities,
  isMemoryAuthorizationCapabilities,
  listMissingMemoryAuthorizationCapabilities,
  referenceMemoryAuthorizationConformanceAdapter,
  runMemoryAuthorizationConformanceSuite,
  type MemoryAccessContext,
  type MemoryAuthorizationConformanceAdapter,
  type MemoryAuthorizationConformanceDecision,
} from "../../plugin-sdk/memory-authorization.js";
import * as memoryAuthorizationSdk from "../../plugin-sdk/memory-authorization.js";

function createSerializableContext(): MemoryAccessContext {
  return {
    version: 1,
    contextId: "context-1",
    contextFingerprint: "sha256:fingerprint",
    requestId: "request-1",
    runId: "run-1",
    agentId: "agent-a",
    sessionKey: "agent:agent-a:main",
    sessionId: "session-1",
    sessionIdentityRevision: "session-revision-1",
    subjectRevision: "subject-revision-1",
    subject: {
      version: 1,
      kind: "user",
      principalId: "principal-owner",
      creationEvidence: { kind: "gateway-profile", revision: "creation-revision-1" },
    },
    actor: {
      kind: "principal",
      actorKind: "human",
      principalId: "principal-owner",
      assurance: "gateway-profile",
      evidenceRevision: "actor-revision-1",
    },
    verifiedPrincipals: [],
    delivery: {
      sinkKind: "private",
      audiences: [{ kind: "user", id: "principal-owner" }],
      egressCapabilityIds: ["reply.final"],
      egressRegistryRevision: "egress-revision-1",
      deliveryRevision: "delivery-revision-1",
    },
    collaboration: { kind: "not-applicable" },
    verifiedMemberships: [],
    operation: "read",
    hostFactsRevision: "host-facts-revision-1",
  };
}

describe("memory authorization SDK contract", () => {
  it("exports the complete narrow contract and conformance surface", () => {
    expect(Object.keys(memoryAuthorizationSdk)).toEqual(
      expect.arrayContaining([
        "COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES",
        "LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES",
        "MEMORY_AUTHORIZATION_CAPABILITY_NAMES",
        "MEMORY_AUTHORIZATION_CONTRACT_VERSION",
        "MEMORY_OPERATIONS",
        "createMemoryAuthorizationConformanceCases",
        "evaluateMemoryAuthorizationConformanceScenario",
        "hasCompleteMemoryAuthorizationCapabilities",
        "isMemoryAuthorizationCapabilities",
        "listMissingMemoryAuthorizationCapabilities",
        "referenceMemoryAuthorizationConformanceAdapter",
        "runMemoryAuthorizationConformanceSuite",
      ]),
    );
  });

  it("keeps serializable shapes free of in-process brands", () => {
    const context = createSerializableContext();
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- This test exercises JSON transport.
    const roundTrip = JSON.parse(JSON.stringify(context));

    expect(roundTrip).toEqual(context);
    expect(Object.getOwnPropertySymbols(context)).toEqual([]);
    expect(MEMORY_AUTHORIZATION_CONTRACT_VERSION).toBe(1);
  });

  it("validates exact backend capability declarations", () => {
    expect(isMemoryAuthorizationCapabilities(COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES)).toBe(
      true,
    );
    expect(
      hasCompleteMemoryAuthorizationCapabilities(COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES),
    ).toBe(true);
    expect(
      listMissingMemoryAuthorizationCapabilities(COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES),
    ).toEqual([]);
    expect(
      listMissingMemoryAuthorizationCapabilities(LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES),
    ).toEqual(MEMORY_AUTHORIZATION_CAPABILITY_NAMES);
    expect(isMemoryAuthorizationCapabilities({ version: 1 })).toBe(false);
    expect(
      isMemoryAuthorizationCapabilities({
        ...COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
        version: 2,
      }),
    ).toBe(false);
    expect(Object.isFrozen(COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES)).toBe(true);
  });
});

describe("memory authorization conformance suite", () => {
  it("passes the deterministic reference evaluator", async () => {
    await expect(
      runMemoryAuthorizationConformanceSuite(referenceMemoryAuthorizationConformanceAdapter),
    ).resolves.toEqual({ ok: true, failures: [] });
  });

  it("generates every Phase 0 policy invariant", () => {
    const cases = createMemoryAuthorizationConformanceCases();
    expect(cases.map((entry) => entry.id)).toEqual([
      "deny-precedence",
      "permission-implication",
      "permission-complete",
      "cross-agent-cell",
      "plan-context-revision",
      "plan-expiry",
      "delivery-audience-intersection",
      "delegation-intersection",
      "lineage-requirements",
      "prefilter-superset",
    ]);
    expect(
      Object.fromEntries(cases.map((entry) => [entry.id, entry.expected["resource-a"]])),
    ).toEqual({
      "deny-precedence": { allowed: false, reasonCode: "explicit-deny" },
      "permission-implication": { allowed: false, reasonCode: "default-deny" },
      "permission-complete": {
        allowed: true,
        reasonCode: "allowed",
        handle: "authorized:resource-a:resource-revision-1",
      },
      "cross-agent-cell": { allowed: false, reasonCode: "outside-view" },
      "plan-context-revision": { allowed: false, reasonCode: "revision-stale" },
      "plan-expiry": { allowed: false, reasonCode: "plan-expired" },
      "delivery-audience-intersection": { allowed: false, reasonCode: "outside-view" },
      "delegation-intersection": { allowed: false, reasonCode: "default-deny" },
      "lineage-requirements": { allowed: false, reasonCode: "lineage-deny" },
      "prefilter-superset": {
        allowed: true,
        reasonCode: "allowed",
        handle: "authorized:resource-a:resource-revision-1",
      },
    });
    expect(cases.at(-1)?.expected["resource-denied"]).toEqual({
      allowed: false,
      reasonCode: "outside-view",
    });
  });

  it("fails closed for malformed plan, resource, and policy expiry", () => {
    const scenario = createMemoryAuthorizationConformanceCases().find(
      (entry) => entry.id === "permission-complete",
    )?.scenario;
    expect(scenario).toBeDefined();
    const resource = scenario!.resources[0]!;

    expect(
      evaluateMemoryAuthorizationConformanceScenario({
        scenario: {
          ...scenario!,
          plan: { ...scenario!.plan, expiresAt: "" },
        },
        resource,
      }),
    ).toEqual({ allowed: false, reasonCode: "plan-expired" });
    expect(
      evaluateMemoryAuthorizationConformanceScenario({
        scenario: scenario!,
        resource: { ...resource, expiresAt: "" },
      }),
    ).toEqual({ allowed: false, reasonCode: "revision-stale" });
    expect(
      evaluateMemoryAuthorizationConformanceScenario({
        scenario: {
          ...scenario!,
          policyEntries: scenario!.policyEntries.map((entry) =>
            Object.assign({}, entry, { expiresAt: "" }),
          ),
        },
        resource,
      }),
    ).toEqual({ allowed: false, reasonCode: "default-deny" });
  });

  it("rejects a context-free allow-all adapter", async () => {
    const adapter: MemoryAuthorizationConformanceAdapter = {
      evaluate: ({ resource }) => ({
        allowed: true,
        reasonCode: "allowed",
        handle: `raw:${resource.resourceId}`,
      }),
      prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
    };

    const report = await runMemoryAuthorizationConformanceSuite(adapter);
    expect(report.ok).toBe(false);
    expect(report.failures).toContainEqual(expect.objectContaining({ invariant: "decision" }));
  });

  it("rejects denial metadata that reveals counts, scores, paths, or citations", async () => {
    const adapter: MemoryAuthorizationConformanceAdapter = {
      evaluate: (params) => {
        const decision = evaluateMemoryAuthorizationConformanceScenario(params);
        if (decision.allowed) {
          return decision;
        }
        return {
          ...decision,
          count: 1,
          score: 0.99,
          path: "private/other-user.md",
          title: "private",
          citation: "private/other-user.md#L1",
          cursor: "next-secret",
          denialDetail: "principal-owner",
        } as unknown as MemoryAuthorizationConformanceDecision;
      },
      prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
    };

    const report = await runMemoryAuthorizationConformanceSuite(adapter);
    expect(report.ok).toBe(false);
    expect(report.failures).toContainEqual(
      expect.objectContaining({ invariant: "denial-non-disclosure" }),
    );
  });

  it("rejects prefilter false negatives and duplicate candidates", async () => {
    const falseNegative: MemoryAuthorizationConformanceAdapter = {
      evaluate: evaluateMemoryAuthorizationConformanceScenario,
      prefilter: () => [],
    };
    const duplicate: MemoryAuthorizationConformanceAdapter = {
      evaluate: evaluateMemoryAuthorizationConformanceScenario,
      prefilter: (scenario) => {
        const ids = scenario.resources.map((resource) => resource.resourceId);
        return [...ids, ...(ids[0] ? [ids[0]] : [])];
      },
    };

    const falseNegativeReport = await runMemoryAuthorizationConformanceSuite(falseNegative);
    const duplicateReport = await runMemoryAuthorizationConformanceSuite(duplicate);
    expect(falseNegativeReport.failures).toContainEqual(
      expect.objectContaining({ invariant: "prefilter-superset" }),
    );
    expect(duplicateReport.failures).toContainEqual(
      expect.objectContaining({ invariant: "duplicate-prefilter-candidate" }),
    );
  });
});
