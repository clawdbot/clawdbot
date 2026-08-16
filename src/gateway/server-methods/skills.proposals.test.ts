/**
 * Tests for skill proposal gateway methods and proposal lifecycle responses.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSkillProposalEvents } from "../../skills/workshop/store-evaluation.js";
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
  readLocalSkillCardContentSync: vi.fn(),
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
      record: { id: "proposal-1", evaluation },
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
      record: { id: string; supportFiles?: Array<{ path: string }> };
    };
    expect(created.record.id).toMatch(/^weather-planner-/);
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
    expect((inspect.response as { content: string }).content).toContain("status: proposal");
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
      description: "Plan with current weather",
      content: "# Weather Planner\n\nUse current weather and alerts.\n",
    });
    expect(revise.ok).toBe(true);
    expect(
      (revise.response as { record: { id: string; proposedVersion: string } }).record,
    ).toMatchObject({
      id: created.record.id,
      proposedVersion: "v2",
    });

    const apply = await callHandler("skills.proposals.apply", {
      proposalId: created.record.id,
    });
    expect(apply.ok).toBe(true);
    await expect(
      fs.readFile(path.join(mocks.workspaceDir, "skills", "weather-planner", "SKILL.md"), "utf8"),
    ).resolves.toContain("Use current weather and alerts.");
    await expect(
      fs.readFile(
        path.join(mocks.workspaceDir, "skills", "weather-planner", "references", "weather.md"),
        "utf8",
      ),
    ).resolves.toContain("Use current weather");
  });

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
      response: { evaluation: { id: "evaluation-1", trigger: "manual" } },
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
    const record = { id: "proposal-1", draftHash: "d".repeat(64) };
    mocks.reviseSkillProposal.mockResolvedValueOnce({
      record,
      revisionHash: expectedRevisionHash,
      content: "# Revised\n",
    });
    mocks.applySkillProposal.mockResolvedValueOnce({ record, targetSkillFile: "/tmp/SKILL.md" });
    mocks.rejectSkillProposal.mockResolvedValueOnce(record);
    mocks.quarantineSkillProposal.mockResolvedValueOnce(record);

    await callHandler("skills.proposals.revise", {
      proposalId: "proposal-1",
      expectedRevisionHash,
      correlationId,
      supportFiles: [{ path: "references/example.md", content: "Updated example.\n" }],
    });
    await callHandler("skills.proposals.apply", {
      proposalId: "proposal-1",
      expectedRevisionHash,
      correlationId,
    });
    await callHandler("skills.proposals.reject", {
      proposalId: "proposal-1",
      expectedRevisionHash,
      correlationId,
    });
    await callHandler("skills.proposals.quarantine", {
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
      `expected_revision_hash=${expectedRevisionHash}`,
    );
    expect(String(forwarded.params?.systemProvenanceReceipt)).not.toContain(
      "Make the support files 5",
    );
  });

  it("does not start revision chat turns from a stale revision hash", async () => {
    const create = await callHandler("skills.proposals.create", {
      name: "Stale Revision Sampler",
      description: "Rejects stale revision requests",
      content: "# Stale Revision Sampler\n",
    });
    expect(create.ok).toBe(true);
    const created = create.response as { record: { id: string } };

    const result = await callHandler("skills.proposals.requestRevision", {
      proposalId: created.record.id,
      expectedRevisionHash: "f".repeat(64),
      instructions: "Revise this draft",
      sessionKey: "agent:main:session:skill-workshop",
      idempotencyKey: "revision-run-stale",
    });

    expect(result.ok).toBe(false);
    expect((result.error as { message?: string }).message).toContain(
      "Skill proposal revision changed",
    );
    expect(mocks.chatSend).not.toHaveBeenCalled();
  });

  it("does not start revision chat turns for non-pending proposals", async () => {
    const create = await callHandler("skills.proposals.create", {
      name: "Applied Sampler",
      description: "Already applied proposal",
      content: "# Applied Sampler\n\nSample support files.\n",
    });
    expect(create.ok).toBe(true);
    const created = create.response as { record: { id: string } };
    const apply = await callHandler("skills.proposals.apply", {
      proposalId: created.record.id,
    });
    expect(apply.ok).toBe(true);
    mocks.chatSend.mockClear();

    const result = await callHandler("skills.proposals.requestRevision", {
      proposalId: created.record.id,
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
