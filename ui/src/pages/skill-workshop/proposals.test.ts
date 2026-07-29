// @vitest-environment node
// Control UI tests cover skill workshop controller behavior.
import { describe, expect, it, vi } from "vitest";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { SkillWorkshopProposal } from "../../lib/skill-workshop/index.ts";
import {
  createSkillWorkshopState,
  loadSkillWorkshopProposals,
  requestSkillWorkshopRevision,
  runSkillWorkshopEvaluation,
  runSkillWorkshopLifecycleAction,
  selectSkillWorkshopProposal,
  type SkillWorkshopContext,
  type SkillWorkshopState,
} from "./proposals.ts";

type TestRequest = (method: string, payload?: unknown) => Promise<unknown>;

const ISO_NOW = "2026-06-16T12:00:00.000Z";
const DRAFT_HASH = "a".repeat(64);
const REVISION_HASH = "b".repeat(64);

function createFixture(
  overrides: Partial<SkillWorkshopState> = {},
  snapshotOverrides: Partial<ApplicationGatewaySnapshot> = {},
): {
  state: SkillWorkshopState;
  context: SkillWorkshopContext;
  request: ReturnType<typeof vi.fn<TestRequest>>;
  snapshot: ApplicationGatewaySnapshot;
} {
  const request = vi.fn<TestRequest>();
  const snapshot: ApplicationGatewaySnapshot = {
    client: { request } as unknown as ApplicationGatewaySnapshot["client"],
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: "research",
    sessionKey: "global",
    lastError: null,
    lastErrorCode: null,
    ...snapshotOverrides,
  };
  const context: SkillWorkshopContext = {
    agentSelection: {
      get state() {
        return { selectedId: snapshot.assistantAgentId, scopeId: snapshot.assistantAgentId };
      },
    },
    gateway: {
      get snapshot() {
        return snapshot;
      },
      connection: { gatewayUrl: "", token: "", bootstrapToken: "", password: "" },
      eventLog: [],
      connect: vi.fn(),
      setSessionKey: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      subscribeEventLog: vi.fn(() => () => {}),
      subscribeEvents: vi.fn(() => () => {}),
    },
  };
  return { state: { ...createSkillWorkshopState(), ...overrides }, context, request, snapshot };
}

function manifest(status: SkillWorkshopProposal["status"] = "pending") {
  return {
    schema: "openclaw.skill-workshop.proposals-manifest.v1",
    updatedAt: ISO_NOW,
    proposals: [
      {
        id: "proposal-1",
        kind: "create",
        status,
        title: "Inbox Cleaner",
        description: "Clean inbox triage",
        skillName: "Inbox Cleaner",
        skillKey: "inbox-cleaner",
        createdAt: ISO_NOW,
        updatedAt: ISO_NOW,
        scanState: "clean",
      },
    ],
  };
}

function inspectResult(status: SkillWorkshopProposal["status"] = "pending") {
  return {
    record: {
      id: "proposal-1",
      kind: "create",
      status,
      title: "Inbox Cleaner",
      description: "Clean inbox triage",
      createdAt: ISO_NOW,
      updatedAt: ISO_NOW,
      proposedVersion: "v1",
      draftHash: DRAFT_HASH,
      target: {
        skillName: "Inbox Cleaner",
        skillKey: "inbox-cleaner",
      },
    },
    revisionHash: REVISION_HASH,
    content: "Review unread mail and archive low-priority threads.",
    supportFiles: [],
  };
}

function proposal(overrides: Partial<SkillWorkshopProposal> = {}): SkillWorkshopProposal {
  return {
    key: "proposal-1",
    slug: "inbox-cleaner",
    name: "Inbox Cleaner",
    oneLine: "Clean inbox triage",
    body: "Review unread mail.",
    status: "pending",
    version: 1,
    revisionHash: REVISION_HASH,
    createdAt: Date.parse(ISO_NOW),
    updatedAt: Date.parse(ISO_NOW),
    recencyGroup: "today",
    ageLabel: "now",
    supportFiles: [],
    isNew: false,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected deferred promise callback to be initialized");
  }
  return { promise, resolve };
}

function clearNoticeTimer(state: SkillWorkshopState): void {
  if (state.skillWorkshopActionNoticeTimer) {
    globalThis.clearTimeout(state.skillWorkshopActionNoticeTimer);
    state.skillWorkshopActionNoticeTimer = null;
  }
}

describe("Skill Workshop proposal RPCs", () => {
  it("lists proposals with the selected agent id and carries it into the initial inspect", async () => {
    const { state, context, request } = createFixture();
    request.mockImplementation(async (method: string) => {
      if (method === "skills.proposals.list") {
        return manifest();
      }
      if (method === "skills.proposals.inspect") {
        return inspectResult();
      }
      return {};
    });

    await loadSkillWorkshopProposals(state, context);

    expect(request).toHaveBeenNthCalledWith(1, "skills.proposals.list", {
      agentId: "research",
    });
    expect(request).toHaveBeenNthCalledWith(2, "skills.proposals.inspect", {
      agentId: "research",
      proposalId: "proposal-1",
    });
  });

  it("inspects a selected proposal with the agent from the current session", async () => {
    const { state, context, request } = createFixture(
      { skillWorkshopProposals: [proposal({ body: "" })] },
      { sessionKey: "agent:ops-team:main" },
    );
    request.mockResolvedValue(inspectResult());

    await selectSkillWorkshopProposal(state, context, "proposal-1");

    expect(request).toHaveBeenCalledWith("skills.proposals.inspect", {
      agentId: "ops-team",
      proposalId: "proposal-1",
    });
    expect(state.skillWorkshopSelectedKey).toBe("proposal-1");
  });

  it.each([
    ["apply", "skills.proposals.apply", "applied"],
    ["reject", "skills.proposals.reject", "rejected"],
  ] as const)(
    "%s sends the selected agent id and refreshes that agent scope",
    async (action, method, status) => {
      const { state, context, request } = createFixture(
        {
          skillWorkshopProposals: [proposal()],
          skillWorkshopSelectedKey: "proposal-1",
        },
        { assistantAgentId: "reviewer" },
      );
      request.mockImplementation(async (calledMethod: string) => {
        if (calledMethod === method) {
          return {};
        }
        if (calledMethod === "skills.proposals.list") {
          return manifest(status);
        }
        if (calledMethod === "skills.proposals.inspect") {
          return inspectResult(status);
        }
        return {};
      });

      try {
        await runSkillWorkshopLifecycleAction(state, context, action, "proposal-1");
      } finally {
        clearNoticeTimer(state);
      }

      expect(request).toHaveBeenNthCalledWith(1, method, {
        agentId: "reviewer",
        proposalId: "proposal-1",
      });
      expect(request).toHaveBeenNthCalledWith(2, "skills.proposals.list", {
        agentId: "reviewer",
      });
      expect(request).toHaveBeenNthCalledWith(3, "skills.proposals.inspect", {
        agentId: "reviewer",
        proposalId: "proposal-1",
      });
    },
  );

  it("evaluates the freshly inspected revision and merges the attributed result", async () => {
    const evaluation = {
      id: "evaluation-1",
      proposedVersion: "v1",
      revisionHash: REVISION_HASH,
      trigger: "manual",
      startedAt: ISO_NOW,
      completedAt: ISO_NOW,
      outcomes: [
        {
          pluginId: "quality-plugin",
          pluginVersion: "1.2.3",
          evaluatorId: "quality",
          status: "completed",
          result: {
            summary: "One blocking issue.",
            decision: "block",
            decisionReason: "The draft needs a rollback step.",
          },
        },
      ],
    } as const;
    const baseInspect = inspectResult();
    const evaluatedInspect = {
      ...baseInspect,
      record: { ...baseInspect.record, evaluation },
    };
    const evaluateResult = {
      record: evaluatedInspect.record,
      evaluation,
    };
    let inspectCalls = 0;
    const { state, context, request } = createFixture({
      skillWorkshopAgentId: "research",
      skillWorkshopProposals: [proposal({ revisionHash: "c".repeat(64) })],
      skillWorkshopSelectedKey: "proposal-1",
    });
    request.mockImplementation(async (method: string) => {
      if (method === "skills.proposals.inspect") {
        inspectCalls += 1;
        return inspectCalls === 1 ? inspectResult() : evaluatedInspect;
      }
      if (method === "skills.proposals.evaluate") {
        return evaluateResult;
      }
      return {};
    });

    try {
      await expect(runSkillWorkshopEvaluation(state, context, "proposal-1")).resolves.toBe(true);
    } finally {
      clearNoticeTimer(state);
    }

    expect(request).toHaveBeenNthCalledWith(1, "skills.proposals.inspect", {
      agentId: "research",
      proposalId: "proposal-1",
    });
    expect(request).toHaveBeenNthCalledWith(2, "skills.proposals.evaluate", {
      agentId: "research",
      proposalId: "proposal-1",
      expectedRevisionHash: REVISION_HASH,
    });
    expect(request).toHaveBeenNthCalledWith(3, "skills.proposals.inspect", {
      agentId: "research",
      proposalId: "proposal-1",
    });
    expect(state.skillWorkshopProposals[0]?.evaluation?.outcomes[0]).toMatchObject({
      pluginId: "quality-plugin",
      evaluatorId: "quality",
      status: "completed",
      result: { decision: "block" },
    });
  });

  it("drops an inspected evaluation that belongs to a different revision", async () => {
    const baseInspect = inspectResult();
    const { state, context, request } = createFixture({
      skillWorkshopProposals: [proposal({ body: "" })],
    });
    request.mockResolvedValue({
      ...baseInspect,
      record: {
        ...baseInspect.record,
        evaluation: {
          id: "evaluation-stale",
          proposedVersion: "v0",
          revisionHash: "c".repeat(64),
          trigger: "manual",
          startedAt: ISO_NOW,
          completedAt: ISO_NOW,
          outcomes: [],
        },
      },
    });

    await selectSkillWorkshopProposal(state, context, "proposal-1");

    expect(state.skillWorkshopProposals[0]?.revisionHash).toBe(REVISION_HASH);
    expect(state.skillWorkshopProposals[0]?.evaluation).toBeUndefined();
  });

  it("rejects an evaluation response for a different revision", async () => {
    const baseInspect = inspectResult();
    const mismatchedEvaluation = {
      id: "evaluation-stale",
      proposedVersion: "v0",
      revisionHash: "c".repeat(64),
      trigger: "manual",
      startedAt: ISO_NOW,
      completedAt: ISO_NOW,
      outcomes: [],
    } as const;
    const { state, context, request } = createFixture({
      skillWorkshopAgentId: "research",
      skillWorkshopProposals: [proposal()],
    });
    request.mockImplementation(async (method: string) =>
      method === "skills.proposals.inspect"
        ? baseInspect
        : {
            record: { ...baseInspect.record, evaluation: mismatchedEvaluation },
            evaluation: mismatchedEvaluation,
          },
    );

    await expect(runSkillWorkshopEvaluation(state, context, "proposal-1")).resolves.toBe(false);

    expect(state.skillWorkshopError).toBe("The proposal revision changed during evaluation.");
    expect(state.skillWorkshopProposals[0]?.evaluation).toBeUndefined();
  });

  it("loads legacy inspect responses but refuses revision-sensitive evaluation", async () => {
    const { revisionHash: _revisionHash, ...legacyInspect } = inspectResult();
    const { state, context, request } = createFixture({
      skillWorkshopAgentId: "research",
      skillWorkshopProposals: [proposal()],
    });
    request.mockResolvedValue(legacyInspect);

    await expect(runSkillWorkshopEvaluation(state, context, "proposal-1")).resolves.toBe(false);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("skills.proposals.inspect", {
      agentId: "research",
      proposalId: "proposal-1",
    });
    expect(state.skillWorkshopError).toBe("The current proposal revision could not be identified.");
    expect(state.skillWorkshopProposals[0]?.revisionHash).toBeNull();
  });

  it("reloads proposals when the selected session changes agent scope", async () => {
    const { state, context, request } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopLoaded: true,
        skillWorkshopProposals: [proposal()],
      },
      { sessionKey: "agent:ops:main" },
    );
    request.mockImplementation(async (method: string) => {
      if (method === "skills.proposals.list") {
        return manifest();
      }
      if (method === "skills.proposals.inspect") {
        return inspectResult();
      }
      return {};
    });

    await loadSkillWorkshopProposals(state, context);

    expect(state.skillWorkshopAgentId).toBe("ops");
    expect(request).toHaveBeenNthCalledWith(1, "skills.proposals.list", { agentId: "ops" });
    expect(request).toHaveBeenNthCalledWith(2, "skills.proposals.inspect", {
      agentId: "ops",
      proposalId: "proposal-1",
    });
  });

  it("clears stale proposals when the agent changes during an in-flight reload", async () => {
    const researchList = createDeferred<ReturnType<typeof manifest>>();
    const { state, context, request, snapshot } = createFixture({
      skillWorkshopAgentId: "research",
      skillWorkshopLoaded: true,
      skillWorkshopProposals: [proposal()],
    });
    request.mockImplementation(async (method: string, payload?: unknown) => {
      if (method !== "skills.proposals.list") {
        return inspectResult();
      }
      return (payload as { agentId?: string }).agentId === "research"
        ? researchList.promise
        : manifest();
    });

    const researchReload = loadSkillWorkshopProposals(state, context, { force: true });
    snapshot.assistantAgentId = "ops";
    await loadSkillWorkshopProposals(state, context);

    expect(state.skillWorkshopAgentId).toBe("ops");
    expect(state.skillWorkshopProposals).toEqual([]);

    researchList.resolve(manifest());
    await researchReload;
    await vi.waitFor(() => {
      expect(state.skillWorkshopLoaded).toBe(true);
    });

    expect(state.skillWorkshopAgentId).toBe("ops");
    expect(request).toHaveBeenCalledWith("skills.proposals.list", { agentId: "ops" });
  });

  it("discards selected proposal detail that resolves after the agent scope changes", async () => {
    const detail = createDeferred<ReturnType<typeof inspectResult>>();
    const { state, context, request } = createFixture({
      skillWorkshopAgentId: "research",
      skillWorkshopProposals: [proposal({ body: "" })],
    });
    request.mockReturnValueOnce(detail.promise);

    const loading = selectSkillWorkshopProposal(state, context, "proposal-1");
    state.skillWorkshopAgentId = "ops";
    state.skillWorkshopProposals = [proposal({ body: "Ops proposal." })];
    state.skillWorkshopInspectingKey = "proposal-1";
    detail.resolve(inspectResult());
    await loading;

    expect(state.skillWorkshopProposals[0]?.body).toBe("Ops proposal.");
    expect(state.skillWorkshopInspectingKey).toBe("proposal-1");
    expect(state.skillWorkshopSelectedKey).toBeNull();
  });

  it("preserves the loaded proposal agent for originless revisions", async () => {
    const { state, context } = createFixture({
      skillWorkshopAgentId: "research",
      skillWorkshopProposals: [proposal()],
      skillWorkshopRevisionDraft: "Tighten the trigger.",
    });
    const sendRevisionRequest = vi.fn(async () => {});

    try {
      await requestSkillWorkshopRevision(state, context, "proposal-1", sendRevisionRequest);
    } finally {
      clearNoticeTimer(state);
    }

    expect(sendRevisionRequest).toHaveBeenCalledWith(
      "Tighten the trigger.",
      expect.objectContaining({ key: "proposal-1" }),
      "research",
    );
  });

  it("does not send an originless revision after the agent scope changes", async () => {
    const detail = createDeferred<ReturnType<typeof inspectResult>>();
    const { state, context, request } = createFixture({
      skillWorkshopAgentId: "research",
      skillWorkshopProposals: [proposal({ body: "" })],
      skillWorkshopRevisionDraft: "Tighten the trigger.",
    });
    request.mockReturnValueOnce(detail.promise);
    const sendRevisionRequest = vi.fn(async () => {});

    const revision = requestSkillWorkshopRevision(
      state,
      context,
      "proposal-1",
      sendRevisionRequest,
    );
    state.skillWorkshopAgentId = "ops";
    detail.resolve(inspectResult());

    await expect(revision).resolves.toBe(false);
    expect(sendRevisionRequest).not.toHaveBeenCalled();
  });
});
