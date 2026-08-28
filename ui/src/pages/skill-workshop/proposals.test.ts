// @vitest-environment node
// Control UI tests cover skill workshop controller behavior.
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { SkillWorkshopProposal } from "../../lib/skill-workshop/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
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
const UPDATED_REVISION_HASH = "c".repeat(64);

function createFixture(
  overrides: Partial<SkillWorkshopState> = {},
  snapshotOverrides: Partial<ApplicationGatewaySnapshot> = {},
  methods: string[] = ["skills.proposals.list", "skills.proposals.inspect"],
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
    hello: gatewayHelloForMethods(methods),
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
      connectionRevision: 0,
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
    kind: "update",
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
    bodyLoaded: true,
    isNew: false,
    ...overrides,
  };
}

function proposalDecision(expectedRevisionHash: string | null = REVISION_HASH) {
  return { proposalId: "proposal-1", expectedRevisionHash };
}

// The mutation RPC returns the authoritative terminal record: apply wraps it
// in `{ record, targetSkillFile }`, reject returns the bare record.
function recordFrom(status: SkillWorkshopProposal["status"]): Record<string, unknown> {
  return {
    id: "proposal-1",
    kind: "create",
    status,
    title: "Inbox Cleaner",
    description: "Clean inbox triage",
    createdAt: ISO_NOW,
    updatedAt: ISO_NOW,
    proposedVersion: "v1",
    draftHash: DRAFT_HASH,
    origin: { agentId: "research", sessionKey: "main" },
    target: { skillName: "Inbox Cleaner", skillKey: "inbox-cleaner" },
  };
}

function mutationResponse(
  action: "apply" | "reject",
  status: SkillWorkshopProposal["status"],
): unknown {
  const record = recordFrom(status);
  return action === "apply" ? { record, targetSkillFile: "skills/inbox-cleaner/SKILL.md" } : record;
}

function clearNoticeTimer(state: SkillWorkshopState): void {
  if (state.skillWorkshopActionNoticeTimer) {
    globalThis.clearTimeout(state.skillWorkshopActionNoticeTimer);
    state.skillWorkshopActionNoticeTimer = null;
  }
}

function terminalStatusFor(action: "apply" | "reject"): SkillWorkshopProposal["status"] {
  return action === "apply" ? "applied" : "rejected";
}

// Asserts the leak-free invariant shared by every in-flight agent-scope switch
// case: neither the notice nor the originating terminal row nor the
// unconfirmed-status error may surface in the new agent's workspace.
function expectNoLeak(state: SkillWorkshopState, action: "apply" | "reject"): void {
  const terminalStatus = terminalStatusFor(action);
  expect(state.skillWorkshopActionNotice).toBeNull();
  expect(
    state.skillWorkshopProposals.some(
      (item) => item.key === "proposal-1" && item.status === terminalStatus,
    ),
  ).toBe(false);
  expect(state.skillWorkshopError ?? "").not.toContain("did not confirm as expected");
}

describe("Skill Workshop proposal RPCs", () => {
  it("does not dispatch proposal mutations with read-only operator access", async () => {
    const { state, context, request } = createFixture(
      { skillWorkshopProposals: [proposal()] },
      {
        hello: gatewayHelloForMethods(
          [
            "skills.proposals.apply",
            "skills.proposals.evaluate",
            "skills.proposals.requestRevision",
          ],
          ["operator.read"],
        ),
      },
    );

    await runSkillWorkshopLifecycleAction(state, context, "apply", proposalDecision());
    await expect(runSkillWorkshopEvaluation(state, context, "proposal-1")).resolves.toBe(false);
    await expect(requestSkillWorkshopRevision(state, context, "proposal-1", vi.fn())).resolves.toBe(
      null,
    );
    expect(request).not.toHaveBeenCalled();
  });

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
    expect(state.skillWorkshopProposals[0]?.kind).toBe("create");
  });

  it("reports a failed inspect for a selection retained across refresh", async () => {
    const appliedManifest = manifest("applied");
    const latest = appliedManifest.proposals[0];
    if (!latest) {
      throw new Error("Expected proposal fixture");
    }
    const previous = {
      ...latest,
      id: "proposal-0",
      updatedAt: "2026-06-15T12:00:00.000Z",
    };
    const { state, context, request } = createFixture({
      skillWorkshopAgentId: "research",
      skillWorkshopSelectedKey: "proposal-1",
    });
    request.mockImplementation(async (method: string) => {
      if (method === "skills.proposals.list") {
        return { ...appliedManifest, proposals: [latest, previous] };
      }
      throw new Error("inspect failed");
    });

    await loadSkillWorkshopProposals(state, context, { force: true });

    expect(state.skillWorkshopSelectedKey).toBe("proposal-1");
    expect(state.skillWorkshopError).toContain("inspect failed");
    expect(request.mock.calls.filter(([method]) => method === "skills.proposals.inspect")).toEqual([
      ["skills.proposals.inspect", { agentId: "research", proposalId: "proposal-1" }],
    ]);
  });

  it("preserves capped support-file size formatting through the shared helper", async () => {
    const { state, context, request } = createFixture();
    const baseInspect = inspectResult();
    const inspected = {
      ...baseInspect,
      record: {
        ...baseInspect.record,
        supportFiles: [{ path: "reference.md", sizeBytes: 1024 * 1024 }],
      },
      supportFiles: [{ path: "reference.md", content: "reference" }],
    };
    request.mockImplementation(async (method: string) => {
      if (method === "skills.proposals.list") {
        return manifest();
      }
      if (method === "skills.proposals.inspect") {
        return inspected;
      }
      return {};
    });

    await loadSkillWorkshopProposals(state, context);

    expect(state.skillWorkshopProposals[0]?.supportFiles[0]?.size).toBe("1024.0 KB");
  });

  it("inspects a selected proposal with the agent from the current session", async () => {
    const { state, context, request } = createFixture(
      { skillWorkshopProposals: [proposal({ body: "", bodyLoaded: false })] },
      { sessionKey: "agent:ops-team:main" },
      ["skills.proposals.inspect"],
    );
    request.mockResolvedValue(inspectResult());

    await selectSkillWorkshopProposal(state, context, "proposal-1");

    expect(request).toHaveBeenCalledWith("skills.proposals.inspect", {
      agentId: "ops-team",
      proposalId: "proposal-1",
    });
    expect(state.skillWorkshopSelectedKey).toBe("proposal-1");
    const inspected = state.skillWorkshopProposals[0]!;
    expect(inspected.bodyLoaded).toBe(true);
    expect(inspected.body).toBe("Review unread mail and archive low-priority threads.");
    expect(inspected.slug).toBe("inbox-cleaner");
    expect(inspected.name).toBe("Inbox Cleaner");
    expect(inspected.version).toBe(1);
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
        [method, "skills.proposals.list", "skills.proposals.inspect"],
      );
      request.mockImplementation(async (calledMethod: string) => {
        if (calledMethod === method) {
          return mutationResponse(action, status);
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
        await runSkillWorkshopLifecycleAction(state, context, action, proposalDecision());
      } finally {
        clearNoticeTimer(state);
      }

      expect(request).toHaveBeenNthCalledWith(1, method, {
        agentId: "reviewer",
        expectedRevisionHash: REVISION_HASH,
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

  it.each(
    (
      [
        ["shows the terminal notice from the authoritative mutation record", "success", "ok"],
        [
          "withholds the success notice when the mutation record is not terminal",
          "unconfirmed",
          "ok",
        ],
        ["keeps the authoritative success notice when the refresh fails", "success", "fails"],
      ] as const
    ).flatMap(([name, outcome, refresh]) =>
      (["apply", "reject"] as const).map((action) => ({ name, action, outcome, refresh })),
    ),
  )("$name ($action)", async ({ action, outcome, refresh }) => {
    const method = `skills.proposals.${action}`;
    const terminal = terminalStatusFor(action);
    const mutationStatus: SkillWorkshopProposal["status"] =
      outcome === "unconfirmed" ? "pending" : terminal;
    const { state, context, request } = createFixture(
      { skillWorkshopProposals: [proposal()], skillWorkshopSelectedKey: "proposal-1" },
      {},
      [method, "skills.proposals.list", "skills.proposals.inspect"],
    );
    request.mockImplementation(async (calledMethod: string) => {
      if (calledMethod === method) {
        return mutationResponse(action, mutationStatus);
      }
      if (calledMethod === "skills.proposals.list") {
        if (refresh === "fails") {
          throw new Error("refresh failed");
        }
        return manifest(mutationStatus);
      }
      if (calledMethod === "skills.proposals.inspect") {
        if (refresh === "fails") {
          throw new Error("refresh inspect failed");
        }
        return inspectResult(mutationStatus);
      }
      return {};
    });

    try {
      await runSkillWorkshopLifecycleAction(state, context, action, proposalDecision());
    } finally {
      clearNoticeTimer(state);
    }

    if (outcome === "unconfirmed") {
      expect(state.skillWorkshopActionNotice?.label).not.toBe(
        action === "apply" ? "Applied" : "Rejected",
      );
      expect(state.skillWorkshopError).toContain("did not confirm as expected");
      expect(state.skillWorkshopProposals[0]?.status).toBe("pending");
      return;
    }
    expect(state.skillWorkshopActionNotice?.label).toBe(
      action === "apply" ? "Applied" : "Rejected",
    );
    expect(state.skillWorkshopProposals[0]?.status).toBe(terminal);
    if (refresh === "ok") {
      expect(state.skillWorkshopError).toBeNull();
    } else {
      expect(state.skillWorkshopError ?? "").not.toContain("did not confirm as expected");
    }
  });

  it("apply keeps the authoritative success notice when the connection drops before refresh", async () => {
    const method = "skills.proposals.apply";
    const { state, context, request, snapshot } = createFixture(
      {
        skillWorkshopProposals: [proposal()],
        skillWorkshopSelectedKey: "proposal-1",
      },
      {},
      [method, "skills.proposals.list", "skills.proposals.inspect"],
    );
    let connectionDropped = false;
    request.mockImplementation(async (calledMethod: string) => {
      if (calledMethod === method) {
        // The apply RPC returns the committed applied record, then the gateway
        // connection drops before the refresh, so both loaders silently early-
        // return and the merged applied row is preserved.
        connectionDropped = true;
        snapshot.phase = "reconnecting";
        return mutationResponse("apply", "applied");
      }
      if (calledMethod === "skills.proposals.list") {
        expect(connectionDropped).toBe(false);
        return manifest("pending");
      }
      if (calledMethod === "skills.proposals.inspect") {
        return inspectResult("pending");
      }
      return {};
    });

    try {
      await runSkillWorkshopLifecycleAction(state, context, "apply", proposalDecision());
    } finally {
      clearNoticeTimer(state);
    }

    expect(request).toHaveBeenCalledWith(method, {
      agentId: "research",
      expectedRevisionHash: REVISION_HASH,
      proposalId: "proposal-1",
    });
    expect(state.skillWorkshopActionNotice?.label).toBe("Applied");
    expect(state.skillWorkshopProposals[0]?.status).toBe("applied");
    expect(state.skillWorkshopError).toBeNull();
  });

  it.each(
    (
      [
        ["does not publish the terminal result across an in-flight scope switch", "success", false],
        [
          "does not publish the terminal result across a scope switch with a dropped connection",
          "success",
          true,
        ],
        [
          "does not write the unconfirmed-status error across an in-flight scope switch",
          "unconfirmed",
          false,
        ],
        [
          "does not show the revision-changed notice across an in-flight scope switch",
          "revision",
          false,
        ],
        [
          "does not write the generic action error across an in-flight scope switch",
          "generic",
          false,
        ],
      ] as const
    ).flatMap(([name, mode, disconnect]) =>
      (["apply", "reject"] as const).map((action) => ({ name, action, mode, disconnect })),
    ),
  )("$name ($action)", async ({ action, mode, disconnect }) => {
    const method = `skills.proposals.${action}`;
    const terminal = terminalStatusFor(action);
    const { state, context, request, snapshot } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopProposals: [proposal()],
        skillWorkshopSelectedKey: "proposal-1",
      },
      {},
      [method, "skills.proposals.list", "skills.proposals.inspect"],
    );
    const deferred = createDeferred<ReturnType<typeof mutationResponse>>();
    request.mockImplementation(async (calledMethod: string) => {
      if (calledMethod === method) {
        return deferred.promise;
      }
      if (disconnect) {
        return {};
      }
      if (calledMethod === "skills.proposals.list") {
        // After the switch the new scope's list has no proposal-1, so any
        // appearing applied row would only come from an unscoped leak.
        return mode === "success"
          ? { schema: manifest().schema, updatedAt: manifest().updatedAt, proposals: [] }
          : manifest("pending");
      }
      if (calledMethod === "skills.proposals.inspect") {
        if (mode === "success") {
          throw new Error("proposal not in scope");
        }
        return inspectResult("pending");
      }
      return {};
    });

    let actionPromise: Promise<void>;
    try {
      actionPromise = runSkillWorkshopLifecycleAction(state, context, action, proposalDecision());
      // The mutation is in flight when the session-derived agent scope changes
      // (and, optionally, the connection drops before the refresh can run).
      snapshot.sessionKey = "agent:ops:main";
      if (disconnect) {
        snapshot.phase = "reconnecting";
      }
      if (mode === "revision") {
        deferred.reject(
          new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Skill proposal revision changed",
            details: {
              code: "SKILL_PROPOSAL_REVISION_CHANGED",
              currentRevisionHash: UPDATED_REVISION_HASH,
              expectedRevisionHash: REVISION_HASH,
            },
          }),
        );
      } else if (mode === "generic") {
        deferred.reject(new Error(`${action} failed`));
      } else {
        deferred.resolve(mutationResponse(action, mode === "unconfirmed" ? "pending" : terminal));
      }
      await actionPromise;
    } finally {
      clearNoticeTimer(state);
    }

    expect(request).toHaveBeenCalledWith(method, {
      agentId: "research",
      expectedRevisionHash: REVISION_HASH,
      proposalId: "proposal-1",
    });
    if (disconnect) {
      const calledMethods = request.mock.calls.map(([calledMethod]) => calledMethod);
      expect(calledMethods).not.toContain("skills.proposals.list");
      expect(calledMethods).not.toContain("skills.proposals.inspect");
    }
    expectNoLeak(state, action);
    if (mode === "generic") {
      expect(state.skillWorkshopError).toBeNull();
    }
  });

  it.each(["apply", "reject"] as const)(
    "%s refuses to act without the reviewed revision hash",
    async (action) => {
      const method = `skills.proposals.${action}`;
      const { state, context, request } = createFixture(
        { skillWorkshopProposals: [proposal({ revisionHash: null })] },
        {},
        [method],
      );

      await runSkillWorkshopLifecycleAction(state, context, action, proposalDecision(null));

      expect(request).not.toHaveBeenCalled();
      expect(state.skillWorkshopError).toBe(
        "The current proposal revision could not be identified.",
      );
    },
  );

  it.each([
    ["apply", "skills.proposals.apply"],
    ["reject", "skills.proposals.reject"],
  ] as const)(
    "%s refreshes a changed proposal without replaying the stale decision",
    async (action, method) => {
      const updatedAt = "2026-06-16T12:01:00.000Z";
      const updatedManifest = manifest();
      updatedManifest.updatedAt = updatedAt;
      updatedManifest.proposals[0] = {
        ...updatedManifest.proposals[0]!,
        description: "Clean inbox triage with an explicit archive review",
        updatedAt,
      };
      const updatedInspect = inspectResult();
      updatedInspect.record = {
        ...updatedInspect.record,
        description: "Clean inbox triage with an explicit archive review",
        proposedVersion: "v2",
        updatedAt,
      };
      updatedInspect.revisionHash = UPDATED_REVISION_HASH;
      updatedInspect.content = "Review unread mail, confirm archive candidates, then archive.";
      const { state, context, request } = createFixture(
        {
          skillWorkshopAgentId: "reviewer",
          skillWorkshopProposals: [proposal()],
          skillWorkshopSelectedKey: "proposal-1",
        },
        { assistantAgentId: "reviewer" },
        [method, "skills.proposals.list", "skills.proposals.inspect"],
      );
      let stale = true;
      request.mockImplementation(async (calledMethod: string) => {
        if (calledMethod === method) {
          if (stale) {
            stale = false;
            throw new GatewayRequestError({
              code: "INVALID_REQUEST",
              message: "Skill proposal revision changed",
              details: {
                code: "SKILL_PROPOSAL_REVISION_CHANGED",
                currentRevisionHash: UPDATED_REVISION_HASH,
                expectedRevisionHash: REVISION_HASH,
              },
            });
          }
          return {};
        }
        if (calledMethod === "skills.proposals.list") {
          return updatedManifest;
        }
        if (calledMethod === "skills.proposals.inspect") {
          return updatedInspect;
        }
        return {};
      });

      await runSkillWorkshopLifecycleAction(state, context, action, proposalDecision());

      const actionCalls = () =>
        request.mock.calls.filter(([calledMethod]) => calledMethod === method);
      expect(actionCalls()).toEqual([
        [
          method,
          {
            agentId: "reviewer",
            expectedRevisionHash: REVISION_HASH,
            proposalId: "proposal-1",
          },
        ],
      ]);
      expect(state.skillWorkshopProposals[0]).toMatchObject({
        body: "Review unread mail, confirm archive candidates, then archive.",
        revisionHash: UPDATED_REVISION_HASH,
        version: 2,
      });
      expect(state.skillWorkshopActionNotice).toMatchObject({
        key: "proposal-1",
        label: "Proposal changed. Review the updated draft before choosing another action.",
      });
      expect(state.skillWorkshopActionNoticeTimer).toBeNull();
      expect(state.skillWorkshopError).toBeNull();

      try {
        await runSkillWorkshopLifecycleAction(
          state,
          context,
          action,
          proposalDecision(UPDATED_REVISION_HASH),
        );
      } finally {
        clearNoticeTimer(state);
      }

      expect(actionCalls()).toHaveLength(2);
      expect(actionCalls()[1]).toEqual([
        method,
        {
          agentId: "reviewer",
          expectedRevisionHash: UPDATED_REVISION_HASH,
          proposalId: "proposal-1",
        },
      ]);
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
    const { state, context, request } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopProposals: [proposal({ revisionHash: "c".repeat(64) })],
        skillWorkshopSelectedKey: "proposal-1",
      },
      {},
      ["skills.proposals.inspect", "skills.proposals.evaluate"],
    );
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
    const evaluated = state.skillWorkshopProposals[0]!;
    expect(evaluated.revisionHash).toBe(REVISION_HASH);
    expect(evaluated.body).toBe("Review unread mail and archive low-priority threads.");
    expect(evaluated.supportFiles).toEqual([]);
    expect(evaluated.slug).toBe("inbox-cleaner");
  });

  it("does not evaluate after the initiating source changes during inspection", async () => {
    const detail = createDeferred<ReturnType<typeof inspectResult>>();
    const { state, context, request } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopProposals: [proposal({ body: "", bodyLoaded: false })],
      },
      {},
      ["skills.proposals.inspect", "skills.proposals.evaluate"],
    );
    let current = true;
    request.mockImplementation((method: string) =>
      method === "skills.proposals.inspect" ? detail.promise : Promise.resolve({}),
    );

    const evaluation = runSkillWorkshopEvaluation(state, context, "proposal-1", () => current);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    current = false;
    detail.resolve(inspectResult());

    await expect(evaluation).resolves.toBe(false);
    expect(request).not.toHaveBeenCalledWith("skills.proposals.evaluate", expect.anything());
  });

  it("drops an inspected evaluation that belongs to a different revision", async () => {
    const baseInspect = inspectResult();
    const { state, context, request } = createFixture(
      { skillWorkshopProposals: [proposal({ body: "", bodyLoaded: false })] },
      {},
      ["skills.proposals.inspect"],
    );
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
    const { state, context, request } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopProposals: [proposal()],
      },
      {},
      ["skills.proposals.inspect", "skills.proposals.evaluate"],
    );
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
    const { state, context, request } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopProposals: [proposal()],
      },
      {},
      ["skills.proposals.inspect", "skills.proposals.evaluate"],
    );
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
    const { state, context, request } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopProposals: [proposal({ body: "", bodyLoaded: false })],
      },
      {},
      ["skills.proposals.inspect"],
    );
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
    const { state, context } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopProposals: [proposal()],
        skillWorkshopRevisionDraft: "Tighten the trigger.",
      },
      {},
      ["skills.proposals.requestRevision"],
    );
    const sendRevisionRequest = vi.fn(async () => ({
      id: "revision-1",
      sessionKey: "agent:research:workshop",
      status: "admitted" as const,
    }));

    try {
      await requestSkillWorkshopRevision(state, context, "proposal-1", sendRevisionRequest);
    } finally {
      clearNoticeTimer(state);
    }

    expect(sendRevisionRequest).toHaveBeenCalledWith(
      "Tighten the trigger.",
      expect.objectContaining({ key: "proposal-1" }),
      "research",
      REVISION_HASH,
    );
  });

  it("ignores a superseded selection and keeps its error out of the pane", async () => {
    const first = createDeferred<ReturnType<typeof inspectResult>>();
    const second = createDeferred<ReturnType<typeof inspectResult>>();
    const { state, context, request } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopProposals: [
          proposal({ key: "proposal-1", body: "", bodyLoaded: false }),
          proposal({ key: "proposal-2", body: "", bodyLoaded: false }),
        ],
      },
      {},
      ["skills.proposals.inspect"],
    );
    request.mockImplementation(async (_method, payload) =>
      (payload as { proposalId: string }).proposalId === "proposal-1"
        ? first.promise
        : second.promise,
    );

    const stale = selectSkillWorkshopProposal(state, context, "proposal-1");
    const latest = selectSkillWorkshopProposal(state, context, "proposal-2");
    const base = inspectResult();
    second.resolve({ ...base, record: { ...base.record, id: "proposal-2" } });
    await latest;
    first.reject(new Error("inspect failed"));
    await stale;

    expect(state.skillWorkshopSelectedKey).toBe("proposal-2");
    expect(state.skillWorkshopError).toBeNull();
  });

  it("inspects a revision once even when its body is legitimately empty", async () => {
    const { state, context, request } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopProposals: [proposal({ body: "", bodyLoaded: false })],
      },
      {},
      ["skills.proposals.inspect"],
    );
    const base = inspectResult();
    request.mockResolvedValue({ ...base, content: "" });

    await Promise.all([
      selectSkillWorkshopProposal(state, context, "proposal-1"),
      selectSkillWorkshopProposal(state, context, "proposal-1"),
    ]);
    await selectSkillWorkshopProposal(state, context, "proposal-1");

    expect(state.skillWorkshopProposals[0]?.body).toBe("");
    expect(state.skillWorkshopProposals[0]?.bodyLoaded).toBe(true);
    expect(
      request.mock.calls.filter(([method]) => method === "skills.proposals.inspect"),
    ).toHaveLength(1);
    expect(state.skillWorkshopSelectedKey).toBe("proposal-1");
  });
});
