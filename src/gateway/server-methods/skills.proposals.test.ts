/**
 * Tests for skill proposal gateway methods and proposal lifecycle responses.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSkillProposalEvents } from "../../skills/workshop/store-evaluation.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { callGatewayHandler } from "./skills.test-helpers.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
let stateDir = "";

const mocks = vi.hoisted(() => ({
  applySkillProposal: vi.fn(),
  chatSend: vi.fn(),
  evaluateSkillProposal: vi.fn(),
  listSkillProposalEvents: vi.fn(),
  quarantineSkillProposal: vi.fn(),
  rejectSkillProposal: vi.fn(),
  reviseSkillProposal: vi.fn(),
  workspaceDir: "",
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  resetConfigRuntimeState: () => undefined,
  writeConfigFile: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => mocks.workspaceDir,
}));

vi.mock("../../skills/lifecycle/clawhub.js", () => ({
  installSkillFromClawHub: vi.fn(),
  readClawHubSkillsLockfileStatusSync: vi.fn(() => ({ kind: "missing" })),
  readLocalSkillCardContentSync: vi.fn(),
  resolveClawHubSkillStatusLinkSync: vi.fn(),
  resolveLocalSkillCardStatusSync: vi.fn(),
  searchSkillsFromClawHub: vi.fn(),
  updateSkillsFromClawHub: vi.fn(),
}));

vi.mock("../../skills/lifecycle/install.js", () => ({
  installSkill: vi.fn(),
}));

vi.mock("../../skills/lifecycle/upload-install.js", () => ({
  installUploadedSkillArchive: vi.fn(),
}));

vi.mock("../../infra/clawhub-skills.js", () => ({
  CLAWHUB_SKILLS_SH_REF_PREFIX: "skills-sh:",
  fetchClawHubSkillDetail: vi.fn(),
}));

vi.mock("../../skills/security/clawhub-verdicts.js", () => ({
  collectClawHubVerdictTargets: vi.fn(() => []),
  fetchOpenClawSkillSecurityVerdicts: vi.fn(),
}));

vi.mock("../../skills/workshop/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../skills/workshop/service.js")>();
  mocks.applySkillProposal.mockImplementation(actual.applySkillProposal);
  mocks.quarantineSkillProposal.mockImplementation(actual.quarantineSkillProposal);
  mocks.rejectSkillProposal.mockImplementation(actual.rejectSkillProposal);
  mocks.reviseSkillProposal.mockImplementation(actual.reviseSkillProposal);
  return {
    ...actual,
    applySkillProposal: mocks.applySkillProposal,
    evaluateSkillProposal: mocks.evaluateSkillProposal,
    listSkillProposalEvents: mocks.listSkillProposalEvents,
    quarantineSkillProposal: mocks.quarantineSkillProposal,
    rejectSkillProposal: mocks.rejectSkillProposal,
    reviseSkillProposal: mocks.reviseSkillProposal,
  };
});

vi.mock("./chat.js", () => ({
  chatHandlers: {
    "chat.send": mocks.chatSend,
  },
}));

vi.mock("./chat-send-handler.js", () => ({
  handleChatSend: mocks.chatSend,
  handleChatSendWithSkillWorkshopProposalRevision: mocks.chatSend,
}));

const { skillsHandlers } = await import("./skills.js");

function callHandler(method: string, params: Record<string, unknown>) {
  return callGatewayHandler(skillsHandlers, method, params);
}

describe("skills proposal gateway handlers", () => {
  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skills-proposals-gateway-state-",
    });
    mocks.chatSend.mockReset();
    mocks.chatSend.mockImplementation(async ({ respond }) => {
      respond(true, { runId: "run-skill-workshop-revision", status: "started" }, undefined);
    });
    mocks.applySkillProposal.mockClear();
    mocks.evaluateSkillProposal.mockReset();
    const evaluation = {
      id: "evaluation-1",
      proposedVersion: "v1",
      draftHash: "a".repeat(64),
      trigger: "manual",
      startedAt: "2026-05-30T00:01:00.000Z",
      completedAt: "2026-05-30T00:01:01.000Z",
      outcomes: [],
    };
    mocks.evaluateSkillProposal.mockResolvedValue({
      record: {
        id: "proposal-1",
        draftFile: "generations/123e4567-e89b-42d3-a456-426614174000/PROPOSAL.md",
        evaluation,
      },
      evaluation,
    });
    mocks.listSkillProposalEvents.mockReset();
    mocks.listSkillProposalEvents.mockResolvedValue({ events: [], nextSequence: 12 });
    mocks.quarantineSkillProposal.mockClear();
    mocks.rejectSkillProposal.mockClear();
    mocks.reviseSkillProposal.mockClear();
    mocks.workspaceDir = await tempDirs.make("openclaw-skills-proposals-gateway-");
    stateDir = testState.stateDir;
  });

  afterEach(async () => {
    await testState.cleanup();
    await tempDirs.cleanup();
  });

  it("creates, lists, inspects, and applies a proposal", async () => {
    const create = await callHandler("skills.proposals.create", {
      name: "Weather Planner",
      description: "Plan around current weather",
      content: "# Weather Planner\n\nCheck weather before outdoor recommendations.\n",
      supportFiles: [
        {
          path: "references/weather.md",
          content: "Use current weather before recommendations.\n",
        },
      ],
    });
    expect(create.ok).toBe(true);
    const created = create.response as {
      record: { id: string; draftFile: string; supportFiles?: Array<{ path: string }> };
    };
    expect(created.record.id).toMatch(/^weather-planner-/);
    expect(created.record.draftFile).toBe("PROPOSAL.md");
    expect(created.record.supportFiles?.[0]?.path).toBe("references/weather.md");
    expect(
      readSkillProposalEvents({
        workspaceDir: mocks.workspaceDir,
        proposalId: created.record.id,
      }).events[0]?.actor,
    ).toEqual({ type: "gateway" });

    const list = await callHandler("skills.proposals.list", {});
    expect(list.ok).toBe(true);
    expect((list.response as { proposals: Array<{ id: string }> }).proposals[0]?.id).toBe(
      created.record.id,
    );

    const inspect = await callHandler("skills.proposals.inspect", {
      proposalId: created.record.id,
    });
    expect(inspect.ok).toBe(true);
    const reviewedRevisionHash = (inspect.response as { revisionHash: string }).revisionHash;
    expect((inspect.response as { content: string }).content).toContain("status: proposal");
    expect((inspect.response as { record: { draftFile: string } }).record.draftFile).toBe(
      "PROPOSAL.md",
    );
    expect(
      (
        inspect.response as {
          supportFiles?: Array<{ path: string; content: string }>;
        }
      ).supportFiles,
    ).toEqual([
      {
        path: "references/weather.md",
        content: "Use current weather before recommendations.\n",
      },
    ]);

    const revise = await callHandler("skills.proposals.revise", {
      proposalId: created.record.id,
      expectedRevisionHash: reviewedRevisionHash,
      description: "Plan with current weather",
      content: "# Weather Planner\n\nUse current weather and alerts.\n",
    });
    expect(revise.ok).toBe(true);
    const revisedRevisionHash = (revise.response as { revisionHash: string }).revisionHash;
    expect(
      (
        revise.response as {
          record: { id: string; proposedVersion: string; draftFile: string };
        }
      ).record,
    ).toMatchObject({
      id: created.record.id,
      proposedVersion: "v2",
      draftFile: "PROPOSAL.md",
    });

    const apply = await callHandler("skills.proposals.apply", {
      proposalId: created.record.id,
      expectedRevisionHash: revisedRevisionHash,
    });
    expect(apply.ok).toBe(true);
    expect((apply.response as { record: { draftFile: string } }).record.draftFile).toBe(
      "PROPOSAL.md",
    );
    await expect(
      fs.readFile(path.join(mocks.workspaceDir, "skills", "weather-planner", "SKILL.md"), "utf8"),
    ).resolves.toContain("Use current weather and alerts.");
    await expect(
      fs.readFile(
        path.join(mocks.workspaceDir, "skills", "weather-planner", "references", "weather.md"),
        "utf8",
      ),
    ).resolves.toContain("Use current weather");

    const update = await callHandler("skills.proposals.update", {
      skillName: "weather-planner",
      content: "# Weather Planner\n\nUse weather, alerts, and timing.\n",
    });
    expect(update.error).toBeUndefined();
    expect(update.ok).toBe(true);
    expect((update.response as { record: { draftFile: string } }).record.draftFile).toBe(
      "PROPOSAL.md",
    );
  });

  it("returns the stored review outcomes from curator status", async () => {
    openOpenClawStateDatabase({ env: testState.env })
      .db.prepare(
        "INSERT INTO skill_curator_state (id, last_attempt_at_ms, last_success_at_ms, last_error, last_result_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        1,
        100,
        100,
        null,
        JSON.stringify({
          collectionReviews: { workspace: { attemptedAtMs: 100, succeededAtMs: 101 } },
          experienceReviews: { workspace: { attemptedAtMs: 102, outcome: "nothing" } },
        }),
      );

    await expect(callHandler("skills.curator.status", {})).resolves.toMatchObject({
      ok: true,
      response: {
        collectionReview: { workspace: { attemptedAtMs: 100, succeededAtMs: 101 } },
        experienceReview: { workspace: { attemptedAtMs: 102, outcome: "nothing" } },
      },
    });
  });

  it.each(["pin", "unpin", "restore"])(
    "returns an explicit retirement error for the registered curator %s method",
    async (action) => {
      await expect(
        callHandler(`skills.curator.${action}`, { skill: "daily-brief" }),
      ).resolves.toEqual(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({
            code: "INVALID_REQUEST",
            message: expect.stringContaining("Skill lifecycle curation is retired"),
          }),
        }),
      );
    },
  );

  it("marks manually created create targets stale before list and inspect responses", async () => {
    const create = await callHandler("skills.proposals.create", {
      name: "Manual Gateway Skill",
      description: "Installed before its proposal was applied.",
      content: "# Manual Gateway Skill\n",
    });
    expect(create.ok).toBe(true);
    const created = create.response as {
      record: { id: string; target: { skillFile: string } };
    };
    await fs.mkdir(path.dirname(created.record.target.skillFile), { recursive: true });
    await fs.writeFile(
      created.record.target.skillFile,
      "# Manual Gateway Skill\n\nAlready installed.\n",
      "utf8",
    );

    const list = await callHandler("skills.proposals.list", {});
    expect(list.ok).toBe(true);
    expect(
      (list.response as { proposals: Array<{ id: string; status: string }> }).proposals,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.record.id, status: "stale" })]),
    );

    const inspect = await callHandler("skills.proposals.inspect", {
      proposalId: created.record.id,
    });
    expect(inspect.ok).toBe(true);
    expect(
      (inspect.response as { record: { status: string; statusReason?: string } }).record,
    ).toMatchObject({
      status: "stale",
      statusReason: "Target skill was created after proposal creation.",
    });
  });

  it("keeps list and inspect bound to the agent after its workspace changes", async () => {
    const firstWorkspaceDir = mocks.workspaceDir;
    const first = await callHandler("skills.proposals.create", {
      name: "First Gateway Skill",
      description: "First workspace proposal",
      content: "# First\n",
    });
    expect(first.ok).toBe(true);
    const firstCreated = first.response as { record: { id: string } };

    const secondWorkspaceDir = await tempDirs.make("openclaw-skills-proposals-gateway-second-");
    mocks.workspaceDir = secondWorkspaceDir;
    const second = await callHandler("skills.proposals.create", {
      name: "Second Gateway Skill",
      description: "Second workspace proposal",
      content: "# Second\n",
    });
    expect(second.ok).toBe(true);
    const secondCreated = second.response as { record: { id: string } };

    const secondList = await callHandler("skills.proposals.list", {});
    expect(secondList.ok).toBe(true);
    expect(
      (secondList.response as { proposals: Array<{ id: string; workspaceMismatch?: true }> })
        .proposals,
    ).toEqual([
      expect.objectContaining({ id: secondCreated.record.id }),
      expect.objectContaining({ id: firstCreated.record.id, workspaceMismatch: true }),
    ]);

    const oldWorkspaceInspect = await callHandler("skills.proposals.inspect", {
      proposalId: firstCreated.record.id,
    });
    expect(oldWorkspaceInspect.ok).toBe(true);
    expect((oldWorkspaceInspect.response as { record: { id: string } }).record.id).toBe(
      firstCreated.record.id,
    );

    mocks.workspaceDir = firstWorkspaceDir;
    const firstList = await callHandler("skills.proposals.list", {});
    expect(firstList.ok).toBe(true);
    expect((firstList.response as { proposals: Array<{ id: string }> }).proposals).toHaveLength(2);
  });

  it("rejects invalid params before touching workshop state", async () => {
    const result = await callHandler("skills.proposals.create", {
      name: "Missing Content",
      description: "No content",
    });
    expect(result.ok).toBe(false);
    expect((result.error as { code?: string }).code).toBe("INVALID_REQUEST");
    await expect(fs.access(path.join(stateDir, "skill-workshop"))).rejects.toThrow();
  });

  it("passes evaluation and lifecycle replay arguments to the workshop service", async () => {
    const revisionHash = "a".repeat(64);
    const evaluate = await callHandler("skills.proposals.evaluate", {
      proposalId: "proposal-1",
      expectedRevisionHash: revisionHash,
      correlationId: "correlation-1",
    });
    expect(evaluate).toMatchObject({
      ok: true,
      response: {
        record: { draftFile: "PROPOSAL.md" },
        evaluation: { id: "evaluation-1", trigger: "manual" },
      },
    });
    expect(mocks.evaluateSkillProposal).toHaveBeenCalledWith({
      workspaceDir: mocks.workspaceDir,
      agentId: "main",
      eventActor: { type: "gateway" },
      proposalId: "proposal-1",
      expectedRevisionHash: revisionHash,
      correlationId: "correlation-1",
      trigger: "manual",
    });

    const events = await callHandler("skills.proposals.events.list", {
      proposalId: "proposal-1",
      afterSequence: 7,
      limit: 5,
    });
    expect(events).toMatchObject({
      ok: true,
      response: { events: [], nextSequence: 12 },
    });
    expect(mocks.listSkillProposalEvents).toHaveBeenCalledWith({
      workspaceDir: mocks.workspaceDir,
      agentId: "main",
      proposalId: "proposal-1",
      afterSequence: 7,
      limit: 5,
    });
  });

  it("passes expected revision hashes through proposal mutations", async () => {
    const expectedRevisionHash = "e".repeat(64);
    const correlationId = "correlation-mutation-1";
    const record = {
      id: "proposal-1",
      draftFile: "generations/123e4567-e89b-42d3-a456-426614174000/PROPOSAL.md",
      draftHash: "d".repeat(64),
    };
    mocks.reviseSkillProposal.mockResolvedValueOnce({
      record,
      revisionHash: expectedRevisionHash,
      content: "# Revised\n",
    });
    mocks.applySkillProposal.mockResolvedValueOnce({ record, targetSkillFile: "/tmp/SKILL.md" });
    mocks.rejectSkillProposal.mockResolvedValueOnce(record);
    mocks.quarantineSkillProposal.mockResolvedValueOnce(record);

    const revise = await callHandler("skills.proposals.revise", {
      proposalId: "proposal-1",
      expectedRevisionHash,
      correlationId,
      supportFiles: [{ path: "references/example.md", content: "Updated example.\n" }],
    });
    const apply = await callHandler("skills.proposals.apply", {
      proposalId: "proposal-1",
      expectedRevisionHash,
      correlationId,
    });
    const reject = await callHandler("skills.proposals.reject", {
      proposalId: "proposal-1",
      expectedRevisionHash,
      correlationId,
    });
    const quarantine = await callHandler("skills.proposals.quarantine", {
      proposalId: "proposal-1",
      expectedRevisionHash,
      correlationId,
    });

    for (const handler of [
      mocks.reviseSkillProposal,
      mocks.applySkillProposal,
      mocks.rejectSkillProposal,
      mocks.quarantineSkillProposal,
    ]) {
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          eventActor: { type: "gateway" },
          proposalId: "proposal-1",
          expectedRevisionHash,
          correlationId,
        }),
      );
    }
    expect(revise.response).toMatchObject({ record: { draftFile: "PROPOSAL.md" } });
    expect(apply.response).toMatchObject({ record: { draftFile: "PROPOSAL.md" } });
    expect(reject.response).toMatchObject({ draftFile: "PROPOSAL.md" });
    expect(quarantine.response).toMatchObject({ draftFile: "PROPOSAL.md" });
  });

  it.each([
    ["skills.proposals.apply", {}, mocks.applySkillProposal],
    ["skills.proposals.reject", {}, mocks.rejectSkillProposal],
    [
      "skills.proposals.requestRevision",
      {
        instructions: "Tighten the examples.",
        sessionKey: "agent:main:revision",
        idempotencyKey: "revision-missing-hash",
      },
      mocks.chatSend,
    ],
  ] as const)("%s refuses missing reviewed revision evidence", async (method, extra, owner) => {
    const result = await callHandler(method, { proposalId: "proposal-1", ...extra });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: expect.stringContaining("expectedRevisionHash"),
      },
    });
    expect(owner).not.toHaveBeenCalled();
  });

  it.each([
    ["skills.proposals.revise", { description: "Tighter" }, mocks.reviseSkillProposal],
    ["skills.proposals.quarantine", {}, mocks.quarantineSkillProposal],
  ] as const)("%s preserves optional revision evidence", async (method, extra, owner) => {
    owner.mockResolvedValueOnce(
      method.endsWith("revise")
        ? { record: { id: "proposal-1" }, revisionHash: "b".repeat(64), content: "# Revised" }
        : { id: "proposal-1" },
    );

    await callHandler(method, { proposalId: "proposal-1", ...extra });

    expect(owner).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: "proposal-1", expectedRevisionHash: undefined }),
    );
  });

  it("reports empty historical scan coverage and validates scan direction", async () => {
    const status = await callHandler("skills.proposals.historyStatus", {});
    expect(status).toMatchObject({
      ok: true,
      response: {
        schema: "openclaw.skill-workshop.history-scan.v1",
        hasScanned: false,
        reviewedSessions: 0,
        ideasFound: 0,
      },
    });

    const invalid = await callHandler("skills.proposals.historyScan", {
      direction: "all-time",
    });
    expect(invalid.ok).toBe(false);
    expect((invalid.error as { code?: string }).code).toBe("INVALID_REQUEST");
  });

  it("starts revision chat turns with visible instructions and server-built context", async () => {
    const create = await callHandler("skills.proposals.create", {
      name: "Support File Sampler",
      description: "Samples support files",
      content: "# Support File Sampler\n\nSample support files.\n",
    });
    expect(create.ok).toBe(true);
    const created = create.response as { record: { id: string } };
    const inspected = await callHandler("skills.proposals.inspect", {
      proposalId: created.record.id,
    });
    const expectedRevisionHash = (inspected.response as { revisionHash: string }).revisionHash;

    const result = await callHandler("skills.proposals.requestRevision", {
      proposalId: created.record.id,
      expectedRevisionHash,
      instructions: "Make the support files 5",
      sessionKey: "agent:main:session:skill-workshop",
      targetAgentId: "revision-target",
      idempotencyKey: "revision-run-1",
    });

    expect(result).toMatchObject({
      ok: true,
      response: { runId: "run-skill-workshop-revision", status: "started" },
    });
    expect(mocks.chatSend).toHaveBeenCalledTimes(1);
    const forwarded = mocks.chatSend.mock.calls[0]?.[0] as {
      params?: Record<string, unknown>;
      req?: { method?: string; params?: Record<string, unknown> };
    };
    expect(forwarded.req?.method).toBe("chat.send");
    expect(forwarded.params).toMatchObject({
      agentId: "revision-target",
      deliver: false,
      idempotencyKey: "revision-run-1",
      message: "Make the support files 5",
      queueMode: "followup",
      sessionKey: "agent:main:session:skill-workshop",
      suppressCommandInterpretation: true,
    });
    expect(String(forwarded.params?.systemProvenanceReceipt)).toContain(
      `Revise Skill Workshop proposal \`${created.record.id}\` (support-file-sampler).`,
    );
    expect(String(forwarded.params?.systemProvenanceReceipt)).toContain(
      "Use `skill_workshop` with `action=inspect` first, then `action=revise`",
    );
    expect(String(forwarded.params?.systemProvenanceReceipt)).toContain(
      "The proposal ID and expected revision hash are bound by this run",
    );
    expect(String(forwarded.params?.systemProvenanceReceipt)).not.toContain(expectedRevisionHash);
    expect(String(forwarded.params?.systemProvenanceReceipt)).not.toContain(
      "Make the support files 5",
    );
    expect(mocks.chatSend.mock.calls[0]?.[1]).toEqual({
      agentId: "main",
      workspaceDir: mocks.workspaceDir,
      proposalId: created.record.id,
      expectedRevisionHash,
    });
  });

  it("does not start revision chat turns from a stale revision hash", async () => {
    const create = await callHandler("skills.proposals.create", {
      name: "Stale Revision Sampler",
      description: "Rejects stale revision requests",
      content: "# Stale Revision Sampler\n",
    });
    expect(create.ok).toBe(true);
    const created = create.response as { record: { id: string } };
    const inspected = await callHandler("skills.proposals.inspect", {
      proposalId: created.record.id,
    });
    const expectedRevisionHash = (inspected.response as { revisionHash: string }).revisionHash;
    const revised = await callHandler("skills.proposals.revise", {
      proposalId: created.record.id,
      expectedRevisionHash,
      description: "Updated while the operator was reviewing",
    });
    const currentRevisionHash = (revised.response as { revisionHash: string }).revisionHash;

    const result = await callHandler("skills.proposals.requestRevision", {
      proposalId: created.record.id,
      expectedRevisionHash,
      instructions: "Revise this draft",
      sessionKey: "agent:main:session:skill-workshop",
      idempotencyKey: "revision-run-stale",
    });

    expect(result.ok).toBe(false);
    expect((result.error as { message?: string }).message).toContain(
      "Skill proposal revision changed",
    );
    expect((result.error as { details?: unknown }).details).toEqual({
      code: "SKILL_PROPOSAL_REVISION_CHANGED",
      expectedRevisionHash,
      currentRevisionHash,
    });
    expect(mocks.chatSend).not.toHaveBeenCalled();
    await expect(
      callHandler("skills.proposals.inspect", { proposalId: created.record.id }),
    ).resolves.toMatchObject({
      ok: true,
      response: {
        revisionHash: currentRevisionHash,
        record: { status: "pending" },
      },
    });
  });

  it.each(["apply", "reject"])(
    "returns structured stale details without mutating H2 for %s",
    async (action) => {
      const create = await callHandler("skills.proposals.create", {
        name: `Stale ${action} sampler`,
        description: `Rejects a stale ${action} decision`,
        content: `# Stale ${action} sampler\n`,
      });
      const proposalId = (create.response as { record: { id: string } }).record.id;
      const inspected = await callHandler("skills.proposals.inspect", { proposalId });
      const expectedRevisionHash = (inspected.response as { revisionHash: string }).revisionHash;
      const revised = await callHandler("skills.proposals.revise", {
        proposalId,
        expectedRevisionHash,
        description: "Changed after operator review",
      });
      const currentRevisionHash = (revised.response as { revisionHash: string }).revisionHash;

      const result = await callHandler(`skills.proposals.${action}`, {
        proposalId,
        expectedRevisionHash,
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          details: {
            code: "SKILL_PROPOSAL_REVISION_CHANGED",
            expectedRevisionHash,
            currentRevisionHash,
          },
        },
      });
      await expect(callHandler("skills.proposals.inspect", { proposalId })).resolves.toMatchObject({
        ok: true,
        response: { revisionHash: currentRevisionHash, record: { status: "pending" } },
      });
    },
  );

  it("does not start revision chat turns for non-pending proposals", async () => {
    const create = await callHandler("skills.proposals.create", {
      name: "Applied Sampler",
      description: "Already applied proposal",
      content: "# Applied Sampler\n\nSample support files.\n",
    });
    expect(create.ok).toBe(true);
    const created = create.response as { record: { id: string } };
    const inspect = await callHandler("skills.proposals.inspect", {
      proposalId: created.record.id,
    });
    const expectedRevisionHash = (inspect.response as { revisionHash: string }).revisionHash;
    const apply = await callHandler("skills.proposals.apply", {
      proposalId: created.record.id,
      expectedRevisionHash,
    });
    expect(apply.ok).toBe(true);
    mocks.chatSend.mockClear();

    const result = await callHandler("skills.proposals.requestRevision", {
      proposalId: created.record.id,
      expectedRevisionHash,
      instructions: "Make the support files 5",
      sessionKey: "agent:main:session:skill-workshop",
      idempotencyKey: "revision-run-applied",
    });

    expect(result.ok).toBe(false);
    expect((result.error as { message?: string }).message).toContain(
      "Skill proposal is not pending",
    );
    expect(mocks.chatSend).not.toHaveBeenCalled();
  });
});
