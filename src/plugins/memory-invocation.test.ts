import { describe, expect, it, vi } from "vitest";
import {
  COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
  type AuthorizedMemoryPlan,
  type AuthorizedMemoryResultEnvelope,
  type AuthorizedMemorySearchResult,
  type MemoryAccessContext,
} from "../memory-host-sdk/host/authorization.js";

const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  materialize: vi.fn(),
}));

vi.mock("../state/memory-access-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/memory-access-context.js")>()),
  materializeTrustedMemoryAccessContext: mocks.materialize,
}));

vi.mock("./memory-authorization-runtime.js", () => ({
  admitMemoryAuthorizationReadRuntime: mocks.admit,
}));

const {
  MEMORY_INVOCATION_UNAVAILABLE,
  createAuthorizedMemoryReadInvocation,
  readAuthorizedMemoryForInvocation,
  searchAuthorizedMemoryForInvocation,
} = await import("./memory-invocation.js");

function createContext(): MemoryAccessContext & Readonly<{ operation: "read" }> {
  return {
    version: 1,
    contextId: "context-1",
    contextFingerprint: "fingerprint-1",
    requestId: "request-1",
    runId: "run-1",
    agentId: "main",
    sessionKey: "agent:main:direct:dm",
    sessionId: "session-1",
    sessionIdentityRevision: "session-revision-1",
    subjectRevision: "subject-revision-1",
    subject: {
      version: 1,
      kind: "user",
      principalId: "alice",
      creationEvidence: { kind: "gateway-profile", revision: "binding-1" },
    },
    actor: {
      kind: "principal",
      actorKind: "human",
      principalId: "alice",
      assurance: "gateway-profile",
      evidenceRevision: "binding-1",
    },
    verifiedPrincipals: [
      { principalId: "alice", assurance: "gateway-profile", evidenceRevision: "binding-1" },
    ],
    delivery: {
      sinkKind: "private",
      audiences: [{ kind: "user", id: "alice" }],
      egressCapabilityIds: ["reply.final"],
      egressRegistryRevision: "egress-1",
      deliveryRevision: "delivery-1",
    },
    collaboration: { kind: "not-applicable" },
    verifiedMemberships: [],
    operation: "read",
    hostFactsRevision: "host-1",
  };
}

function createPlan(): AuthorizedMemoryPlan & Readonly<{ operation: "read" }> {
  return {
    version: 1,
    planId: "plan-1",
    contextFingerprint: "fingerprint-1",
    runId: "run-1",
    agentId: "main",
    sessionId: "session-1",
    sessionIdentityRevision: "session-revision-1",
    subjectRevision: "subject-revision-1",
    memoryPolicyRevision: "policy-1",
    deliveryRevision: "delivery-1",
    operation: "read",
    mounts: [],
    bootstrapResourceHandles: [],
    allowedEgressAudiences: [{ kind: "user", id: "alice" }],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

let receiptSequence = 0;

function createEnvelope<T>(
  value: T,
  overrides?: Readonly<{
    exposureReceipt?: Partial<AuthorizedMemoryResultEnvelope<T>["exposureReceipt"]>;
    egressReceipt?: Partial<AuthorizedMemoryResultEnvelope<T>["egressReceipt"]>;
  }>,
): AuthorizedMemoryResultEnvelope<T> {
  const receiptSequenceValue = ++receiptSequence;
  return {
    version: 1,
    value,
    exposureReceipt: {
      version: 1,
      receiptId: `exposure-${receiptSequenceValue}`,
      contextFingerprint: "fingerprint-1",
      planId: "plan-1",
      runId: "run-1",
      runExposureRevision: `run-exposure-${receiptSequenceValue}`,
      sourcePolicySetId: "policy-set-1",
      exposedRevisionHandles: ["revision-1"],
      recordedAt: new Date().toISOString(),
      ...overrides?.exposureReceipt,
    },
    egressReceipt: {
      version: 1,
      receiptId: `egress-${receiptSequenceValue}`,
      contextFingerprint: "fingerprint-1",
      planId: "plan-1",
      runId: "run-1",
      runExposureRevision: `run-exposure-${receiptSequenceValue}`,
      sourcePolicySetId: "policy-set-1",
      allowedAudiences: [{ kind: "user", id: "alice" }],
      deliveryRevision: "delivery-1",
      egressRegistryRevision: "egress-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...overrides?.egressReceipt,
    },
  };
}

describe("authorized memory read invocation", () => {
  it("returns only an unavailable result when backend admission fails", async () => {
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({ ok: false, reasonCode: "backend-nonconforming" });

    await expect(
      createAuthorizedMemoryReadInvocation({
        context: {} as never,
        capability: { authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES },
      }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);
  });

  it("does not leak a search result unless its current exposure and egress receipts validate", async () => {
    const handle = {
      version: 1 as const,
      handleId: "handle-1",
      planId: "plan-1",
      contextFingerprint: "fingerprint-1",
      resourceRevision: "revision-1",
      policyRevision: "policy-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const result: AuthorizedMemorySearchResult = {
      path: "private/note.md",
      startLine: 1,
      endLine: 1,
      score: 1,
      snippet: "allowed text",
      source: "memory",
      resourceHandle: handle,
    };
    const runtime = {
      authorize: vi.fn().mockResolvedValue(createPlan()),
      searchAuthorized: vi.fn().mockImplementation(async () => createEnvelope([result])),
      readAuthorized: vi
        .fn()
        .mockImplementation(async () =>
          createEnvelope({ text: "allowed text", path: "private/note.md" }),
        ),
    };
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });

    const invocation = await createAuthorizedMemoryReadInvocation({
      context: {} as never,
      capability: {
        authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
      },
    });
    expect(invocation).not.toBe(MEMORY_INVOCATION_UNAVAILABLE);
    if (invocation === MEMORY_INVOCATION_UNAVAILABLE) {
      return;
    }
    await expect(
      searchAuthorizedMemoryForInvocation({ invocation, query: "allowed" }),
    ).resolves.toEqual({
      results: [
        {
          handleId: "handle-1",
          path: "private/note.md",
          startLine: 1,
          endLine: 1,
          score: 1,
          snippet: "allowed text",
          source: "memory",
        },
      ],
    });
    await expect(
      readAuthorizedMemoryForInvocation({ invocation, handleId: "handle-1" }),
    ).resolves.toEqual({ text: "allowed text", path: "private/note.md" });

    runtime.searchAuthorized.mockResolvedValueOnce({
      ...createEnvelope([result]),
      egressReceipt: {
        ...createEnvelope([result]).egressReceipt,
        allowedAudiences: [{ kind: "user", id: "mallory" }],
      },
    });
    await expect(
      searchAuthorizedMemoryForInvocation({ invocation, query: "denied" }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);
  });

  it.each([
    {
      name: "has an invalid timestamp",
      recordedAt: "not-a-date",
    },
    {
      name: "was issued before this invocation authorized its plan",
      recordedAt: new Date(0).toISOString(),
    },
  ])("does not leak a search result when its exposure receipt $name", async ({ recordedAt }) => {
    const runtime = {
      authorize: vi.fn().mockResolvedValue(createPlan()),
      searchAuthorized: vi
        .fn()
        .mockResolvedValue(createEnvelope([], { exposureReceipt: { recordedAt } })),
      readAuthorized: vi.fn(),
    };
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });

    const invocation = await createAuthorizedMemoryReadInvocation({
      context: {} as never,
      capability: { authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES },
    });
    expect(invocation).not.toBe(MEMORY_INVOCATION_UNAVAILABLE);
    if (invocation === MEMORY_INVOCATION_UNAVAILABLE) {
      return;
    }
    await expect(
      searchAuthorizedMemoryForInvocation({ invocation, query: "private" }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);
  });

  it("rejects a replayed exposure receipt instead of exposing the repeated result", async () => {
    const handle = {
      version: 1 as const,
      handleId: "handle-1",
      planId: "plan-1",
      contextFingerprint: "fingerprint-1",
      resourceRevision: "revision-1",
      policyRevision: "policy-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const result: AuthorizedMemorySearchResult = {
      path: "private/note.md",
      startLine: 1,
      endLine: 1,
      score: 1,
      snippet: "allowed text",
      source: "memory",
      resourceHandle: handle,
    };
    let replayedEnvelope:
      | AuthorizedMemoryResultEnvelope<AuthorizedMemorySearchResult[]>
      | undefined;
    const runtime = {
      authorize: vi.fn().mockResolvedValue(createPlan()),
      searchAuthorized: vi
        .fn()
        .mockImplementation(async () => (replayedEnvelope ??= createEnvelope([result]))),
      readAuthorized: vi.fn(),
    };
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });

    const invocation = await createAuthorizedMemoryReadInvocation({
      context: {} as never,
      capability: { authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES },
    });
    expect(invocation).not.toBe(MEMORY_INVOCATION_UNAVAILABLE);
    if (invocation === MEMORY_INVOCATION_UNAVAILABLE) {
      return;
    }
    await expect(
      searchAuthorizedMemoryForInvocation({ invocation, query: "allowed" }),
    ).resolves.toEqual({
      results: [
        {
          handleId: "handle-1",
          path: "private/note.md",
          startLine: 1,
          endLine: 1,
          score: 1,
          snippet: "allowed text",
          source: "memory",
        },
      ],
    });
    await expect(
      searchAuthorizedMemoryForInvocation({ invocation, query: "replay" }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);
  });

  it("keeps multiple authorized results in one fresh receipt envelope", async () => {
    const secondHandle = {
      version: 1 as const,
      handleId: "handle-2",
      planId: "plan-1",
      contextFingerprint: "fingerprint-1",
      resourceRevision: "revision-2",
      policyRevision: "policy-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const results: AuthorizedMemorySearchResult[] = [
      {
        path: "private/one.md",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "one",
        source: "memory",
        resourceHandle: {
          version: 1,
          handleId: "handle-1",
          planId: "plan-1",
          contextFingerprint: "fingerprint-1",
          resourceRevision: "revision-1",
          policyRevision: "policy-1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
      {
        path: "private/two.md",
        startLine: 1,
        endLine: 1,
        score: 0.9,
        snippet: "two",
        source: "memory",
        resourceHandle: secondHandle,
      },
    ];
    const runtime = {
      authorize: vi.fn().mockResolvedValue(createPlan()),
      searchAuthorized: vi.fn().mockImplementation(async () =>
        createEnvelope(results, {
          exposureReceipt: { exposedRevisionHandles: ["revision-1", "revision-2"] },
        }),
      ),
      readAuthorized: vi.fn(),
    };
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });

    const invocation = await createAuthorizedMemoryReadInvocation({
      context: {} as never,
      capability: { authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES },
    });
    expect(invocation).not.toBe(MEMORY_INVOCATION_UNAVAILABLE);
    if (invocation === MEMORY_INVOCATION_UNAVAILABLE) {
      return;
    }
    await expect(
      searchAuthorizedMemoryForInvocation({ invocation, query: "allowed" }),
    ).resolves.toMatchObject({
      results: [
        { handleId: "handle-1", snippet: "one" },
        { handleId: "handle-2", snippet: "two" },
      ],
    });
  });
});
