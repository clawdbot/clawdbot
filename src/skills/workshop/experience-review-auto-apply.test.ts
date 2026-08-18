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
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { runSkillExperienceReview, type ExperienceReviewCandidate } from "./experience-review.js";
import { inspectSkillProposal, listSkillProposals, proposeCreateSkill } from "./service.js";

const runEmbeddedAgent = vi.hoisted(() => vi.fn());

vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent }));

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
        sessionKey: "agent:main:main",
        workspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
      },
      config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
      transcript: "[user]\nRecover the deployment workflow.",
      modelIterations: 10,
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
        toolsAllow: ["skill_workshop"],
      }),
    );
  });

  it("auto-applies updates to the durable workspace from a session worktree", async () => {
    const canonicalWorkspaceDir = await tempDirs.make("openclaw-experience-canonical-");
    const worktreeWorkspaceDir = await tempDirs.make("openclaw-experience-worktree-");
    const skillDir = path.join(canonicalWorkspaceDir, "skills", "deployment-preflight");
    await writeSkill({
      dir: skillDir,
      name: "deployment-preflight",
      description: "Check deployment prerequisites before retrying.",
      body: "# Deployment Preflight\n\nOperator-authored preflight steps.\n",
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
        sessionKey: "agent:main:main",
        workspaceDir: worktreeWorkspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
      },
      config: {
        agents: { list: [{ id: "main", default: true, workspace: canonicalWorkspaceDir }] },
        skills: { workshop: { autonomous: { mode: "auto" as const } } },
      },
      transcript: "[user]\nRefine the deployment workflow.",
      modelIterations: 10,
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
        sessionKey: "agent:main:main",
        workspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
      },
      config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
      transcript: "[user]\nRefine the deployment workflow.",
      modelIterations: 10,
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
        sessionKey: "agent:main:main",
        workspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
      },
      config: { skills: { workshop: { autonomous: { mode: "propose" } } } },
      transcript: "[user]\nRecover the deployment workflow.",
      modelIterations: 10,
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
        sessionKey: "agent:main:main",
        workspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
      },
      config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
      transcript: "[user]\nRecover the deployment workflow.",
      modelIterations: 10,
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
          sessionKey: "agent:main:main",
          workspaceDir,
          modelProviderId: "openai",
          modelId: "gpt-test",
        },
        config,
        transcript: "[user]\nRecover the deployment workflow.",
        modelIterations: 10,
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
