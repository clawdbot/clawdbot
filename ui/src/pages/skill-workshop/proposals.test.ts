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
  selectSkillWorkshopInstalledSkill,
  type SkillWorkshopContext,
  type SkillWorkshopState,
} from "./proposals.ts";

type TestRequest = (method: string, payload?: unknown) => Promise<unknown>;

vi.mock("../../lib/skill-workshop/diff-worker.ts", async () => {
  const { computeSkillWorkshopDiff } = await import("../../lib/skill-workshop/diff.ts");
  return {
    compareSkillWorkshopInstructions: vi.fn(async (previous: string, current: string) =>
      computeSkillWorkshopDiff(previous, current),
    ),
  };
});

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
      eventLogRevision: 0,
      connect: vi.fn(),
      setSessionKey: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      subscribeEventLog: vi.fn(() => () => {}),
      subscribeEvents: vi.fn(() => () => {}),
    },
  };
  return {
    state: { ...createSkillWorkshopState(), skillWorkshopMode: "suggestions", ...overrides },
    context,
    request,
    snapshot,
  };
}

function manifest(status: SkillWorkshopProposal["status"] = "pending") {
  return {
    schema: "openclaw.skill-workshop.proposals-manifest.v1",
    installedSkills: [],
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
        revisionHash: REVISION_HASH,
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
    ...overrides,
  };
}

function proposalDecision(expectedRevisionHash: string | null = REVISION_HASH) {
  return { proposalId: "proposal-1", expectedRevisionHash };
}

function clearNoticeTimer(state: SkillWorkshopState): void {
  if (state.skillWorkshopActionNoticeTimer) {
    globalThis.clearTimeout(state.skillWorkshopActionNoticeTimer);
    state.skillWorkshopActionNoticeTimer = null;
  }
}

describe("Skill Workshop proposal RPCs", () => {
  it("reads current installed content and compares only its own applied proposals", async () => {
    const installed = {
      name: "inbox-cleaner",
      skillKey: "inbox-cleaner",
      description: "Current inbox procedure",
    };
    const { state, context, request } = createFixture({ skillWorkshopMode: "skills" });
    request.mockImplementation(async (method, payload) => {
      if (method === "skills.proposals.list") {
        return {
          ...manifest("applied"),
          installedSkills: [installed],
          proposals: [
            { ...manifest("applied").proposals[0], id: "workshop" },
            { ...manifest("applied").proposals[0], id: "workspace" },
          ],
        };
      }
      if (method === "skills.workshop.read") {
        return { ...installed, content: "# Current procedure\n\nChanged by collection review." };
      }
      const { proposalId } = payload as { proposalId: string };
      return {
        ...inspectResult("applied"),
        record: {
          ...inspectResult("applied").record,
          id: proposalId,
          appliedAt: ISO_NOW,
          target: {
            skillName: "Inbox Cleaner",
            skillKey: installed.skillKey,
            source: proposalId === "workshop" ? "openclaw-workshop" : "openclaw-workspace",
          },
        },
      };
    });

    await loadSkillWorkshopProposals(state, context);

    expect(state.skillWorkshopInstalledSkills.map((skill) => skill.name)).toEqual([installed.name]);
    expect(state.skillWorkshopInstalledName).toBe(installed.name);
    const read = state.skillWorkshopInstalledSkills[0]?.read;
    expect(read).toMatchObject({
      status: "ready",
      content: "# Current procedure\n\nChanged by collection review.",
    });
    expect(read?.status === "ready" && read.savedVersions.map((version) => version.key)).toEqual([
      "workshop",
    ]);
    expect(request).toHaveBeenCalledWith("skills.workshop.read", {
      agentId: "research",
      name: installed.name,
    });
  });

  it("loads Suggestions without reading installed skill bodies", async () => {
    const { state, context, request } = createFixture();
    request.mockImplementation(async (method) =>
      method === "skills.proposals.list"
        ? {
            ...manifest(),
            installedSkills: [{ name: "inbox", skillKey: "inbox", description: "Inbox procedure" }],
          }
        : inspectResult(),
    );

    await loadSkillWorkshopProposals(state, context);

    expect(state.skillWorkshopProposals[0]?.body).toBe(
      "Review unread mail and archive low-priority threads.",
    );
    expect(request.mock.calls.filter(([method]) => method === "skills.workshop.read")).toEqual([]);
  });

  it("shares collection reads with clicks and keeps the latest selected skill", async () => {
    const installed = ["first", "second"].map((name) => ({
      name,
      skillKey: name,
      description: name,
    }));
    const first = createDeferred<unknown>();
    const second = createDeferred<unknown>();
    const { state, context, request } = createFixture({ skillWorkshopMode: "skills" });
    request.mockImplementation(async (method, payload) => {
      if (method === "skills.proposals.list") {
        return { ...manifest(), proposals: [], installedSkills: installed };
      }
      return (payload as { name: string }).name === "first" ? first.promise : second.promise;
    });

    const loading = loadSkillWorkshopProposals(state, context);
    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(([method]) => method === "skills.workshop.read"),
      ).toHaveLength(2),
    );
    const selecting = selectSkillWorkshopInstalledSkill(state, context, "second");
    second.resolve({ ...installed[1], content: "Second current body" });
    await selecting;
    first.resolve({ ...installed[0], content: "Late first body" });
    await loading;

    expect(state.skillWorkshopInstalledName).toBe("second");
    expect(
      state.skillWorkshopInstalledSkills.find((skill) => skill.name === "second")?.read,
    ).toMatchObject({
      status: "ready",
      content: "Second current body",
    });
    expect(request.mock.calls.filter(([method]) => method === "skills.workshop.read")).toHaveLength(
      2,
    );
  });

  it.each(["agent", "client"])("ignores an installed read after its %s changes", async (source) => {
    const installed = { name: "inbox-cleaner", skillKey: "inbox-cleaner", description: "Inbox" };
    const previous = createDeferred<unknown>();
    const { state, context, request, snapshot } = createFixture({
      skillWorkshopAgentId: "research",
      skillWorkshopInstalledSkills: [installed],
    });
    request.mockReturnValueOnce(previous.promise);
    const onProgress = vi.fn();
    const loading = selectSkillWorkshopInstalledSkill(state, context, installed.name, {
      onProgress,
    });
    if (source === "agent") {
      snapshot.assistantAgentId = "writer";
      state.skillWorkshopAgentId = "writer";
    } else {
      snapshot.client = createFixture().snapshot.client;
    }
    previous.resolve({ ...installed, content: "Stale source content" });
    await loading;

    expect(onProgress).not.toHaveBeenCalled();
    expect(state.skillWorkshopInstalledSkills[0]?.read).not.toHaveProperty("content");
    expect(state.skillWorkshopInstalledSkills[0]?.read).not.toMatchObject({
      status: "ready",
      content: "Stale source content",
    });
  });

  it("keeps a failed collection read until the operator explicitly retries it", async () => {
    const installed = { name: "inbox-cleaner", skillKey: "inbox-cleaner", description: "Inbox" };
    const { state, context, request } = createFixture({
      skillWorkshopAgentId: "research",
      skillWorkshopMode: "skills",
    });
    request.mockImplementation(async (method) => {
      if (method === "skills.proposals.list") {
        return { ...manifest(), proposals: [], installedSkills: [installed] };
      }
      throw new Error("Skill is temporarily unreadable");
    });
    await loadSkillWorkshopProposals(state, context);
    await selectSkillWorkshopInstalledSkill(state, context, installed.name);
    expect(state.skillWorkshopInstalledSkills[0]?.read).toMatchObject({
      status: "error",
      error: "Skill is temporarily unreadable",
    });
    expect(request.mock.calls.filter(([method]) => method === "skills.workshop.read")).toHaveLength(
      1,
    );
    request.mockResolvedValueOnce({
      name: "inbox-cleaner",
      skillKey: "inbox-cleaner",
      description: "Current inbox",
      content: "Recovered current body",
    });
    await selectSkillWorkshopInstalledSkill(state, context, "inbox-cleaner", { force: true });
    expect(state.skillWorkshopInstalledSkills[0]?.read).toMatchObject({
      status: "ready",
      content: "Recovered current body",
    });
    expect(request.mock.calls.filter(([method]) => method === "skills.workshop.read")).toHaveLength(
      2,
    );
  });

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
    const inspected = createDeferred<ReturnType<typeof inspectResult>>();
    request.mockImplementation(async (method: string) => {
      if (method === "skills.proposals.list") {
        return manifest();
      }
      if (method === "skills.proposals.inspect") {
        return inspected.promise;
      }
      return {};
    });

    const loading = loadSkillWorkshopProposals(state, context);
    await vi.waitFor(() => expect(state.skillWorkshopInspectingKey).toBe("proposal-1"));
    expect(state.skillWorkshopProposals[0]?.revisionHash).toBeNull();
    inspected.resolve(inspectResult());
    await loading;

    expect(request).toHaveBeenNthCalledWith(1, "skills.proposals.list", {
      agentId: "research",
    });
    expect(request).toHaveBeenNthCalledWith(2, "skills.proposals.inspect", {
      agentId: "research",
      proposalId: "proposal-1",
    });
    expect(state.skillWorkshopProposals[0]?.kind).toBe("create");
    expect(state.skillWorkshopProposals[0]?.revisionHash).toBe(REVISION_HASH);
  });

  it("reports a failed inspect for a selection retained across refresh", async () => {
    const pendingManifest = manifest();
    const latest = pendingManifest.proposals[0];
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
      skillWorkshopMode: "suggestions",
    });
    request.mockImplementation(async (method: string) => {
      if (method === "skills.proposals.list") {
        return { ...pendingManifest, proposals: [latest, previous] };
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

  it.each(["create", "update"] as const)(
    "keeps a missing %s draft dismissible beside a usable suggestion",
    async (kind) => {
      const missing = {
        ...manifest().proposals[0],
        kind,
        degradedState: "draft-missing",
      };
      const valid = { ...manifest().proposals[0], id: "proposal-2" };
      let status: SkillWorkshopProposal["status"] = "pending";
      const { state, context, request } = createFixture(
        {
          skillWorkshopAgentId: "research",
          skillWorkshopProposals: [proposal({ body: "Previously available draft." })],
          skillWorkshopRevisionDraft: "Revise this suggestion.",
        },
        {},
        ["list", "inspect", "apply", "evaluate", "requestRevision", "reject"].map(
          (method) => `skills.proposals.${method}`,
        ),
      );
      const validInspect = inspectResult();
      validInspect.record.id = "proposal-2";
      request.mockImplementation(async (method, payload) => {
        if (method === "skills.proposals.list") {
          return { ...manifest(), proposals: [{ ...missing, status }, valid] };
        }
        if (method === "skills.proposals.inspect") {
          expect(payload).toEqual({ agentId: "research", proposalId: "proposal-2" });
          return validInspect;
        }
        if (method === "skills.proposals.reject") {
          expect(payload).toEqual({
            agentId: "research",
            proposalId: "proposal-1",
            expectedRevisionHash: REVISION_HASH,
          });
          status = "rejected";
          return {};
        }
        throw new Error(`Unexpected request: ${method}`);
      });

      await loadSkillWorkshopProposals(state, context);
      expect(state.skillWorkshopProposals[0]).toMatchObject({
        degradedState: "draft-missing",
        revisionHash: REVISION_HASH,
        body: "",
      });
      await runSkillWorkshopLifecycleAction(state, context, "apply", proposalDecision());
      await expect(runSkillWorkshopEvaluation(state, context, "proposal-1")).resolves.toBe(false);
      const sendRevision = vi.fn();
      await requestSkillWorkshopRevision(state, context, "proposal-1", sendRevision);
      expect(sendRevision).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);

      try {
        await runSkillWorkshopLifecycleAction(state, context, "reject", proposalDecision());
        expect(state.skillWorkshopError).toBeNull();
        expect(state.skillWorkshopProposals[1]?.body).toBe(validInspect.content);
      } finally {
        clearNoticeTimer(state);
      }
    },
  );

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

  it("uses the current session only when no agent is explicitly selected", async () => {
    const { state, context, request } = createFixture(
      { skillWorkshopProposals: [proposal({ body: "", bodyLoaded: false })] },
      { sessionKey: "agent:ops-team:main", assistantAgentId: null },
      ["skills.proposals.inspect"],
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
        [method, "skills.proposals.list", "skills.proposals.inspect"],
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
      expect(request.mock.calls.map(([calledMethod]) => calledMethod)).toEqual([
        method,
        "skills.proposals.list",
      ]);
    },
  );

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
        "The current suggestion revision could not be identified.",
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
        label: "Suggestion changed. Review the updated draft before choosing another action.",
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

    expect(state.skillWorkshopError).toBe("The suggestion revision changed during evaluation.");
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
    expect(state.skillWorkshopError).toBe(
      "The current suggestion revision could not be identified.",
    );
    expect(state.skillWorkshopProposals[0]?.revisionHash).toBeNull();
  });

  it("loads the explicitly selected agent even when the last chat belongs to another agent", async () => {
    const { state, context, request } = createFixture(
      {
        skillWorkshopAgentId: "research",
        skillWorkshopLoaded: true,
        skillWorkshopProposals: [proposal()],
      },
      { sessionKey: "agent:research:main", assistantAgentId: "ops" },
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
