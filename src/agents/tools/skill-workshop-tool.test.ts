// skill_workshop tests cover proposal creation/revision/listing without
// applying generated skills to the workspace.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillWorkshopProposalMutationBudget } from "../../skills/workshop/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createOpenClawTools } from "../openclaw-tools.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
let stateDir = "";

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-workshop-state-",
  });
  stateDir = testState.stateDir;
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

describe("skill_workshop tool", () => {
  it("describes action selection and pending-proposal discovery in its schema", () => {
    const tool = createSkillWorkshopTool({ workspaceDir: "/tmp/openclaw" });
    const schema = JSON.stringify(tool.parameters);

    expect(schema).toContain("create = new skill");
    expect(schema).toContain("update = existing live skill");
    expect(schema).toContain("revise = existing pending proposal");
    expect(schema).toContain("not filesystem search");
    expect(schema).toContain("when proposal_id is unknown");
    expect(schema).toContain("returns candidates");
    expect(schema).toContain("max 160 bytes");
    expect(schema).toContain("shortens the proposal listing entry");
  });

  it("documents that proposal_content must be final skill body content, not a plan or change description", () => {
    const tool = createSkillWorkshopTool({ workspaceDir: "/tmp/openclaw" });
    const schema = JSON.stringify(tool.parameters);
    const proposalOnlySchema = JSON.stringify(
      createSkillWorkshopTool({ workspaceDir: "/tmp/openclaw", proposalOnly: true }).parameters,
    );

    expect(schema).toContain("final skill body");
    expect(schema).toContain("not a plan");
    expect(schema).toContain("change description");
    expect(schema).toContain("preserve all existing content");
    expect(proposalOnlySchema).toContain("preserve all existing content");
    expect(schema).toContain("Proposal frontmatter is added automatically");
  });

  it("is exposed in the OpenClaw tool set", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-");
    const tools = createOpenClawTools({
      workspaceDir,
      config: {},
      disablePluginTools: true,
    });
    expect(tools.some((tool) => tool.name === "skill_workshop")).toBe(true);
  });

  it("stays exposed when autonomous proposal capture is disabled", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-");
    const tools = createOpenClawTools({
      workspaceDir,
      config: {
        skills: {
          workshop: {
            autonomous: {
              enabled: false,
            },
          },
        },
      },
      disablePluginTools: true,
    });
    expect(tools.some((tool) => tool.name === "skill_workshop")).toBe(true);
  });

  it("does not nudge the foreground model when autonomy is enabled", () => {
    const disabled = createSkillWorkshopTool({
      workspaceDir: "/tmp/openclaw",
      config: { skills: { workshop: { autonomous: { enabled: false } } } },
    });
    const enabled = createSkillWorkshopTool({
      workspaceDir: "/tmp/openclaw",
      config: { skills: { workshop: { autonomous: { enabled: true } } } },
    });

    expect(enabled.description).toBe(disabled.description);
    expect(enabled.description).not.toContain("Experience capture");
  });

  it("keeps proposal state inside an injected state directory", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-isolated-workspace-");
    const isolatedStateDir = await tempDirs.make("openclaw-skill-workshop-isolated-state-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: isolatedStateDir };
    const isolatedTool = createSkillWorkshopTool({ workspaceDir, env, proposalOnly: true });

    const created = await isolatedTool.execute("call-isolated-create", {
      action: "create",
      name: "Isolated Learning",
      description: "Keep review proposals in the requested state directory",
      proposal_content: "# Isolated Learning\n\nReuse the isolated workflow.\n",
    });
    const proposalId = (created.details as { id: string }).id;

    await expect(
      fs.access(
        path.join(isolatedStateDir, "skill-workshop", "proposals", proposalId, "PROPOSAL.md"),
      ),
    ).resolves.toBeUndefined();
    await expect(
      isolatedTool.execute("call-isolated-list", { action: "list" }),
    ).resolves.toMatchObject({ details: { proposals: [{ id: proposalId }] } });
    await expect(
      createSkillWorkshopTool({ workspaceDir, proposalOnly: true }).execute("call-default-list", {
        action: "list",
      }),
    ).resolves.toMatchObject({ details: { proposals: [] } });
  });

  it("restricts internal review runs to one pending proposal mutation", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-review-");
    const proposalMutationBudget: SkillWorkshopProposalMutationBudget = { remaining: 1 };
    const tool = createSkillWorkshopTool({
      workspaceDir,
      config: { skills: { workshop: { approvalPolicy: "auto" } } },
      proposalOnly: true,
      proposalMutationBudget,
    });

    expect(
      (tool.parameters as { properties: { action: { enum: string[] } } }).properties.action.enum,
    ).toEqual(["create", "revise", "list", "inspect"]);
    await expect(
      tool.execute("call-apply", { action: "apply", proposal_id: "proposal-1" }),
    ).rejects.toThrow("only inspect or draft proposals");
    await expect(
      tool.execute("call-update", {
        action: "update",
        skill_name: "existing-skill",
        proposal_content: "# Replacement\n",
      }),
    ).rejects.toThrow("only inspect or draft proposals");

    await tool.execute("call-create", {
      action: "create",
      name: "Review Learning",
      description: "Reuse a recovered workflow",
      proposal_content: "# Review Learning\n\nFollow the recovered workflow.\n",
    });
    expect(proposalMutationBudget.completed).toBe(1);
    const retryTool = createSkillWorkshopTool({
      workspaceDir,
      proposalOnly: true,
      proposalMutationBudget,
    });
    await expect(
      retryTool.execute("call-create-2", {
        action: "create",
        name: "Second Learning",
        description: "Should stay blocked",
        proposal_content: "# Second Learning\n",
      }),
    ).rejects.toThrow("reached its proposal mutation limit");
  });

  it("does not refund the review mutation budget after a failed mutation", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-review-failure-");
    const proposalMutationBudget: SkillWorkshopProposalMutationBudget = { remaining: 1 };
    const tool = createSkillWorkshopTool({
      workspaceDir,
      proposalOnly: true,
      proposalMutationBudget,
    });

    await expect(
      tool.execute("call-revise-missing", {
        action: "revise",
        proposal_id: "missing-proposal",
        proposal_content: "# Missing Skill\n",
      }),
    ).rejects.toThrow();
    await expect(
      tool.execute("call-create-after-failure", {
        action: "create",
        name: "Second Mutation",
        description: "Must remain blocked after a failed mutation",
        proposal_content: "# Second Mutation\n",
      }),
    ).rejects.toThrow("reached its proposal mutation limit");
    expect(proposalMutationBudget.completed).toBeUndefined();
    expect(proposalMutationBudget.failedMutations).toBe(1);
  });

  it("durably completes a proposal review and blocks later work", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-review-completion-");
    let completions = 0;
    const progress: Array<{ proposalIds: string[]; remaining: number }> = [];
    let releaseProgress!: () => void;
    const progressGate = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });
    let markProgressStarted!: () => void;
    const progressStarted = new Promise<void>((resolve) => {
      markProgressStarted = resolve;
    });
    const proposalMutationBudget: SkillWorkshopProposalMutationBudget = { remaining: 1 };
    const proposalReviewCompletion = {
      completed: false,
      complete: async () => {
        completions += 1;
      },
      recordProgress: async (next: { proposalIds: string[]; remaining: number }) => {
        progress.push(next);
        markProgressStarted();
        await progressGate;
      },
    };
    const tool = createSkillWorkshopTool({
      workspaceDir,
      proposalOnly: true,
      proposalMutationBudget,
      proposalReviewCompletion,
    });

    expect(
      (tool.parameters as { properties: { action: { enum: string[] } } }).properties.action.enum,
    ).toEqual(["create", "revise", "list", "inspect", "complete"]);
    const create = tool.execute("call-create-before-complete", {
      action: "create",
      name: "Checkpointed Learning",
      description: "Reuse a checkpointed workflow",
      proposal_content: "# Checkpointed Learning\n\nFollow the workflow.\n",
    });
    await progressStarted;
    const complete = tool.execute("call-complete", { action: "complete" });
    await Promise.resolve();
    expect(completions).toBe(0);
    releaseProgress();
    await create;
    await expect(complete).resolves.toMatchObject({ details: { completed: true } });
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ remaining: 0 });
    expect(progress[0]?.proposalIds).toHaveLength(1);
    await expect(
      tool.execute("call-complete-retry", { action: "complete" }),
    ).resolves.toMatchObject({ details: { completed: true } });
    expect(completions).toBe(1);
    await expect(tool.execute("call-list-after-complete", { action: "list" })).rejects.toThrow(
      "review is already completing or complete",
    );
  });

  it("honors a larger internal review mutation budget", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-history-review-");
    const proposalMutationBudget: SkillWorkshopProposalMutationBudget = { remaining: 3 };
    const tool = createSkillWorkshopTool({
      workspaceDir,
      proposalOnly: true,
      proposalMutationBudget,
    });

    for (const index of [1, 2, 3]) {
      await tool.execute(`call-create-${index}`, {
        action: "create",
        name: `Review Learning ${index}`,
        description: `Reusable workflow ${index}`,
        proposal_content: `# Review Learning ${index}\n\nFollow workflow ${index}.\n`,
      });
    }
    expect(proposalMutationBudget.completed).toBe(3);
    await expect(
      tool.execute("call-create-4", {
        action: "create",
        name: "Review Learning 4",
        description: "Must stay bounded",
        proposal_content: "# Review Learning 4\n",
      }),
    ).rejects.toThrow("reached its proposal mutation limit");
  });

  it("counts repeated revisions as one distinct proposal idea", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-distinct-review-");
    const proposalMutationBudget: SkillWorkshopProposalMutationBudget = { remaining: 3 };
    const tool = createSkillWorkshopTool({
      workspaceDir,
      proposalOnly: true,
      proposalMutationBudget,
    });
    const created = await tool.execute("call-create", {
      action: "create",
      name: "One Review Learning",
      description: "One reusable workflow",
      proposal_content: "# One Review Learning\n\nFirst draft.\n",
    });
    const proposalId = (created.details as { id: string }).id;
    for (const version of [2, 3]) {
      await tool.execute(`call-revise-${version}`, {
        action: "revise",
        proposal_id: proposalId,
        proposal_content: `# One Review Learning\n\nDraft ${version}.\n`,
      });
    }

    expect(proposalMutationBudget.completed).toBe(1);
    expect(proposalMutationBudget.successfulMutations).toBe(3);
  });

  it("is not exposed from sandboxed OpenClaw tool sets", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-");
    const tools = createOpenClawTools({
      workspaceDir,
      config: {},
      disablePluginTools: true,
      sandboxed: true,
    });

    expect(tools.some((tool) => tool.name === "skill_workshop")).toBe(false);
  });

  it.each([0, 1.5, "1.5", "25items", "many"])(
    "rejects invalid list limit %s before touching proposal state",
    async (limit) => {
      const workspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-");
      const tool = createSkillWorkshopTool({
        workspaceDir,
        config: {},
        agentId: "main",
      });

      await expect(tool.execute("call-list-limit", { action: "list", limit })).rejects.toThrow(
        "limit must be a positive integer",
      );
      await expect(fs.access(path.join(stateDir, "skill-workshop"))).rejects.toThrow();
    },
  );

  it("preserves list limits through 50 and clamps larger requests", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-");
    const tool = createSkillWorkshopTool({
      workspaceDir,
      config: { skills: { workshop: { maxPending: 200 } } },
      agentId: "main",
    });

    for (let index = 0; index < 51; index += 1) {
      await tool.execute(`call-create-${index}`, {
        action: "create",
        name: `Limit Proposal ${index}`,
        description: `Proposal ${index}`,
        proposal_content: `# Limit Proposal ${index}\n`,
      });
    }

    for (const [limit, expectedCount] of [
      [49, 49],
      [50, 50],
      [51, 50],
    ] as const) {
      const result = await tool.execute(`call-list-${limit}`, { action: "list", limit });
      expect((result.details as { proposals: unknown[] }).proposals).toHaveLength(expectedCount);
    }
  });

  it("creates pending skill proposals without applying them", async () => {
    // Creation writes reviewable proposal artifacts under state, not live skill
    // files in the workspace.
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-");
    const tool = createSkillWorkshopTool({
      workspaceDir,
      config: {},
      agentId: "main",
      origin: {
        agentId: "main",
        sessionKey: "agent:main:dashboard:workshop-test",
        runId: "run-workshop-test",
      },
    });

    const result = await tool.execute("call-1", {
      action: "create",
      name: "Weather Planner",
      description: "Plan around current weather",
      proposal_content: "# Weather Planner\n\nCheck weather before outdoor recommendations.\n",
      support_files: [
        {
          path: "references/weather.md",
          content: "Use weather API details.\n",
        },
      ],
      goal: "Reuse weather planning steps",
    });

    expect(result.details).toMatchObject({
      status: "pending",
      kind: "create",
      skillKey: "weather-planner",
      scanState: "clean",
      supportFileCount: 1,
    });
    expect((result.content[0] as { text: string }).text).toBe(
      `Created skill proposal ${(result.details as { id: string }).id} (pending) for weather-planner.`,
    );
    await expect(
      fs.readFile(
        path.join(
          stateDir,
          "skill-workshop",
          "proposals",
          (result.details as { id: string }).id,
          "PROPOSAL.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("status: proposal");
    await expect(
      fs
        .readFile(
          path.join(
            stateDir,
            "skill-workshop",
            "proposals",
            (result.details as { id: string }).id,
            "PROPOSAL.md",
          ),
        )
        .then((buffer) => buffer.at(-1)),
    ).resolves.toBe(0x0a);
    await expect(
      fs
        .readFile(
          path.join(
            stateDir,
            "skill-workshop",
            "proposals",
            (result.details as { id: string }).id,
            "proposal.json",
          ),
          "utf8",
        )
        .then((raw) => JSON.parse(raw).origin),
    ).resolves.toEqual({
      agentId: "main",
      sessionKey: "agent:main:dashboard:workshop-test",
      runId: "run-workshop-test",
    });
    await expect(
      fs.readFile(
        path.join(
          stateDir,
          "skill-workshop",
          "proposals",
          (result.details as { id: string }).id,
          "references",
          "weather.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("Use weather API details.");
    await expect(
      fs.access(path.join(workspaceDir, "skills", "weather-planner", "SKILL.md")),
    ).rejects.toThrow();

    const reviewerOrigin = {
      agentId: "main",
      sessionKey: "agent:main:skill-workshop-review:review-test",
      runId: "run-review-test",
    };
    const reviewerTool = createSkillWorkshopTool({
      workspaceDir,
      config: {},
      agentId: "main",
      origin: reviewerOrigin,
      proposalOnly: true,
    });
    const revised = await reviewerTool.execute("call-2", {
      action: "revise",
      proposal_id: (result.details as { id: string }).id,
      proposal_content: "# Weather Planner\n\nCheck weather, alerts, and timing.\n",
      support_files: [
        {
          path: "references/weather.md",
          content: "Use weather API details and current alerts.\n",
        },
      ],
      evidence: "User asked for more precise planning.",
    });

    expect(revised.details).toMatchObject({
      id: (result.details as { id: string }).id,
      status: "pending",
      kind: "create",
      skillKey: "weather-planner",
      supportFileCount: 1,
    });
    expect((revised.content[0] as { text: string }).text).toBe(
      `Revised skill proposal ${(result.details as { id: string }).id} (pending) for weather-planner.`,
    );
    await expect(
      fs.readFile(
        path.join(
          stateDir,
          "skill-workshop",
          "proposals",
          (result.details as { id: string }).id,
          "PROPOSAL.md",
        ),
        "utf8",
      ),
    ).resolves.toContain('version: "v2"');
    await expect(
      fs
        .readFile(
          path.join(
            stateDir,
            "skill-workshop",
            "proposals",
            (result.details as { id: string }).id,
            "proposal.json",
          ),
          "utf8",
        )
        .then((raw) => JSON.parse(raw).origin),
    ).resolves.toEqual(reviewerOrigin);

    const listed = await tool.execute("call-3", {
      action: "list",
      status: "pending",
      query: "weather",
    });

    expect((listed.content[0] as { text: string }).text).toContain("weather-planner");
    expect(
      (listed.details as { proposals: Array<{ id: string; skillKey: string }> }).proposals,
    ).toEqual([
      expect.objectContaining({
        id: (result.details as { id: string }).id,
        skillKey: "weather-planner",
      }),
    ]);
    const punctuationOnly = await tool.execute("call-3b", {
      action: "list",
      status: "pending",
      query: "!!!",
    });
    expect((punctuationOnly.content[0] as { text: string }).text).toBe(
      "No skill proposals matched.",
    );
    expect((punctuationOnly.details as { proposals: unknown[] }).proposals).toEqual([]);

    const inspected = await tool.execute("call-4", {
      action: "inspect",
      name: "weather-planner",
    });

    expect((inspected.content[0] as { text: string }).text).toContain(
      "Proposal: " + (result.details as { id: string }).id,
    );
    expect((inspected.details as { proposalContent: string }).proposalContent).toContain(
      "Check weather, alerts, and timing.",
    );
    expect((inspected.content[0] as { text: string }).text).toContain(
      "--- references/weather.md ---",
    );
    expect(
      (
        inspected.details as {
          supportFiles: Array<{ path: string; content: string }>;
        }
      ).supportFiles,
    ).toEqual([
      {
        path: "references/weather.md",
        content: "Use weather API details and current alerts.\n",
      },
    ]);

    const revisedByName = await reviewerTool.execute("call-5", {
      action: "revise",
      name: "weather-planner",
      proposal_content: "# Weather Planner\n\nCheck weather, alerts, timing, and location.\n",
    });

    expect(revisedByName.details).toMatchObject({
      id: (result.details as { id: string }).id,
      proposedVersion: "v3",
      scanState: "clean",
    });
    expect((revisedByName.content[0] as { text: string }).text).toBe(
      `Revised skill proposal ${(result.details as { id: string }).id} (pending) for weather-planner.`,
    );
  });

  it("rejects whitespace-only proposal content while preserving raw valid markdown", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-");
    const tool = createSkillWorkshopTool({
      workspaceDir,
      config: {},
      agentId: "main",
    });

    await expect(
      tool.execute("call-blank", {
        action: "create",
        name: "Blank Proposal",
        description: "Rejected blank content",
        proposal_content: " \n\t\n ",
      }),
    ).rejects.toThrow("proposal_content required");

    const result = await tool.execute("call-valid", {
      action: "create",
      name: "Raw Markdown",
      description: "Valid content keeps trailing newline",
      proposal_content: "# Raw Markdown\n\nKeep this terminal newline.\n",
    });

    await expect(
      fs
        .readFile(
          path.join(
            stateDir,
            "skill-workshop",
            "proposals",
            (result.details as { id: string }).id,
            "PROPOSAL.md",
          ),
        )
        .then((buffer) => buffer.at(-1)),
    ).resolves.toBe(0x0a);
  });

  it("applies, rejects, and quarantines proposals through the workshop service", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-");
    const tool = createSkillWorkshopTool({ workspaceDir, config: {}, agentId: "main" });

    const created = await tool.execute("call-1", {
      action: "create",
      name: "Weather Planner",
      description: "Plan around current weather",
      proposal_content: "# Weather Planner\n\nCheck weather before outdoor recommendations.\n",
      support_files: [
        {
          path: "references/weather.md",
          content: "Use weather API details.\n",
        },
      ],
    });
    const createdId = (created.details as { id: string }).id;

    const applied = await tool.execute("call-2", {
      action: "apply",
      proposal_id: createdId,
      reason: "user approved the proposal",
    });

    expect((applied.content[0] as { text: string }).text).toContain(
      `Applied skill proposal ${createdId}.`,
    );
    expect(applied.details).toMatchObject({
      id: createdId,
      status: "applied",
      kind: "create",
      skillKey: "weather-planner",
      scanState: "clean",
    });
    await expect(
      fs.readFile(path.join(workspaceDir, "skills", "weather-planner", "SKILL.md"), "utf8"),
    ).resolves.toContain("Check weather before outdoor recommendations.");
    await expect(
      fs.readFile(path.join(workspaceDir, "skills", "weather-planner", "SKILL.md"), "utf8"),
    ).resolves.not.toContain("status: proposal");
    await expect(
      fs.readFile(
        path.join(workspaceDir, "skills", "weather-planner", "references", "weather.md"),
        "utf8",
      ),
    ).resolves.toContain("Use weather API details.");

    const update = await tool.execute("call-update", {
      action: "update",
      skill_name: "weather-planner",
      description: "Refresh weather planning steps",
      proposal_content:
        "# Weather Planner\n\n## Steps\n\nCheck weather before outdoor recommendations.\nCheck alerts and timing.\n\n## Tips\n\nPack layers.\n",
    });

    expect((update.content[0] as { text: string }).text).toBe(
      `Created skill update proposal ${(update.details as { id: string }).id} (pending) for weather-planner.`,
    );
    expect(update.details).toMatchObject({
      status: "pending",
      kind: "update",
      skillKey: "weather-planner",
    });

    const revisedUpdate = await tool.execute("call-revise-update", {
      action: "revise",
      proposal_id: (update.details as { id: string }).id,
      proposal_content:
        "# Weather Planner\n\n## Steps\n\nCheck weather before outdoor recommendations.\nCheck alerts, timing, and location.\n\n## Tips\n\nPack layers.\n",
    });
    expect(revisedUpdate.details).toMatchObject({ kind: "update", proposedVersion: "v2" });
    await tool.execute("call-apply-update", {
      action: "apply",
      proposal_id: (revisedUpdate.details as { id: string }).id,
    });
    const revisedSkill = await fs.readFile(
      path.join(workspaceDir, "skills", "weather-planner", "SKILL.md"),
      "utf8",
    );
    expect(revisedSkill).toContain("Check weather before outdoor recommendations.");
    expect(revisedSkill).toContain("Check alerts, timing, and location.");
    expect(revisedSkill).toContain("## Tips\n\nPack layers.");

    const rejected = await tool.execute("call-3", {
      action: "create",
      name: "Rejected Skill",
      description: "Rejected proposal",
      proposal_content: "# Rejected Skill\n\nDo not apply this.\n",
    });
    const rejectedId = (rejected.details as { id: string }).id;
    const rejectResult = await tool.execute("call-4", {
      action: "reject",
      proposal_id: rejectedId,
      reason: "not needed",
    });

    expect((rejectResult.content[0] as { text: string }).text).toContain(
      `Rejected skill proposal ${rejectedId}.`,
    );
    expect(rejectResult.details).toMatchObject({
      id: rejectedId,
      status: "rejected",
      kind: "create",
      skillKey: "rejected-skill",
    });
    await expect(
      fs.access(path.join(workspaceDir, "skills", "rejected-skill", "SKILL.md")),
    ).rejects.toThrow();

    const quarantined = await tool.execute("call-5", {
      action: "create",
      name: "Quarantined Skill",
      description: "Quarantined proposal",
      proposal_content: "# Quarantined Skill\n\nDo not apply this.\n",
    });
    const quarantinedId = (quarantined.details as { id: string }).id;
    const quarantineResult = await tool.execute("call-6", {
      action: "quarantine",
      proposal_id: quarantinedId,
      reason: "unsafe for now",
    });

    expect((quarantineResult.content[0] as { text: string }).text).toContain(
      `Quarantined skill proposal ${quarantinedId}.`,
    );
    expect(quarantineResult.details).toMatchObject({
      id: quarantinedId,
      status: "quarantined",
      kind: "create",
      skillKey: "quarantined-skill",
      scanState: "quarantined",
    });
    await expect(
      fs.access(path.join(workspaceDir, "skills", "quarantined-skill", "SKILL.md")),
    ).rejects.toThrow();
  });

  it("scopes proposal discovery to the tool workspace", async () => {
    const firstWorkspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-first-");
    const secondWorkspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-second-");
    const firstTool = createSkillWorkshopTool({
      workspaceDir: firstWorkspaceDir,
      config: {},
      agentId: "main",
    });
    const secondTool = createSkillWorkshopTool({
      workspaceDir: secondWorkspaceDir,
      config: {},
      agentId: "main",
    });

    const first = await firstTool.execute("call-1", {
      action: "create",
      name: "First Workspace Skill",
      description: "First workspace proposal",
      proposal_content: "# First\n",
    });
    const second = await secondTool.execute("call-2", {
      action: "create",
      name: "Second Workspace Skill",
      description: "Second workspace proposal",
      proposal_content: "# Second\n",
    });

    const listed = await firstTool.execute("call-3", {
      action: "list",
      status: "pending",
    });
    expect(
      (listed.details as { proposals: Array<{ id: string }> }).proposals.map(
        (proposal) => proposal.id,
      ),
    ).toEqual([(first.details as { id: string }).id]);
    await expect(
      firstTool.execute("call-4", {
        action: "inspect",
        proposal_id: (second.details as { id: string }).id,
      }),
    ).rejects.toThrow(`Skill proposal not found: ${(second.details as { id: string }).id}`);
  });
});
