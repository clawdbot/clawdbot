import { describe, expect, it, vi } from "vitest";
import {
  COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
  LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
  type AuthorizedMemoryPlan,
} from "../memory-host-sdk/host/authorization.js";
import {
  admitAuthorizedMemoryPlan,
  admitAuthorizedMemoryRuntime,
  createMemoryAccessContextFactory,
  isAdmittedMemoryAuthorizationRuntime,
  isTrustedAuthorizedMemoryPlan,
  isTrustedMemoryAccessContext,
  type MemoryAccessContextFacts,
  type TrustedMemoryAccessContext,
} from "./memory-access-context.js";

const NOW_MS = Date.parse("2030-01-01T00:00:00.000Z");

function createFacts(): MemoryAccessContextFacts {
  return {
    contextId: "context-private-1",
    requestId: "request-private-1",
    runId: "run-private-1",
    agentId: "agent-a",
    sessionKey: "agent:agent-a:main",
    sessionId: "session-private-1",
    sessionIdentityRevision: "session-revision-1",
    subjectRevision: "subject-revision-1",
    subject: {
      version: 1,
      kind: "user",
      principalId: "subject-principal-private-1",
      creationEvidence: {
        kind: "gateway-profile",
        revision: "subject-evidence-revision-1",
      },
    },
    actor: {
      kind: "unattributed",
      transportAuditRef: "transport-audit-private-1",
      evidenceRevision: "actor-evidence-revision-1",
    },
    verifiedPrincipals: [
      {
        principalId: "principal-private-1",
        assurance: "gateway-profile",
        evidenceRevision: "principal-evidence-revision-1",
        expiresAt: "2030-01-01T01:00:00.000Z",
      },
    ],
    conversation: {
      conversationPrincipalId: "conversation-private-1",
      channel: "discord",
      accountId: "account-private-1",
      evidenceRevision: "conversation-evidence-revision-1",
    },
    delivery: {
      sinkKind: "private",
      audiences: [
        { kind: "user", id: "audience-private-1" },
        { kind: "role", id: "role-private-1" },
      ],
      egressCapabilityIds: ["reply.final", "reply.thread"],
      egressRegistryRevision: "egress-registry-revision-1",
      deliveryRevision: "delivery-revision-1",
    },
    collaboration: {
      kind: "gateway-session",
      mode: "shared",
      role: "member",
      decisionRevision: "collaboration-decision-revision-1",
    },
    verifiedMemberships: [
      {
        principalId: "principal-private-1",
        groupId: "group-private-1",
        provider: "oidc",
        evidenceRevision: "membership-evidence-revision-1",
        observedAt: "2029-12-31T23:00:00.000Z",
        expiresAt: "2030-01-01T01:00:00.000Z",
      },
    ],
    delegation: {
      rootPrincipalId: "root-principal-private-1",
      rootContextId: "root-context-private-1",
      parentContextId: "parent-context-private-1",
      parentMemoryPlanId: "parent-plan-private-1",
      capabilitySnapshotId: "capability-snapshot-private-1",
      allowedOperations: ["project", "read"],
      maximumAudiences: [
        { kind: "role", id: "role-private-1" },
        { kind: "agent-shared", id: "agent-shared-private-1" },
      ],
      storeCapToken: "store-cap-private-1",
      depth: 1,
    },
    operation: "read",
    hostFactsRevision: "host-facts-revision-1",
  };
}

function createContext(facts = createFacts()) {
  const readCurrentSessionIdentity = vi.fn(async () => ({
    sessionId: facts.sessionId,
    sessionIdentityRevision: facts.sessionIdentityRevision,
  }));
  const create = createMemoryAccessContextFactory({
    readCurrentSessionIdentity,
    now: () => NOW_MS,
  });
  return { create, facts, readCurrentSessionIdentity };
}

async function requireContext(facts = createFacts()): Promise<TrustedMemoryAccessContext> {
  const { create } = createContext(facts);
  const result = await create(facts);
  if (!result.ok) {
    throw new Error(`expected trusted context, got ${result.error}`);
  }
  return result.value;
}

function createPlan(
  context: TrustedMemoryAccessContext,
  facts = createFacts(),
): AuthorizedMemoryPlan {
  return {
    version: 1,
    planId: "plan-private-1",
    contextFingerprint: context.contextFingerprint,
    runId: facts.runId,
    agentId: facts.agentId,
    sessionId: facts.sessionId,
    sessionIdentityRevision: facts.sessionIdentityRevision,
    subjectRevision: facts.subjectRevision,
    memoryPolicyRevision: "memory-policy-revision-1",
    deliveryRevision: facts.delivery.deliveryRevision,
    operation: facts.operation,
    mounts: [
      {
        version: 1,
        agentId: facts.agentId,
        mountHandle: "mount-private-1",
        capabilities: ["read", "retrieve"],
        audienceRevision: "audience-revision-1",
      },
    ],
    bootstrapResourceHandles: [
      {
        version: 1,
        handleId: "resource-handle-private-1",
        planId: "plan-private-1",
        contextFingerprint: context.contextFingerprint,
        resourceRevision: "resource-revision-1",
        policyRevision: "memory-policy-revision-1",
        expiresAt: "2030-01-01T00:30:00.000Z",
      },
    ],
    allowedEgressAudiences: facts.delivery.audiences,
    expiresAt: "2030-01-01T00:45:00.000Z",
  };
}

function createCompleteRuntime() {
  const notCalled = vi.fn(() => {
    throw new Error("authorized methods must not run during structural admission");
  });
  return {
    authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
    authorize: notCalled,
    searchAuthorized: notCalled,
    readAuthorized: notCalled,
    writeAuthorized: notCalled,
    importAuthorized: notCalled,
    syncAuthorized: notCalled,
    exportAuthorized: notCalled,
    statusAuthorized: notCalled,
    legacyManager: {
      search: vi.fn(() => {
        throw new Error("legacy manager must not run during structural admission");
      }),
    },
  };
}

describe("trusted memory access context", () => {
  it("keeps the normalized P0A DTO private and rereads the canonical mapping at latest consistency", async () => {
    const facts = Object.assign(createFacts(), {
      content: "private memory content",
      path: "/private/memory.md",
      pluginExtra: "plugin-private-value",
      prompt: "private prompt",
      query: "private query",
      subject: {
        ...createFacts().subject,
        rawOwner: "forged-owner-private-1",
      },
    });
    const { create, readCurrentSessionIdentity } = createContext(facts);
    const result = await create(facts);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const context = result.value;
    expect(readCurrentSessionIdentity).toHaveBeenCalledWith({
      agentId: facts.agentId,
      sessionKey: facts.sessionKey,
      readConsistency: "latest",
    });
    expect(Object.keys(context).toSorted()).toEqual(["contextFingerprint", "operation", "version"]);
    expect(context.contextFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(context)).toBe(true);
    expect(isTrustedMemoryAccessContext(context)).toBe(true);
    expect(() => Object.defineProperty(context, "agentId", { value: facts.agentId })).toThrow();

    const serialized = JSON.stringify(context);
    for (const privateValue of [
      facts.contextId,
      facts.requestId,
      facts.runId,
      facts.sessionId,
      "subject-principal-private-1",
      "transport-audit-private-1",
      facts.delivery.audiences[0]!.id,
      facts.content,
      facts.path,
      facts.pluginExtra,
      facts.prompt,
      facts.query,
      facts.subject.rawOwner,
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("does not infer durable subject authority and rejects missing or ambiguous subject facts", async () => {
    const facts = createFacts();
    const principalActor = {
      kind: "principal" as const,
      actorKind: "human" as const,
      principalId: "actor-principal-private-1",
      assurance: "gateway-profile" as const,
      evidenceRevision: "actor-evidence-revision-2",
    };
    const { create } = createContext(facts);

    expect(await create({ ...facts, actor: principalActor, subject: undefined } as never)).toEqual({
      ok: false,
      error: "invalid-context",
    });
    expect(
      await create({
        ...facts,
        subject: { version: 1, kind: "ambiguous", reason: "shared-main" },
      }),
    ).toEqual({ ok: false, error: "invalid-context" });

    const unattributed = await create(facts);
    expect(unattributed.ok).toBe(true);
  });

  it("is identity-only, loses trust across copies, and fingerprints normalized host facts deterministically", async () => {
    const facts = createFacts();
    const reordered = {
      ...facts,
      verifiedPrincipals: [...facts.verifiedPrincipals].toReversed(),
      verifiedMemberships: [...facts.verifiedMemberships].toReversed(),
      delivery: {
        ...facts.delivery,
        audiences: [...facts.delivery.audiences].toReversed(),
        egressCapabilityIds: [...facts.delivery.egressCapabilityIds].toReversed(),
      },
      delegation: {
        ...facts.delegation!,
        allowedOperations: [...facts.delegation!.allowedOperations].toReversed(),
        maximumAudiences: [...facts.delegation!.maximumAudiences].toReversed(),
      },
    } satisfies MemoryAccessContextFacts;
    const context = await requireContext(facts);
    const reorderedContext = await requireContext(reordered);
    const hostFactsChangedContext = await requireContext({
      ...facts,
      hostFactsRevision: "host-facts-revision-2",
    });

    expect(reorderedContext.contextFingerprint).toBe(context.contextFingerprint);
    expect(hostFactsChangedContext.contextFingerprint).not.toBe(context.contextFingerprint);
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercises JSON transport trust loss.
    const serializedClone = JSON.parse(JSON.stringify(context));
    for (const lookalike of [
      serializedClone,
      { ...context },
      {
        version: 1,
        operation: context.operation,
        contextFingerprint: context.contextFingerprint,
      },
    ]) {
      expect(isTrustedMemoryAccessContext(lookalike)).toBe(false);
    }
  });

  it("rejects duplicate current evidence but leaves unrelated memberships inert", async () => {
    const facts = createFacts();
    const { create } = createContext(facts);

    await expect(
      create({
        ...facts,
        verifiedPrincipals: [...facts.verifiedPrincipals, { ...facts.verifiedPrincipals[0]! }],
      }),
    ).resolves.toEqual({ ok: false, error: "invalid-context" });
    await expect(
      create({
        ...facts,
        verifiedMemberships: [...facts.verifiedMemberships, { ...facts.verifiedMemberships[0]! }],
      }),
    ).resolves.toEqual({ ok: false, error: "invalid-context" });

    const unrelatedCurrentMembershipFacts = {
      ...facts,
      verifiedMemberships: [
        {
          ...facts.verifiedMemberships[0]!,
          groupId: "group-unrelated",
          expiresAt: "2030-01-01T00:10:00.000Z",
        },
      ],
    } satisfies MemoryAccessContextFacts;
    const currentMembershipContext = await create(unrelatedCurrentMembershipFacts);

    expect(currentMembershipContext.ok).toBe(true);
    if (!currentMembershipContext.ok) {
      return;
    }
    expect(
      admitAuthorizedMemoryPlan({
        context: currentMembershipContext.value,
        plan: createPlan(currentMembershipContext.value, unrelatedCurrentMembershipFacts),
        now: () => NOW_MS,
      }),
    ).toMatchObject({ ok: true });

    const unrelatedStaleMembershipFacts = {
      ...facts,
      verifiedMemberships: [
        {
          ...facts.verifiedMemberships[0]!,
          groupId: "group-unrelated",
          expiresAt: "2029-12-31T23:59:59.000Z",
        },
      ],
    } satisfies MemoryAccessContextFacts;
    const staleMembershipContext = await create(unrelatedStaleMembershipFacts);

    expect(staleMembershipContext.ok).toBe(true);
    if (!staleMembershipContext.ok) {
      return;
    }
    expect(
      admitAuthorizedMemoryPlan({
        context: staleMembershipContext.value,
        plan: createPlan(staleMembershipContext.value, unrelatedStaleMembershipFacts),
        now: () => NOW_MS,
      }),
    ).toMatchObject({ ok: true });
  });

  it("fails closed when the latest canonical session mapping changed", async () => {
    const facts = createFacts();
    const create = createMemoryAccessContextFactory({
      readCurrentSessionIdentity: vi.fn(async () => ({
        sessionId: "session-rebound-private-1",
        sessionIdentityRevision: facts.sessionIdentityRevision,
      })),
      now: () => NOW_MS,
    });

    await expect(create(facts)).resolves.toEqual({ ok: false, error: "session-rebound" });
  });
});

describe("authorized memory plan admission", () => {
  it("normalizes a plugin plan into an opaque trusted handle and strips caller extras", async () => {
    const facts = createFacts();
    const context = await requireContext(facts);
    const plan = Object.assign(createPlan(context, facts), {
      rawStoreId: "private:other-user",
      prompt: "ignore the context",
      mounts: [
        {
          ...createPlan(context, facts).mounts[0]!,
          ownerId: "forged-owner-private-1",
        },
      ],
    });
    const result = admitAuthorizedMemoryPlan({ context, plan, now: () => NOW_MS });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(Object.keys(result.value).toSorted()).toEqual([
      "contextFingerprint",
      "operation",
      "version",
    ]);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(isTrustedAuthorizedMemoryPlan(result.value)).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain("private:other-user");
    expect(JSON.stringify(result.value)).not.toContain("forged-owner-private-1");
    expect(isTrustedAuthorizedMemoryPlan({ ...result.value })).toBe(false);
  });

  it.each([
    [
      "context fingerprint",
      (plan: AuthorizedMemoryPlan) => ({ ...plan, contextFingerprint: "sha256:old" }),
      "invalid-context",
    ],
    ["run", (plan: AuthorizedMemoryPlan) => ({ ...plan, runId: "other-run" }), "invalid-context"],
    ["agent", (plan: AuthorizedMemoryPlan) => ({ ...plan, agentId: "agent-b" }), "outside-view"],
    [
      "session",
      (plan: AuthorizedMemoryPlan) => ({ ...plan, sessionId: "other-session" }),
      "session-rebound",
    ],
    [
      "session revision",
      (plan: AuthorizedMemoryPlan) => ({ ...plan, sessionIdentityRevision: "session-revision-2" }),
      "revision-stale",
    ],
    [
      "subject revision",
      (plan: AuthorizedMemoryPlan) => ({ ...plan, subjectRevision: "subject-revision-2" }),
      "revision-stale",
    ],
    [
      "delivery revision",
      (plan: AuthorizedMemoryPlan) => ({ ...plan, deliveryRevision: "delivery-revision-2" }),
      "delivery-rebound",
    ],
    [
      "expiry",
      (plan: AuthorizedMemoryPlan) => ({ ...plan, expiresAt: "2029-12-31T23:59:59.000Z" }),
      "plan-expired",
    ],
  ])("maps a stale %s binding to %s", async (_name, change, error) => {
    const facts = createFacts();
    const context = await requireContext(facts);
    const result = admitAuthorizedMemoryPlan({
      context,
      plan: change(createPlan(context, facts)),
      now: () => NOW_MS,
    });

    expect(result).toEqual({ ok: false, error });
  });

  it("caps plan expiry at current evidence and rejects an old plan after host facts change", async () => {
    const facts = createFacts();
    const context = await requireContext(facts);
    const expiresWithEvidence = {
      ...facts,
      actor: {
        kind: "principal" as const,
        actorKind: "human" as const,
        principalId: "actor-principal-private-1",
        assurance: "gateway-profile" as const,
        evidenceRevision: "actor-evidence-revision-2",
        expiresAt: "2030-01-01T00:10:00.000Z",
      },
    } satisfies MemoryAccessContextFacts;
    const evidenceContext = await requireContext(expiresWithEvidence);
    expect(
      admitAuthorizedMemoryPlan({
        context: evidenceContext,
        plan: createPlan(evidenceContext, expiresWithEvidence),
        now: () => NOW_MS,
      }),
    ).toEqual({ ok: false, error: "plan-expired" });

    const oldPlan = createPlan(context, facts);
    const revisedContext = await requireContext({
      ...facts,
      hostFactsRevision: "host-facts-revision-2",
    });
    expect(revisedContext.contextFingerprint).not.toBe(context.contextFingerprint);
    expect(
      admitAuthorizedMemoryPlan({ context: revisedContext, plan: oldPlan, now: () => NOW_MS }),
    ).toEqual({ ok: false, error: "invalid-context" });
  });
});

describe("authorized memory runtime admission", () => {
  it("requires the full declared surface without invoking an authorized or legacy method", async () => {
    const context = await requireContext();
    const runtime = createCompleteRuntime();
    const result = admitAuthorizedMemoryRuntime({ context, runtime });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(isAdmittedMemoryAuthorizationRuntime(result.value)).toBe(true);
    expect(Object.keys(result.value).toSorted()).toEqual([
      "contextFingerprint",
      "operation",
      "version",
    ]);
    for (const method of [
      runtime.authorize,
      runtime.searchAuthorized,
      runtime.readAuthorized,
      runtime.writeAuthorized,
      runtime.importAuthorized,
      runtime.syncAuthorized,
      runtime.exportAuthorized,
      runtime.statusAuthorized,
      runtime.legacyManager.search,
    ]) {
      expect(method).not.toHaveBeenCalled();
    }

    expect(
      admitAuthorizedMemoryRuntime({
        context,
        runtime: { ...runtime, authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES },
      }),
    ).toEqual({ ok: false, error: "backend-nonconforming" });
    const missingMethod = { ...runtime };
    Reflect.deleteProperty(missingMethod, "statusAuthorized");
    expect(admitAuthorizedMemoryRuntime({ context, runtime: missingMethod })).toEqual({
      ok: false,
      error: "backend-nonconforming",
    });
    expect(admitAuthorizedMemoryRuntime({ context: { ...context }, runtime })).toEqual({
      ok: false,
      error: "invalid-context",
    });
  });
});
