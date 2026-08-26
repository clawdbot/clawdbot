import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithCanonicalSkillWorkspace } from "../../agents/skill-workshop-workspace-context.js";
import { createSkillWorkshopTool } from "../../agents/tools/skill-workshop-tool.js";
import {
  isGatewaySubordinateWorkAdmissionClosed,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { writeWorkspaceSkills } from "../test-support/e2e-test-helpers.js";
import { readSkillReviewOutcomes } from "./collection-review-state.js";
import { runSkillExperienceReview, type ExperienceReviewCandidate } from "./experience-review.js";
import { inspectSkillProposal, listSkillProposals, proposeCreateSkill } from "./service.js";

const runEmbeddedAgent = vi.hoisted(() => vi.fn());

vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent }));
vi.mock("../../agents/run-session-target.js", () => ({
  resolveAgentRunSessionTarget: vi.fn(
    async (params: { agentId?: string; sessionId: string; sessionKey: string }) => ({
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: "/tmp/session-store.json",
    }),
  ),
}));
vi.mock("../../agents/sessions/index.js", () => ({
  SessionManager: {
    open: vi.fn(() => ({ getEntries: () => [] })),
    fromEntries: vi.fn(() => ({})),
  },
}));

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-experience-auto-apply-state-",
  });
});

afterEach(async () => {
  runEmbeddedAgent.mockReset();
  await testState.cleanup();
  await tempDirs.cleanup();
});

describe("experience review auto apply", () => {
  it("applies the isolated reviewer proposal after the reviewer completes", async () => {
    const workspaceDir = await tempDirs.make("openclaw-experience-auto-apply-workspace-");
    runEmbeddedAgent.mockImplementation(async (params) => {
      const tool = createSkillWorkshopTool({
        workspaceDir: params.workspaceDir,
        config: params.config,
        agentId: params.agentId,
        origin: params.skillWorkshopOrigin,
        proposalOnly: params.skillWorkshopProposalOnly,
        autonomousCapture: params.skillWorkshopAutonomousCapture,
        proposalMutationBudget: params.skillWorkshopProposalMutationBudget,
      });
      await tool.execute("review-create", {
        action: "create",
        name: "deployment-preflight",
        description: "Check deployment prerequisites before retrying.",
        proposal_content:
          "# Deployment Preflight\n\nRead the manifest and verify prerequisites before deploy.\n",
      });
      return {};
    });
    const candidate: ExperienceReviewCandidate = {
      ctx: {
        agentId: "main",
        runId: "foreground-run",
        sessionId: "foreground-session",
        sessionKey: "agent:main:main",
        workspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
        reasoningLevel: "on",
      },
      config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
    };

    await runSkillExperienceReview(candidate, {
      getCurrentConfig: () => candidate.config ?? {},
    });

    const manifest = await listSkillProposals({ workspaceDir });
    expect(manifest.proposals).toHaveLength(1);
    expect(manifest.proposals[0]).toMatchObject({
      skillKey: "deployment-preflight",
      status: "applied",
    });
    await expect(
      fs.readFile(`${workspaceDir}/skills/deployment-preflight/SKILL.md`, "utf8"),
    ).resolves.toContain("Read the manifest");
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        skillWorkshopProposalOnly: true,
        skillWorkshopAutonomousCapture: true,
        toolExecutionAllow: ["skill_workshop"],
        sessionPersistence: "detached",
        reasoningLevel: "on",
      }),
    );
    expect(runEmbeddedAgent.mock.calls[0]?.[0]).not.toHaveProperty("disableMessageTool");
    expect(runEmbeddedAgent.mock.calls[0]?.[0]).not.toHaveProperty("cleanupBundleMcpOnRunEnd");
  });

  it("auto-applies updates to the durable workspace from a session worktree", async () => {
    const canonicalWorkspaceDir = await tempDirs.make("openclaw-experience-canonical-");
    const worktreeWorkspaceDir = await tempDirs.make("openclaw-experience-worktree-");
    const skillDir = path.join(canonicalWorkspaceDir, "skills", "deployment-preflight");
    const seedTool = createSkillWorkshopTool({
      workspaceDir: canonicalWorkspaceDir,
      config: { skills: { workshop: { approvalPolicy: "auto" } } },
    });
    const seeded = await seedTool.execute("seed-create", {
      action: "create",
      name: "deployment-preflight",
      description: "Check deployment prerequisites before retrying.",
      proposal_content: "# Deployment Preflight\n\nOperator-authored preflight steps.\n",
    });
    await seedTool.execute("seed-apply", {
      action: "apply",
      proposal_id: (seeded.details as { id: string }).id,
      reason: "seed live skill",
    });
    await fs.cp(skillDir, path.join(worktreeWorkspaceDir, "skills", "deployment-preflight"), {
      recursive: true,
    });

    runEmbeddedAgent.mockImplementation(async (params) => {
      expect(params.skillWorkshopUpdateProposals).toBe(true);
      const tool = createSkillWorkshopTool({
        workspaceDir: params.workspaceDir,
        config: params.config,
        agentId: params.agentId,
        origin: params.skillWorkshopOrigin,
        proposalOnly: params.skillWorkshopProposalOnly,
        updateProposals: params.skillWorkshopUpdateProposals,
        autonomousCapture: params.skillWorkshopAutonomousCapture,
        proposalMutationBudget: params.skillWorkshopProposalMutationBudget,
      });
      await tool.execute("review-read", {
        action: "read",
        skill_name: "deployment-preflight",
      });
      await tool.execute("review-update", {
        action: "update",
        skill_name: "deployment-preflight",
        proposal_content: "# Deployment Preflight\n\nReviewer-rewritten steps.\n",
      });
      return {};
    });
    const candidate: ExperienceReviewCandidate = {
      ctx: {
        agentId: "main",
        runId: "foreground-run",
        sessionId: "foreground-session",
        sessionKey: "agent:main:main",
        workspaceDir: worktreeWorkspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
      },
      config: {
        agents: { list: [{ id: "main", default: true, workspace: canonicalWorkspaceDir }] },
        skills: { workshop: { autonomous: { mode: "auto" as const } } },
      },
    };

    await runWithCanonicalSkillWorkspace(canonicalWorkspaceDir, () =>
      runSkillExperienceReview(candidate, {
        getCurrentConfig: () => candidate.config ?? {},
      }),
    );

    const manifest = await listSkillProposals({
      agentId: "main",
      workspaceDir: canonicalWorkspaceDir,
    });
    const updateEntry = manifest.proposals.find((entry) => entry.kind === "update");
    expect(updateEntry).toMatchObject({
      skillKey: "deployment-preflight",
      status: "applied",
    });
    const inspected = await inspectSkillProposal(updateEntry?.id ?? "", {
      agentId: "main",
      workspaceDir: canonicalWorkspaceDir,
    });
    expect(inspected?.record.target.skillFile).toBe(path.join(skillDir, "SKILL.md"));
    await expect(fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).resolves.toContain(
      "Reviewer-rewritten steps.",
    );
    await expect(
      fs.readFile(
        path.join(worktreeWorkspaceDir, "skills", "deployment-preflight", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("Operator-authored preflight steps.");
  });

  it("leaves updates to user-authored skills pending for operator review", async () => {
    const workspaceDir = await tempDirs.make("openclaw-experience-user-authored-");
    await writeWorkspaceSkills(workspaceDir, [
      {
        name: "deployment-preflight",
        description: "Operator-owned deployment procedure",
        body: "# Deployment Preflight\n\nOperator-authored steps.\n",
      },
    ]);
    runEmbeddedAgent.mockImplementation(async (params) => {
      const tool = createSkillWorkshopTool({
        workspaceDir: params.workspaceDir,
        config: params.config,
        agentId: params.agentId,
        origin: params.skillWorkshopOrigin,
        proposalOnly: params.skillWorkshopProposalOnly,
        updateProposals: params.skillWorkshopUpdateProposals,
        autonomousCapture: params.skillWorkshopAutonomousCapture,
        proposalMutationBudget: params.skillWorkshopProposalMutationBudget,
      });
      await tool.execute("review-read", {
        action: "read",
        skill_name: "deployment-preflight",
      });
      await tool.execute("review-update", {
        action: "update",
        skill_name: "deployment-preflight",
        proposal_content: "# Deployment Preflight\n\nReviewer steps.\n",
      });
      return {};
    });
    const config = { skills: { workshop: { autonomous: { mode: "auto" as const } } } };

    await runSkillExperienceReview(
      {
        ctx: {
          agentId: "main",
          runId: "foreground-run",
          sessionId: "foreground-session",
          sessionKey: "agent:main:main",
          workspaceDir,
          modelProviderId: "openai",
          modelId: "gpt-test",
        },
        config,
      },
      { getCurrentConfig: () => config },
    );

    const pending = (await listSkillProposals({ workspaceDir })).proposals[0];
    expect(pending).toMatchObject({ kind: "update", status: "pending" });
    const inspected = await inspectSkillProposal(pending?.id ?? "", { workspaceDir });
    expect(inspected?.record.statusReason).toBe("user-authored skill; awaiting operator review");
    await expect(
      fs.readFile(`${workspaceDir}/skills/deployment-preflight/SKILL.md`, "utf8"),
    ).resolves.toContain("Operator-authored steps.");
  });

  it("auto-applies reviewer patch proposals composed from the live body", async () => {
    const workspaceDir = await tempDirs.make("openclaw-experience-auto-apply-extend-");
    const seedTool = createSkillWorkshopTool({
      workspaceDir,
      config: { skills: { workshop: { approvalPolicy: "auto" } } },
    });
    const seeded = await seedTool.execute("seed-create", {
      action: "create",
      name: "deployment-preflight",
      description: "Check deployment prerequisites before retrying.",
      proposal_content: "# Deployment Preflight\n\nOperator-authored preflight steps.\n",
    });
    await seedTool.execute("seed-apply", {
      action: "apply",
      proposal_id: (seeded.details as { id: string }).id,
      reason: "seed live skill",
    });

    runEmbeddedAgent.mockImplementation(async (params) => {
      const tool = createSkillWorkshopTool({
        workspaceDir: params.workspaceDir,
        config: params.config,
        agentId: params.agentId,
        origin: params.skillWorkshopOrigin,
        proposalOnly: params.skillWorkshopProposalOnly,
        updateProposals: params.skillWorkshopUpdateProposals,
        autonomousCapture: params.skillWorkshopAutonomousCapture,
        proposalMutationBudget: params.skillWorkshopProposalMutationBudget,
      });
      await tool.execute("review-read", { action: "read", skill_name: "deployment-preflight" });
      await tool.execute("review-patch", {
        action: "patch",
        skill_name: "deployment-preflight",
        old_string: "",
        new_string: "## Learned\n\nCheck alerts and timing before retrying.",
      });
      return {};
    });
    const candidate: ExperienceReviewCandidate = {
      ctx: {
        agentId: "main",
        runId: "foreground-run",
        sessionId: "foreground-session",
        sessionKey: "agent:main:main",
        workspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
      },
      config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
    };

    await runSkillExperienceReview(candidate, {
      getCurrentConfig: () => candidate.config ?? {},
    });

    const manifest = await listSkillProposals({ workspaceDir });
    const updateEntry = manifest.proposals.find((entry) => entry.kind === "update");
    expect(updateEntry).toMatchObject({
      skillKey: "deployment-preflight",
      status: "applied",
    });
    const liveSkill = await fs.readFile(
      `${workspaceDir}/skills/deployment-preflight/SKILL.md`,
      "utf8",
    );
    expect(liveSkill).toContain("Operator-authored preflight steps.");
    expect(liveSkill).toContain("Check alerts and timing before retrying.");
  });

  it("re-enters gateway admission when fired from a released request root", async () => {
    const workspaceDir = await tempDirs.make("openclaw-experience-admission-workspace-");
    let subordinateClosedInsideRun: boolean | undefined;
    runEmbeddedAgent.mockImplementation(async () => {
      subordinateClosedInsideRun = isGatewaySubordinateWorkAdmissionClosed();
      return {};
    });
    const candidate: ExperienceReviewCandidate = {
      ctx: {
        agentId: "main",
        runId: "foreground-run",
        sessionId: "foreground-session",
        sessionKey: "agent:main:main",
        workspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
      },
      config: { skills: { workshop: { autonomous: { mode: "propose" } } } },
    };

    // The scheduler's idle timer inherits the foreground run's root-work ALS
    // context, which is already released when the timer fires. The review must
    // re-enter admission instead of being refused as GatewayDrainingError.
    const admission = tryBeginGatewayRootWorkAdmission();
    expect(admission).not.toBeNull();
    await admission?.run(async () => {
      admission.release();
      await runSkillExperienceReview(candidate, {
        getCurrentConfig: () => candidate.config ?? {},
      });
    });

    expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
    expect(subordinateClosedInsideRun).toBe(false);
  });

  it("leaves the capture pending when auto mode is disabled during review", async () => {
    const workspaceDir = await tempDirs.make("openclaw-experience-mode-change-workspace-");
    runEmbeddedAgent.mockImplementation(async (params) => {
      const tool = createSkillWorkshopTool({
        workspaceDir: params.workspaceDir,
        config: params.config,
        agentId: params.agentId,
        origin: params.skillWorkshopOrigin,
        proposalOnly: params.skillWorkshopProposalOnly,
        autonomousCapture: params.skillWorkshopAutonomousCapture,
        proposalMutationBudget: params.skillWorkshopProposalMutationBudget,
      });
      await tool.execute("review-create", {
        action: "create",
        name: "deployment-preflight",
        description: "Check deployment prerequisites before retrying.",
        proposal_content: "# Deployment Preflight\n\nVerify prerequisites before deploy.\n",
      });
      return {};
    });
    const candidate: ExperienceReviewCandidate = {
      ctx: {
        agentId: "main",
        runId: "foreground-run",
        sessionId: "foreground-session",
        sessionKey: "agent:main:main",
        workspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
      },
      config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
    };

    await runSkillExperienceReview(candidate, {
      getCurrentConfig: () => ({
        skills: { workshop: { autonomous: { mode: "propose" } } },
      }),
    });

    expect((await listSkillProposals({ workspaceDir })).proposals[0]).toMatchObject({
      status: "pending",
    });
  });

  it("records a failed apply and leaves the capture pending without retrying", async () => {
    const workspaceDir = await tempDirs.make("openclaw-experience-apply-failure-workspace-");
    // A file where the skill directory must go makes the live write fail after the proposal exists.
    await fs.mkdir(path.join(workspaceDir, "skills"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "skills", "deployment-preflight"), "blocker");
    runEmbeddedAgent.mockImplementation(async (params) => {
      const tool = createSkillWorkshopTool({
        workspaceDir: params.workspaceDir,
        config: params.config,
        agentId: params.agentId,
        origin: params.skillWorkshopOrigin,
        proposalOnly: params.skillWorkshopProposalOnly,
        autonomousCapture: params.skillWorkshopAutonomousCapture,
        proposalMutationBudget: params.skillWorkshopProposalMutationBudget,
      });
      await tool.execute("review-create", {
        action: "create",
        name: "deployment-preflight",
        description: "Check deployment prerequisites before retrying.",
        proposal_content: "# Deployment Preflight\n\nVerify prerequisites before deploy.\n",
      });
      return {};
    });
    const candidate: ExperienceReviewCandidate = {
      ctx: {
        agentId: "main",
        runId: "foreground-run",
        sessionId: "foreground-session",
        sessionKey: "agent:main:main",
        workspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
      },
      config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
    };

    await expect(
      runSkillExperienceReview(candidate, { getCurrentConfig: () => candidate.config ?? {} }),
    ).rejects.toThrow();

    expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
    expect((await listSkillProposals({ workspaceDir })).proposals[0]).toMatchObject({
      status: "pending",
    });
    expect(Object.values(readSkillReviewOutcomes().experienceReviews)[0]).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("directory"),
    });
  });

  it("does not auto-apply a manual proposal revised by the reviewer", async () => {
    const workspaceDir = await tempDirs.make("openclaw-experience-manual-workspace-");
    const manual = await proposeCreateSkill({
      workspaceDir,
      name: "deployment-preflight",
      description: "Manual deployment proposal.",
      content: "# Deployment Preflight\n\nReview this manually.\n",
      createdBy: "cli",
    });
    runEmbeddedAgent.mockImplementation(async (params) => {
      const tool = createSkillWorkshopTool({
        workspaceDir: params.workspaceDir,
        config: params.config,
        agentId: params.agentId,
        origin: params.skillWorkshopOrigin,
        proposalOnly: params.skillWorkshopProposalOnly,
        autonomousCapture: params.skillWorkshopAutonomousCapture,
        proposalMutationBudget: params.skillWorkshopProposalMutationBudget,
      });
      await tool.execute("review-revise", {
        action: "revise",
        proposal_id: manual.record.id,
        proposal_content: "# Deployment Preflight\n\nKeep this manual revision pending.\n",
      });
      return {};
    });
    const config = { skills: { workshop: { autonomous: { mode: "auto" as const } } } };

    await runSkillExperienceReview(
      {
        ctx: {
          agentId: "main",
          runId: "foreground-run",
          sessionId: "foreground-session",
          sessionKey: "agent:main:main",
          workspaceDir,
          modelProviderId: "openai",
          modelId: "gpt-test",
        },
        config,
      },
      { getCurrentConfig: () => config },
    );

    const inspected = await inspectSkillProposal(manual.record.id, { workspaceDir });
    expect(inspected).toMatchObject({
      record: { status: "pending" },
      content: expect.stringContaining("Keep this manual revision pending"),
    });
    expect(inspected?.record.autonomousCapture).toBeUndefined();
  });
});
