import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createMemoryAuthorizationConformanceCases,
  evaluateMemoryAuthorizationConformanceScenario,
  referenceMemoryAuthorizationConformanceAdapter,
  runMemoryAuthorizationConformanceSuite,
  type MemoryAuthorizationConformanceAdapter,
  type MemoryAuthorizationConformanceDecision,
} from "../../plugin-sdk/memory-authorization-conformance.js";
import * as memoryAuthorizationConformanceSdk from "../../plugin-sdk/memory-authorization-conformance.js";
import {
  COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
  LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
  MEMORY_AUTHORIZATION_CAPABILITY_NAMES,
  MEMORY_AUTHORIZATION_CONTRACT_VERSION,
  MEMORY_OPERATIONS,
  hasCompleteMemoryAuthorizationCapabilities,
  isMemoryAuthorizationCapabilities,
  listMissingMemoryAuthorizationCapabilities,
  type MemoryAccessContext,
  type AuthorizedMemoryMutation,
  type AuthorizedMemoryContentPlan,
  type AuthorizedMemoryPlan,
  type AuthorizedMemoryPlanForContext,
  type AuthorizedMemoryRuntime,
  type AuthorizedMemorySearchResult,
  type AuthorizedMemoryStatus,
  type AuthorizedResourceHandle,
  type MemoryContentAccessContext,
  type MemoryAuthorizationCapabilities,
} from "../../plugin-sdk/memory-authorization.js";
import * as memoryAuthorizationSdk from "../../plugin-sdk/memory-authorization.js";
import type {
  MemoryPluginCapability,
  MemoryPluginRuntime,
} from "../registry-contribution-types.js";

type AuthorizedMutationForOperation<Operation extends AuthorizedMemoryMutation["kind"]> =
  AuthorizedMemoryMutation & Readonly<{ kind: Operation }>;

type IsNever<Value> = [Value] extends [never] ? true : false;

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

function createAllowedHandleAdapter(
  transformHandle: (handle: AuthorizedResourceHandle) => unknown,
): MemoryAuthorizationConformanceAdapter {
  return {
    evaluate: (params) => {
      const decision = evaluateMemoryAuthorizationConformanceScenario(params);
      return decision.allowed
        ? ({
            ...decision,
            handle: transformHandle(decision.handle),
          } as unknown as MemoryAuthorizationConformanceDecision)
        : decision;
    },
    prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
  };
}

describe("memory authorization SDK contract", () => {
  it("keeps the runtime contract separate from the conformance harness", () => {
    expect(Object.keys(memoryAuthorizationSdk)).toEqual(
      expect.arrayContaining([
        "COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES",
        "LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES",
        "MEMORY_AUTHORIZATION_CAPABILITY_NAMES",
        "MEMORY_AUTHORIZATION_CONTRACT_VERSION",
        "MEMORY_OPERATIONS",
        "hasCompleteMemoryAuthorizationCapabilities",
        "isMemoryAuthorizationCapabilities",
        "listMissingMemoryAuthorizationCapabilities",
      ]),
    );
    expect(memoryAuthorizationSdk).not.toHaveProperty("createMemoryAuthorizationConformanceCases");
    expect(Object.keys(memoryAuthorizationConformanceSdk)).toEqual(
      expect.arrayContaining([
        "createMemoryAuthorizationConformanceCases",
        "evaluateMemoryAuthorizationConformanceScenario",
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
    expect(Object.isFrozen(MEMORY_AUTHORIZATION_CAPABILITY_NAMES)).toBe(true);
  });

  it("rejects non-exact capability declarations without invoking accessors", () => {
    const unexpectedKey = { ...COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES, unexpected: true };
    const symbolKey = {
      ...COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
      [Symbol("unexpected")]: true,
    };
    const inherited = Object.create(COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES);
    let getterCalls = 0;
    const accessor = { ...COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES };
    Object.defineProperty(accessor, "scopedCandidates", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return true;
      },
    });
    const throwingProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("capability proxy trap");
        },
      },
    );

    for (const declaration of [unexpectedKey, symbolKey, inherited, accessor, throwingProxy]) {
      expect(isMemoryAuthorizationCapabilities(declaration)).toBe(false);
      expect(listMissingMemoryAuthorizationCapabilities(declaration)).toEqual(
        MEMORY_AUTHORIZATION_CAPABILITY_NAMES,
      );
    }
    expect(getterCalls).toBe(0);
  });

  it("makes authorized search results the exact-read continuation input", () => {
    type SearchResult = Awaited<
      ReturnType<AuthorizedMemoryRuntime["searchAuthorized"]>
    >["value"][number];
    type ReadHandle = Parameters<AuthorizedMemoryRuntime["readAuthorized"]>[0]["handle"];

    expectTypeOf<SearchResult>().toEqualTypeOf<AuthorizedMemorySearchResult>();
    expectTypeOf<SearchResult["resourceHandle"]>().toEqualTypeOf<AuthorizedResourceHandle>();
    expectTypeOf<SearchResult["resourceHandle"]>().toEqualTypeOf<ReadHandle>();
    expectTypeOf<
      Extract<MemoryAuthorizationConformanceDecision, { allowed: true }>["handle"]
    >().toEqualTypeOf<AuthorizedResourceHandle>();
  });

  it("keeps authorized status backend-neutral and separate from host diagnostics", () => {
    type StatusResult = Awaited<ReturnType<AuthorizedMemoryRuntime["statusAuthorized"]>>["value"];
    type HostOnlyDiagnostics = Extract<
      "workspaceDir" | "dbPath" | "extraPaths" | "custom",
      keyof AuthorizedMemoryStatus
    >;
    const thirdPartyStatus = {
      version: 1,
      backend: "remote-memory",
      provider: "remote-embeddings",
      model: "remote-model",
      files: 3,
      chunks: 12,
      dirty: false,
    } satisfies AuthorizedMemoryStatus;

    expectTypeOf<StatusResult>().toEqualTypeOf<AuthorizedMemoryStatus>();
    expectTypeOf<StatusResult["backend"]>().toEqualTypeOf<string>();
    expectTypeOf<HostOnlyDiagnostics>().toEqualTypeOf<never>();
    expect(thirdPartyStatus.backend).toBe("remote-memory");
  });

  it("limits content-bearing search and exact reads to read or derive", () => {
    const assertContentOperationContract = (
      runtime: AuthorizedMemoryRuntime,
      readContext: MemoryContentAccessContext<"read">,
      readPlan: AuthorizedMemoryContentPlan<"read">,
      deriveContext: MemoryContentAccessContext<"derive">,
      derivePlan: AuthorizedMemoryContentPlan<"derive">,
      retrieveContext: MemoryAccessContext & Readonly<{ operation: "retrieve" }>,
      retrievePlan: AuthorizedMemoryPlan & Readonly<{ operation: "retrieve" }>,
      handle: AuthorizedResourceHandle,
    ) => {
      void runtime.searchAuthorized({
        context: readContext,
        plan: readPlan,
        query: "query",
        limit: 1,
      });
      void runtime.searchAuthorized({
        context: deriveContext,
        plan: derivePlan,
        query: "query",
        limit: 1,
      });
      void runtime.readAuthorized({ context: readContext, plan: readPlan, handle });
      void runtime.readAuthorized({ context: deriveContext, plan: derivePlan, handle });

      const readPlanFromAuthorize = runtime.authorize(readContext);
      const derivePlanFromAuthorize = runtime.authorize(deriveContext);
      expectTypeOf(readPlanFromAuthorize).toEqualTypeOf<
        Promise<AuthorizedMemoryPlanForContext<typeof readContext>>
      >();
      expectTypeOf(derivePlanFromAuthorize).toEqualTypeOf<
        Promise<AuthorizedMemoryPlanForContext<typeof deriveContext>>
      >();
      void readPlanFromAuthorize.then((plan) =>
        runtime.searchAuthorized({ context: readContext, plan, query: "query", limit: 1 }),
      );
      void derivePlanFromAuthorize.then((plan) =>
        runtime.readAuthorized({ context: deriveContext, plan, handle }),
      );

      void runtime.searchAuthorized({
        // @ts-expect-error retrieve only permits broker-internal candidate selection.
        context: retrieveContext,
        plan: derivePlan,
        query: "query",
        limit: 1,
      });
      // @ts-expect-error retrieve only permits broker-internal candidate selection.
      void runtime.readAuthorized({ context: retrieveContext, plan: retrievePlan, handle });
      void runtime.searchAuthorized({
        context: deriveContext,
        // @ts-expect-error the context and plan must name the same content operation.
        plan: readPlan,
        query: "query",
        limit: 1,
      });

      const retrievePlanFromAuthorize = runtime.authorize(retrieveContext);
      void retrievePlanFromAuthorize.then((plan) => {
        return runtime.searchAuthorized({
          context: deriveContext,
          // @ts-expect-error retrieve only permits broker-internal candidate selection.
          plan,
          query: "query",
          limit: 1,
        });
      });
    };

    expectTypeOf(assertContentOperationContract).toBeFunction();
  });

  it("binds every authorized action to its plan operation", () => {
    type ImportMutation = Parameters<AuthorizedMemoryRuntime["importAuthorized"]>[0]["mutation"];
    expectTypeOf<IsNever<ImportMutation>>().toEqualTypeOf<false>();

    const assertActionOperationContract = (
      runtime: AuthorizedMemoryRuntime,
      retrieveContext: MemoryAccessContext & Readonly<{ operation: "retrieve" }>,
      retrievePlan: AuthorizedMemoryPlan & Readonly<{ operation: "retrieve" }>,
      appendContext: MemoryAccessContext & Readonly<{ operation: "append" }>,
      appendPlan: AuthorizedMemoryPlan & Readonly<{ operation: "append" }>,
      appendMutation: AuthorizedMutationForOperation<"append">,
      importContext: MemoryAccessContext & Readonly<{ operation: "import" }>,
      importPlan: AuthorizedMemoryPlan & Readonly<{ operation: "import" }>,
      importMutation: AuthorizedMutationForOperation<"import">,
      syncContext: MemoryAccessContext & Readonly<{ operation: "sync" }>,
      syncPlan: AuthorizedMemoryPlan & Readonly<{ operation: "sync" }>,
      exportContext: MemoryAccessContext & Readonly<{ operation: "export" }>,
      exportPlan: AuthorizedMemoryPlan & Readonly<{ operation: "export" }>,
      statusContext: MemoryAccessContext & Readonly<{ operation: "status" }>,
      statusPlan: AuthorizedMemoryPlan & Readonly<{ operation: "status" }>,
      handle: AuthorizedResourceHandle,
    ) => {
      void runtime.writeAuthorized({
        context: appendContext,
        plan: appendPlan,
        mutation: appendMutation,
      });
      void runtime.importAuthorized({
        context: importContext,
        plan: importPlan,
        mutation: importMutation,
      });
      void runtime.syncAuthorized({ context: syncContext, plan: syncPlan });
      void runtime.exportAuthorized({
        context: exportContext,
        plan: exportPlan,
        handles: [handle],
      });
      const exportPlanFromAuthorize = runtime.authorize(exportContext);
      void exportPlanFromAuthorize.then((plan) =>
        runtime.exportAuthorized({ context: exportContext, plan, handles: [handle] }),
      );
      void runtime.statusAuthorized({ context: statusContext, plan: statusPlan });

      void runtime.writeAuthorized({
        // @ts-expect-error retrieve may select candidates only inside the broker.
        context: retrieveContext,
        plan: appendPlan,
        mutation: appendMutation,
      });
      // @ts-expect-error the mutation kind must match the context and plan operation.
      void runtime.writeAuthorized({
        context: appendContext,
        plan: appendPlan,
        mutation: importMutation,
      });
      void runtime.importAuthorized({
        // @ts-expect-error retrieve may not invoke an import action.
        context: retrieveContext,
        plan: importPlan,
        mutation: importMutation,
      });
      // @ts-expect-error retrieve may not invoke a sync action.
      void runtime.syncAuthorized({ context: retrieveContext, plan: retrievePlan });
      void runtime.exportAuthorized({
        // @ts-expect-error retrieve may not produce a content-bearing export payload.
        context: retrieveContext,
        plan: exportPlan,
        handles: [handle],
      });
      // @ts-expect-error retrieve may not invoke a status action.
      void runtime.statusAuthorized({ context: retrieveContext, plan: retrievePlan });
    };

    expectTypeOf(assertActionOperationContract).toBeFunction();
  });

  it("declares authorization on the selected capability and methods on its optional runtime", () => {
    type SelectedAuthorizationMembers =
      | "authorize"
      | "searchAuthorized"
      | "readAuthorized"
      | "writeAuthorized"
      | "importAuthorized"
      | "syncAuthorized"
      | "exportAuthorized"
      | "statusAuthorized";
    type MissingSelectedAuthorizationMembers = Exclude<
      SelectedAuthorizationMembers,
      keyof MemoryPluginRuntime
    >;

    expectTypeOf<MissingSelectedAuthorizationMembers>().toEqualTypeOf<never>();
    expectTypeOf<Extract<"authorization", keyof MemoryPluginRuntime>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<"authorization", keyof AuthorizedMemoryRuntime>>().toEqualTypeOf<never>();
    expectTypeOf<
      NonNullable<MemoryPluginCapability["authorization"]>
    >().toEqualTypeOf<MemoryAuthorizationCapabilities>();
    expectTypeOf<NonNullable<MemoryPluginRuntime["authorize"]>>().toEqualTypeOf<
      AuthorizedMemoryRuntime["authorize"]
    >();
    expectTypeOf<NonNullable<MemoryPluginRuntime["searchAuthorized"]>>().toEqualTypeOf<
      AuthorizedMemoryRuntime["searchAuthorized"]
    >();
    expectTypeOf<NonNullable<MemoryPluginRuntime["readAuthorized"]>>().toEqualTypeOf<
      AuthorizedMemoryRuntime["readAuthorized"]
    >();
    expectTypeOf<NonNullable<MemoryPluginRuntime["writeAuthorized"]>>().toEqualTypeOf<
      AuthorizedMemoryRuntime["writeAuthorized"]
    >();
    expectTypeOf<NonNullable<MemoryPluginRuntime["importAuthorized"]>>().toEqualTypeOf<
      AuthorizedMemoryRuntime["importAuthorized"]
    >();
    expectTypeOf<NonNullable<MemoryPluginRuntime["syncAuthorized"]>>().toEqualTypeOf<
      AuthorizedMemoryRuntime["syncAuthorized"]
    >();
    expectTypeOf<NonNullable<MemoryPluginRuntime["exportAuthorized"]>>().toEqualTypeOf<
      AuthorizedMemoryRuntime["exportAuthorized"]
    >();
    expectTypeOf<NonNullable<MemoryPluginRuntime["statusAuthorized"]>>().toEqualTypeOf<
      AuthorizedMemoryRuntime["statusAuthorized"]
    >();
  });

  it("keeps placement selection inside the authorized plan", () => {
    type HasRawPlacementOrDestination<T> = T extends unknown
      ? "placementHandle" extends keyof T
        ? true
        : "destinationHandle" extends keyof T
          ? true
          : false
      : never;

    expectTypeOf<HasRawPlacementOrDestination<AuthorizedMemoryMutation>>().toEqualTypeOf<false>();
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
    const operationCaseIds = MEMORY_OPERATIONS.flatMap((operation) => [
      `operation-${operation}-permission-complete`,
      `operation-${operation}-permission-missing-${operation}`,
      `operation-${operation}-explicit-deny`,
      `operation-${operation}-context-policy-revision`,
      `operation-${operation}-delivery-audience-intersection`,
      `operation-${operation}-delegation-intersection`,
    ]);
    expect(cases.map((entry) => entry.id)).toEqual([
      "deny-precedence",
      "permission-implication",
      "permission-complete",
      "retrieve-permission-complete",
      "derive-permission-complete",
      "derive-permission-missing-retrieve",
      "derive-permission-missing-read",
      "derive-permission-missing-derive",
      "replace-permission-complete",
      "replace-permission-missing-append",
      "replace-permission-missing-replace",
      ...operationCaseIds,
      "principal-revoked-retains-context-ref",
      "principal-expired",
      "principal-expiry-missing",
      "principal-missing",
      "principal-revision-mismatch",
      "principal-duplicate-ref",
      "principal-duplicate-host-fact",
      "membership-required-valid",
      "membership-required-expired",
      "membership-required-expiry-missing",
      "membership-required-revoked",
      "membership-required-removed",
      "membership-required-revision-mismatch",
      "membership-required-provider-mismatch",
      "membership-required-host-facts-revision-mismatch",
      "membership-required-duplicate-ref",
      "membership-required-duplicate-host-fact",
      "membership-required-principal-not-directly-verified",
      "membership-unrelated-stale-is-harmless",
      "cross-agent-cell",
      "plan-context-fingerprint",
      "plan-subject-revision",
      "plan-run-binding",
      "plan-session-binding",
      "plan-agent-binding",
      "plan-session-identity-revision",
      "plan-operation-binding",
      "plan-mount-binding",
      "plan-mount-capabilities",
      "plan-mount-agent-binding",
      "plan-mount-audience-revision",
      "plan-egress-audience-binding",
      "plan-policy-revision",
      "plan-delivery-revision",
      "plan-expiry",
      "plan-expiry-missing",
      "plan-id-missing",
      "plan-id-empty",
      "plan-host-facts-revision",
      "delivery-audience-intersection",
      "delegation-intersection",
      "lineage-requirements",
      "prefilter-superset",
    ]);
    expect(
      Object.fromEntries(cases.map((entry) => [entry.id, entry.expected["resource-a"]])),
    ).toMatchObject({
      "deny-precedence": { allowed: false, reasonCode: "explicit-deny" },
      "permission-implication": { allowed: false, reasonCode: "default-deny" },
      "permission-complete": { allowed: true, reasonCode: "allowed" },
      "retrieve-permission-complete": { allowed: true, reasonCode: "allowed" },
      "derive-permission-complete": { allowed: true, reasonCode: "allowed" },
      "derive-permission-missing-retrieve": { allowed: false, reasonCode: "default-deny" },
      "derive-permission-missing-read": { allowed: false, reasonCode: "default-deny" },
      "derive-permission-missing-derive": { allowed: false, reasonCode: "default-deny" },
      "replace-permission-complete": { allowed: true, reasonCode: "allowed" },
      "replace-permission-missing-append": { allowed: false, reasonCode: "default-deny" },
      "replace-permission-missing-replace": { allowed: false, reasonCode: "default-deny" },
      "principal-revoked-retains-context-ref": {
        allowed: false,
        reasonCode: "identity-revoked",
      },
      "principal-expired": { allowed: false, reasonCode: "identity-revoked" },
      "principal-expiry-missing": { allowed: false, reasonCode: "identity-revoked" },
      "principal-missing": { allowed: false, reasonCode: "identity-revoked" },
      "principal-revision-mismatch": { allowed: false, reasonCode: "identity-revoked" },
      "principal-duplicate-ref": { allowed: false, reasonCode: "identity-revoked" },
      "principal-duplicate-host-fact": { allowed: false, reasonCode: "identity-revoked" },
      "membership-required-valid": { allowed: true, reasonCode: "allowed" },
      "membership-required-expired": { allowed: false, reasonCode: "membership-stale" },
      "membership-required-expiry-missing": {
        allowed: false,
        reasonCode: "membership-stale",
      },
      "membership-required-revoked": { allowed: false, reasonCode: "membership-stale" },
      "membership-required-removed": { allowed: false, reasonCode: "membership-stale" },
      "membership-required-revision-mismatch": {
        allowed: false,
        reasonCode: "membership-stale",
      },
      "membership-required-provider-mismatch": {
        allowed: false,
        reasonCode: "membership-stale",
      },
      "membership-required-host-facts-revision-mismatch": {
        allowed: false,
        reasonCode: "membership-stale",
      },
      "membership-required-duplicate-ref": { allowed: false, reasonCode: "membership-stale" },
      "membership-required-duplicate-host-fact": {
        allowed: false,
        reasonCode: "membership-stale",
      },
      "membership-required-principal-not-directly-verified": {
        allowed: false,
        reasonCode: "membership-stale",
      },
      "membership-unrelated-stale-is-harmless": { allowed: true, reasonCode: "allowed" },
      "cross-agent-cell": { allowed: false, reasonCode: "outside-view" },
      "plan-context-fingerprint": { allowed: false, reasonCode: "invalid-context" },
      "plan-subject-revision": { allowed: false, reasonCode: "revision-stale" },
      "plan-run-binding": { allowed: false, reasonCode: "invalid-context" },
      "plan-session-binding": { allowed: false, reasonCode: "session-rebound" },
      "plan-agent-binding": { allowed: false, reasonCode: "outside-view" },
      "plan-session-identity-revision": { allowed: false, reasonCode: "revision-stale" },
      "plan-operation-binding": { allowed: false, reasonCode: "outside-view" },
      "plan-mount-binding": { allowed: false, reasonCode: "outside-view" },
      "plan-mount-capabilities": { allowed: false, reasonCode: "outside-view" },
      "plan-mount-agent-binding": { allowed: false, reasonCode: "outside-view" },
      "plan-mount-audience-revision": { allowed: false, reasonCode: "outside-view" },
      "plan-egress-audience-binding": { allowed: false, reasonCode: "outside-view" },
      "plan-policy-revision": { allowed: false, reasonCode: "revision-stale" },
      "plan-delivery-revision": { allowed: false, reasonCode: "delivery-rebound" },
      "plan-expiry": { allowed: false, reasonCode: "plan-expired" },
      "plan-expiry-missing": { allowed: false, reasonCode: "plan-expired" },
      "plan-id-missing": { allowed: false, reasonCode: "invalid-context" },
      "plan-id-empty": { allowed: false, reasonCode: "invalid-context" },
      "plan-host-facts-revision": { allowed: false, reasonCode: "revision-stale" },
      "delivery-audience-intersection": { allowed: false, reasonCode: "outside-view" },
      "delegation-intersection": { allowed: false, reasonCode: "default-deny" },
      "lineage-requirements": { allowed: false, reasonCode: "lineage-deny" },
      "prefilter-superset": { allowed: true, reasonCode: "allowed" },
    });
    const operationDecisions = Object.fromEntries(
      cases.map((entry) => [entry.id, entry.expected["resource-a"]]),
    );
    for (const operation of MEMORY_OPERATIONS) {
      expect(operationDecisions).toMatchObject({
        [`operation-${operation}-permission-complete`]: { allowed: true, reasonCode: "allowed" },
        [`operation-${operation}-permission-missing-${operation}`]: {
          allowed: false,
          reasonCode: "default-deny",
        },
        [`operation-${operation}-explicit-deny`]: {
          allowed: false,
          reasonCode: "explicit-deny",
        },
        [`operation-${operation}-context-policy-revision`]: {
          allowed: false,
          reasonCode: "revision-stale",
        },
        [`operation-${operation}-delivery-audience-intersection`]: {
          allowed: false,
          reasonCode: "outside-view",
        },
        [`operation-${operation}-delegation-intersection`]: {
          allowed: false,
          reasonCode: "default-deny",
        },
      });
    }
    expect(cases.at(-1)?.expected["resource-denied"]).toEqual({
      allowed: false,
      reasonCode: "outside-view",
    });
    const revoked = cases.find((entry) => entry.id === "principal-revoked-retains-context-ref");
    expect(revoked?.scenario.context.principalRefs).toEqual([
      {
        principalId: "principal-owner",
        evidenceRevision: "principal-evidence-revision-1",
      },
    ]);
    expect(revoked?.scenario.context).not.toHaveProperty("principalIds");
  });

  it("fails closed for omitted or malformed plan, resource, and policy expiry", () => {
    const scenario = createMemoryAuthorizationConformanceCases().find(
      (entry) => entry.id === "permission-complete",
    )?.scenario;
    expect(scenario).toBeDefined();
    const resource = scenario!.resources[0]!;
    const planWithoutExpiry = { ...scenario!.plan };
    Reflect.deleteProperty(planWithoutExpiry, "expiresAt");

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
        scenario: { ...scenario!, plan: planWithoutExpiry },
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
      evaluate: ({ resource }) =>
        ({
          allowed: true,
          reasonCode: "allowed",
          handle: `raw:${resource.resourceId}`,
        }) as unknown as MemoryAuthorizationConformanceDecision,
      prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
    };

    const report = await runMemoryAuthorizationConformanceSuite(adapter);
    expect(report.ok).toBe(false);
    expect(report.failures).toContainEqual(expect.objectContaining({ invariant: "decision" }));
  });

  it("rejects an adapter that treats raw context principal refs as policy authority", async () => {
    const adapter: MemoryAuthorizationConformanceAdapter = {
      evaluate: ({ resource, scenario }) =>
        evaluateMemoryAuthorizationConformanceScenario({
          resource,
          scenario: {
            ...scenario,
            // This is the unsafe legacy model: context IDs manufacture current principal facts.
            principals: scenario.context.principalRefs.map((ref) => ({
              principalId: ref.principalId,
              status: "active" as const,
              evidenceRevision: ref.evidenceRevision,
              expiresAt: "2026-07-29T12:05:00.000Z",
            })),
          },
        }),
      prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
    };

    const report = await runMemoryAuthorizationConformanceSuite(adapter);
    for (const caseId of [
      "principal-revoked-retains-context-ref",
      "principal-expired",
      "principal-expiry-missing",
      "principal-missing",
      "principal-revision-mismatch",
      "principal-duplicate-host-fact",
    ]) {
      expect(report.failures).toContainEqual(
        expect.objectContaining({ caseId, invariant: "decision" }),
      );
    }
  });

  it("rejects an adapter that bypasses selected-store membership evidence", async () => {
    const adapter: MemoryAuthorizationConformanceAdapter = {
      evaluate: ({ resource, scenario }) =>
        evaluateMemoryAuthorizationConformanceScenario({
          resource,
          scenario: {
            ...scenario,
            stores: scenario.stores.map((store) => {
              const directPrincipalStore = { ...store };
              Reflect.deleteProperty(directPrincipalStore, "requiredMembership");
              return directPrincipalStore;
            }),
          },
        }),
      prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
    };

    const report = await runMemoryAuthorizationConformanceSuite(adapter);
    for (const caseId of [
      "membership-required-expired",
      "membership-required-expiry-missing",
      "membership-required-revoked",
      "membership-required-removed",
      "membership-required-revision-mismatch",
      "membership-required-provider-mismatch",
      "membership-required-host-facts-revision-mismatch",
      "membership-required-duplicate-ref",
      "membership-required-duplicate-host-fact",
      "membership-required-principal-not-directly-verified",
    ]) {
      expect(report.failures).toContainEqual(
        expect.objectContaining({ caseId, invariant: "decision" }),
      );
    }
  });

  it("rejects an adapter that rewrites selected membership provider or host facts", async () => {
    const adapter: MemoryAuthorizationConformanceAdapter = {
      evaluate: ({ resource, scenario }) => {
        const requirement = scenario.stores.find(
          (store) => store.requiredMembership,
        )?.requiredMembership;
        const fact = requirement
          ? scenario.memberships.find(
              (membership) =>
                membership.principalId === requirement.principalId &&
                membership.groupId === requirement.groupId,
            )
          : undefined;
        if (!requirement || !fact) {
          return evaluateMemoryAuthorizationConformanceScenario({ resource, scenario });
        }
        return evaluateMemoryAuthorizationConformanceScenario({
          resource,
          scenario: {
            ...scenario,
            stores: scenario.stores.map((store) =>
              store.requiredMembership
                ? {
                    ...store,
                    requiredMembership: {
                      ...store.requiredMembership,
                      provider: fact.provider,
                    },
                  }
                : store,
            ),
            context: {
              ...scenario.context,
              hostFactsRevision: fact.hostFactsRevision,
              membershipRefs: [
                {
                  principalId: fact.principalId,
                  groupId: fact.groupId,
                  provider: fact.provider,
                  evidenceRevision: fact.evidenceRevision,
                  hostFactsRevision: fact.hostFactsRevision,
                },
              ],
            },
            plan: {
              ...scenario.plan,
              hostFactsRevision: fact.hostFactsRevision,
            },
          },
        });
      },
      prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
    };

    const report = await runMemoryAuthorizationConformanceSuite(adapter);
    for (const caseId of [
      "membership-required-provider-mismatch",
      "membership-required-host-facts-revision-mismatch",
    ]) {
      expect(report.failures).toContainEqual(
        expect.objectContaining({ caseId, invariant: "decision" }),
      );
    }
  });

  it("accepts structured backend-issued handles without prescribing opaque ID encoding", async () => {
    const adapter = createAllowedHandleAdapter((handle) => ({
      ...handle,
      handleId: "backend-issued-handle",
      expiresAt: "2026-07-29T12:04:00.000Z",
    }));
    await expect(runMemoryAuthorizationConformanceSuite(adapter)).resolves.toEqual({
      ok: true,
      failures: [],
    });
  });

  it("rejects raw-string, path, and bearer-like handle substitutions", async () => {
    for (const substitute of [
      "backend-issued-handle",
      "/virtual/user/principal-owner.md",
      "Bearer backend-issued-handle",
    ]) {
      const report = await runMemoryAuthorizationConformanceSuite(
        createAllowedHandleAdapter(() => substitute),
      );
      expect(report.failures).toContainEqual(
        expect.objectContaining({ invariant: "authorized-handle" }),
      );
    }
  });

  it("rejects allowed handles with missing or stale authorization bindings", async () => {
    const transforms: Array<(handle: AuthorizedResourceHandle) => unknown> = [
      (handle) => {
        const malformed = { ...handle } as Record<string, unknown>;
        Reflect.deleteProperty(malformed, "planId");
        return malformed;
      },
      (handle) => ({ ...handle, version: 2 }),
      (handle) => ({ ...handle, planId: "plan-2" }),
      (handle) => ({ ...handle, contextFingerprint: "context-revision-2" }),
      (handle) => ({ ...handle, resourceRevision: "resource-revision-2" }),
      (handle) => ({ ...handle, policyRevision: "policy-revision-2" }),
      (handle) => {
        const malformed = { ...handle } as Record<string, unknown>;
        Reflect.deleteProperty(malformed, "expiresAt");
        return malformed;
      },
      (handle) => ({ ...handle, expiresAt: "2026-07-29T11:59:59.000Z" }),
      (handle) => ({ ...handle, expiresAt: "not-a-date" }),
      (handle) => ({ ...handle, expiresAt: "2026-07-29T12:10:00.000Z" }),
    ];
    for (const transformHandle of transforms) {
      const report = await runMemoryAuthorizationConformanceSuite(
        createAllowedHandleAdapter(transformHandle),
      );
      expect(report.failures).toContainEqual(
        expect.objectContaining({ invariant: "authorized-handle" }),
      );
    }
  });

  it("rejects an empty opaque handle ID", async () => {
    const adapter = createAllowedHandleAdapter((handle) => ({ ...handle, handleId: "" }));
    const report = await runMemoryAuthorizationConformanceSuite(adapter);
    expect(report.failures).toContainEqual(
      expect.objectContaining({ invariant: "authorized-handle" }),
    );
  });

  it("rejects non-enumerable or accessor-backed required handle bindings", async () => {
    const requiredKeys = [
      "version",
      "handleId",
      "planId",
      "contextFingerprint",
      "resourceRevision",
      "policyRevision",
      "expiresAt",
    ] as const;
    for (const key of requiredKeys) {
      for (const descriptorKind of ["hidden", "accessor"] as const) {
        const report = await runMemoryAuthorizationConformanceSuite(
          createAllowedHandleAdapter((handle) => {
            const malformed = { ...handle } as Record<string, unknown>;
            const value = malformed[key];
            Object.defineProperty(malformed, key, {
              ...(descriptorKind === "hidden"
                ? { enumerable: false, value }
                : { enumerable: true, get: () => value }),
            });
            return malformed;
          }),
        );
        expect(report.failures).toContainEqual(
          expect.objectContaining({ invariant: "authorized-handle" }),
        );
      }
    }
  });

  it("rejects allowed handles with own, inherited, non-enumerable, or symbolic metadata", async () => {
    const privateMetadata = Symbol("private-metadata");
    const decorateHandle: Array<(handle: AuthorizedResourceHandle) => unknown> = [
      (handle) => ({ ...handle, path: "/virtual/user/principal-owner.md" }),
      (handle) =>
        Object.assign(
          Object.create({ privateMetadata: "hidden" }),
          handle,
        ) as AuthorizedResourceHandle,
      (handle) => {
        const decorated = { ...handle };
        Object.defineProperty(decorated, "privateMetadata", {
          enumerable: false,
          value: "hidden",
        });
        return decorated;
      },
      (handle) => ({ ...handle, [privateMetadata]: "hidden" }),
    ];

    for (const decorate of decorateHandle) {
      const report = await runMemoryAuthorizationConformanceSuite(
        createAllowedHandleAdapter(decorate),
      );
      expect(report.failures).toContainEqual(
        expect.objectContaining({ invariant: "authorized-handle" }),
      );
    }
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
          handle: "unauthorized-handle",
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

  it("rejects non-enumerable, symbolic, or inherited denial metadata", async () => {
    const privateMetadata = Symbol("private-metadata");
    const decorateDenied: Array<
      (
        decision: Extract<MemoryAuthorizationConformanceDecision, { allowed: false }>,
      ) => MemoryAuthorizationConformanceDecision
    > = [
      (decision) => {
        const decorated = { ...decision };
        Object.defineProperty(decorated, "privateMetadata", {
          enumerable: false,
          value: "hidden",
        });
        return decorated;
      },
      (decision) => ({ ...decision, [privateMetadata]: "hidden" }),
      (decision) =>
        Object.assign(
          Object.create({ privateMetadata: "hidden" }),
          decision,
        ) as MemoryAuthorizationConformanceDecision,
    ];

    for (const decorate of decorateDenied) {
      const adapter: MemoryAuthorizationConformanceAdapter = {
        evaluate: (params) => {
          const decision = evaluateMemoryAuthorizationConformanceScenario(params);
          return decision.allowed ? decision : decorate(decision);
        },
        prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
      };

      const report = await runMemoryAuthorizationConformanceSuite(adapter);
      expect(report.failures).toContainEqual(
        expect.objectContaining({ invariant: "denial-non-disclosure" }),
      );
    }
  });

  it("accepts a null-prototype denied decision with no metadata", async () => {
    const adapter: MemoryAuthorizationConformanceAdapter = {
      evaluate: (params) => {
        const decision = evaluateMemoryAuthorizationConformanceScenario(params);
        return decision.allowed
          ? decision
          : (Object.assign(
              Object.create(null),
              decision,
            ) as MemoryAuthorizationConformanceDecision);
      },
      prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
    };

    await expect(runMemoryAuthorizationConformanceSuite(adapter)).resolves.toEqual({
      ok: true,
      failures: [],
    });
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
