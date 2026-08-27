// skill_workshop tests cover proposal creation/revision/listing without
// applying generated skills to the workspace.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consumeRunSkillUsage, recordRunSkillUsage } from "../../skills/runtime/run-usage.js";
import { writeWorkspaceSkills } from "../../skills/test-support/e2e-test-helpers.js";
import {
  applySkillProposal,
  listSkillProposalEvents,
  proposeCreateSkill,
} from "../../skills/workshop/service.js";
import { SKILL_AUTHORING_STANDARDS_PROMPT } from "../../skills/workshop/skill-authoring-standards.js";
import { readSkillProposalRecord } from "../../skills/workshop/store.js";
import { withSkillCollectionLock } from "../../skills/workshop/target-lock.js";
import type { SkillWorkshopProposalMutationBudget } from "../../skills/workshop/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createOpenClawTools } from "../openclaw-tools.js";
import { listCoreToolSections } from "../tool-catalog.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
let stateDir = "";

async function proposalArtifactPath(
  proposalId: string,
  relativePath: string,
  options: { stateDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const record = await readSkillProposalRecord(proposalId, options.env ? { env: options.env } : {});
  if (!record) {
    throw new Error(`expected stored proposal ${proposalId}`);
  }
  return path.join(
    options.stateDir ?? stateDir,
    "skill-workshop",
    "proposals",
    proposalId,
    path.dirname(record.draftFile),
    relativePath,
  );
}

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
  it("gives an isolated collection review only read and reconcile", async () => {
    const workspaceDir = await fs.realpath(await tempDirs.make("openclaw-skill-collection-tool-"));
    // Drop targets must be Workshop-owned: seed via an applied create proposal, not a raw write.
    const seeded = await proposeCreateSkill({
      workspaceDir,
      env: testState.env,
      name: "duplicate",
      description: "Duplicate procedure",
      content: "# duplicate\n",
    });
    await applySkillProposal({
      workspaceDir,
      env: testState.env,
      proposalId: seeded.record.id,
      expectedRevisionHash: seeded.revisionHash,
    });
    const collectionReconcile = { approvedSkillNames: new Set(["duplicate"]) };
    const tool = createSkillWorkshopTool({
      workspaceDir,
      env: testState.env,
      collectionReconcile,
    });

    expect(JSON.stringify(tool.parameters)).toContain('"enum":["read","reconcile"]');
    expect(JSON.stringify(tool.parameters)).toContain(
      "Only the skills to change; unlisted skills stay. write requires description and complete SKILL.md content; drop requires a reason. Skills not created by Skill Workshop are read-only.",
    );
    expect(JSON.stringify(tool.parameters)).toContain('"enum":["write","drop"]');
    expect(tool.description).toContain(SKILL_AUTHORING_STANDARDS_PROMPT);
    await tool.execute("read", { action: "read", skill_name: "duplicate" });
    await tool.execute("reconcile", {
      action: "reconcile",
      collection: [{ action: "drop", name: "duplicate", reason: "redundant" }],
    });

    expect(collectionReconcile).toMatchObject({
      result: { kept: [], written: [], dropped: [{ name: "duplicate", reason: "redundant" }] },
    });
    await expect(fs.access(path.join(workspaceDir, "skills", "duplicate"))).rejects.toThrow();

    const foregroundTool = createSkillWorkshopTool({ workspaceDir, env: testState.env });
    const restored = await foregroundTool.execute("restore", { action: "restore_collection" });
    expect(restored.details).toMatchObject({ restored: ["duplicate"], removed: [] });
    await expect(
      fs.readFile(path.join(workspaceDir, "skills", "duplicate", "SKILL.md"), "utf8"),
    ).resolves.toContain("Duplicate procedure");
  });

  it("reserves the one reconciliation before awaiting its commit", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-collection-concurrent-tool-");
    await writeWorkspaceSkills(workspaceDir, [{ name: "procedure", description: "Procedure" }]);
    const collectionReconcile = { approvedSkillNames: new Set(["procedure"]) };
    const tool = createSkillWorkshopTool({
      workspaceDir,
      env: testState.env,
      collectionReconcile,
    });
    await tool.execute("read", { action: "read", skill_name: "procedure" });
    let releaseLock: (() => void) | undefined;
    let markAcquired: (() => void) | undefined;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const heldLock = withSkillCollectionLock(
      workspaceDir,
      async () => {
        markAcquired?.();
        await new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
      },
      { env: testState.env },
    );
    await acquired;

    const first = tool.execute("first", {
      action: "reconcile",
      collection: [],
    });
    await expect(
      tool.execute("second", {
        action: "reconcile",
        collection: [{ action: "drop", name: "procedure", reason: "duplicate" }],
      }),
    ).rejects.toThrow("already been reconciled");

    releaseLock?.();
    await heldLock;
    await first;
  });

  it("bounds total collection text returned to the reviewer", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-collection-budget-");
    await writeWorkspaceSkills(workspaceDir, [
      {
        name: "oversized",
        description: "Oversized procedure",
        body: "x".repeat(240_001),
      },
    ]);
    const tool = createSkillWorkshopTool({
      workspaceDir,
      config: { skills: { workshop: { maxSkillBytes: 300_000 } } },
      collectionReconcile: { approvedSkillNames: new Set(["oversized"]) },
    });

    await expect(tool.execute("read", { action: "read", skill_name: "oversized" })).rejects.toThrow(
      "review limit",
    );
  });

  it("keeps reconcile unavailable to ordinary off and propose sessions", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-collection-policy-");
    for (const mode of ["off", "propose"] as const) {
      const tool = createSkillWorkshopTool({
        workspaceDir,
        config: { skills: { workshop: { autonomous: { mode } } } },
      });
      await expect(
        tool.execute("reconcile", { action: "reconcile", collection: [] }),
      ).rejects.toThrow("only an isolated collection review");
    }
  });

  it("describes action selection and pending-proposal discovery in its schema", () => {
    const tool = createSkillWorkshopTool({ workspaceDir: "/tmp/openclaw" });
    const schema = JSON.stringify(tool.parameters);
    const lazyDescription = listCoreToolSections()
      .flatMap((section) => section.tools)
      .find((entry) => entry.id === "skill_workshop")?.description;
    if (!lazyDescription) {
      throw new Error("expected lazy skill_workshop description");
    }

    expect(schema).toContain("create = new skill");
    expect(schema).toContain("patch = targeted");
    expect(schema).toContain("read = existing live skill");
    expect(schema).toContain("update = full-body rewrite");
    expect(schema).toContain("revise = existing pending proposal");
    expect(schema).toContain("evaluate runs plugin evaluators");
    expect(schema).toContain("not filesystem search");
    expect(schema).toContain("when proposal_id is unknown");
    expect(schema).toContain("returns candidates");
    expect(schema).toContain("max 160 bytes");
    expect(schema).toContain("shortens the proposal listing entry");
    expect(schema).toContain("artifact_path");
    expect(tool.description).toContain(lazyDescription);
    expect(tool.description).toContain(SKILL_AUTHORING_STANDARDS_PROMPT);
  });

  it("evaluates an exact pending draft and exposes the persisted result", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-evaluate-");
    const tool = createSkillWorkshopTool({ workspaceDir, agentId: "main" });
    const created = await tool.execute("call-create", {
      action: "create",
      name: "Evaluated Skill",
      description: "Exercise the explicit evaluation primitive",
      proposal_content: "# Evaluated Skill\n",
    });
    const details = created.details as { id: string; revisionHash: string };

    await expect(
      tool.execute("call-evaluate", {
        action: "evaluate",
        proposal_id: details.id,
        expected_revision_hash: details.revisionHash,
        correlation_id: "optimization-run-1",
      }),
    ).resolves.toMatchObject({
      details: {
        id: details.id,
        revisionHash: details.revisionHash,
        evaluation: {
          trigger: "manual",
          correlationId: "optimization-run-1",
          outcomes: [],
        },
      },
    });
    await expect(
      tool.execute("call-inspect", { action: "inspect", proposal_id: details.id }),
    ).resolves.toMatchObject({
      details: {
        evaluation: {
          correlationId: "optimization-run-1",
        },
      },
    });
    expect(
      listSkillProposalEvents({ workspaceDir, proposalId: details.id }).events.map(
        (event) => event.actor,
      ),
    ).toEqual([
      { type: "agent", id: "main" },
      { type: "agent", id: "main" },
    ]);
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
              mode: "off",
            },
          },
        },
      },
      disablePluginTools: true,
    });
    expect(tools.some((tool) => tool.name === "skill_workshop")).toBe(true);
  });

  it("describes the configured foreground repair outcome", () => {
    const disabled = createSkillWorkshopTool({
      workspaceDir: "/tmp/openclaw",
      config: { skills: { workshop: { autonomous: { mode: "off" } } } },
    });
    const enabled = createSkillWorkshopTool({
      workspaceDir: "/tmp/openclaw",
      config: { skills: { workshop: { autonomous: { mode: "propose" } } } },
    });

    expect(disabled.description).toContain("Foreground repair is disabled.");
    expect(enabled.description).toContain("stays pending for review");
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
        await proposalArtifactPath(proposalId, "PROPOSAL.md", {
          stateDir: isolatedStateDir,
          env,
        }),
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

  it("pins the default action enum and blocks work after proposal review completion", async () => {
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
    ).toEqual([
      "create",
      "prepare_patch",
      "patch",
      "update",
      "read",
      "revise",
      "list",
      "inspect",
      "evaluate",
      "apply",
      "reject",
      "quarantine",
      "history",
      "restore_collection",
      "complete",
    ]);
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

  it("revises support files without requiring the proposal body again", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-support-revise-");
    const tool = createSkillWorkshopTool({ workspaceDir, agentId: "main" });
    const created = await tool.execute("call-create", {
      action: "create",
      name: "Support Revision",
      description: "Exercise support-file-only revisions",
      proposal_content: "# Support Revision\n",
      support_files: [{ path: "references/input.txt", content: "before\n" }],
    });
    const details = created.details as { id: string; revisionHash: string };

    await expect(
      tool.execute("call-revise", {
        action: "revise",
        proposal_id: details.id,
        expected_revision_hash: details.revisionHash,
        support_files: [{ path: "references/input.txt", content: "after\n" }],
      }),
    ).resolves.toMatchObject({
      details: {
        id: details.id,
        revisionHash: expect.not.stringMatching(details.revisionHash),
        supportFileCount: 1,
      },
    });

    await expect(
      tool.execute("call-revise-stale", {
        action: "revise",
        proposal_id: details.id,
        expected_revision_hash: details.revisionHash,
        support_files: [{ path: "references/input.txt", content: "stale\n" }],
      }),
    ).rejects.toThrow("proposal revision changed");
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
      proposalFile: "PROPOSAL.md",
      scanState: "clean",
      supportFileCount: 1,
    });
    expect((result.content[0] as { text: string }).text).toBe(
      `Created skill proposal ${(result.details as { id: string }).id} (pending) for weather-planner.`,
    );
    await expect(
      fs.readFile(
        await proposalArtifactPath((result.details as { id: string }).id, "PROPOSAL.md"),
        "utf8",
      ),
    ).resolves.toContain("status: proposal");
    await expect(
      fs
        .readFile(await proposalArtifactPath((result.details as { id: string }).id, "PROPOSAL.md"))
        .then((buffer) => buffer.at(-1)),
    ).resolves.toBe(0x0a);
    await expect(
      readSkillProposalRecord((result.details as { id: string }).id),
    ).resolves.toMatchObject({
      origin: {
        agentId: "main",
        sessionKey: "agent:main:dashboard:workshop-test",
        runId: "run-workshop-test",
      },
    });
    await expect(
      fs.readFile(
        await proposalArtifactPath((result.details as { id: string }).id, "references/weather.md"),
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
        await proposalArtifactPath((result.details as { id: string }).id, "PROPOSAL.md"),
        "utf8",
      ),
    ).resolves.toContain('version: "v2"');
    await expect(
      readSkillProposalRecord((result.details as { id: string }).id),
    ).resolves.toMatchObject({ origin: reviewerOrigin });

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
    expect((inspected.content[0] as { text: string }).text).toContain(
      "Check weather, alerts, and timing.",
    );
    expect((inspected.content[0] as { text: string }).text).toContain("- references/weather.md");
    expect((inspected.content[0] as { text: string }).text).not.toContain(
      "Use weather API details and current alerts.",
    );
    expect(inspected.details).not.toHaveProperty("proposalContent");
    expect(inspected.details).not.toHaveProperty("supportFiles");
    expect(inspected.details).toMatchObject({
      inspect: {
        artifactPath: "PROPOSAL.md",
        availableArtifacts: [
          expect.objectContaining({ path: "PROPOSAL.md" }),
          expect.objectContaining({ path: "references/weather.md" }),
        ],
        contentIncluded: true,
      },
    });

    const inspectedSupport = await tool.execute("call-4-support", {
      action: "inspect",
      proposal_id: (result.details as { id: string }).id,
      artifact_path: "references/weather.md",
    });
    expect((inspectedSupport.content[0] as { text: string }).text).toContain(
      "--- references/weather.md ---\nUse weather API details and current alerts.",
    );

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
        .readFile(await proposalArtifactPath((result.details as { id: string }).id, "PROPOSAL.md"))
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

  it.each(["off", "propose", "auto"] as const)(
    "enforces foreground repair receipts in autonomous mode %s",
    async (mode) => {
      const workspaceDir = await tempDirs.make(`openclaw-skill-workshop-repair-${mode}-`);
      const runId = `repair-${mode}`;
      const skillName = `weather-planner-${mode}`;
      const tool = createSkillWorkshopTool({
        workspaceDir,
        config: { skills: { workshop: { autonomous: { mode } } } },
        agentId: "main",
        origin: { agentId: "main", runId },
      });
      const created = await tool.execute("repair-create", {
        action: "create",
        name: skillName,
        description: "Plan around current weather",
        proposal_content: "# Weather Planner\n\nCheck weather before outdoor recommendations.\n",
      });
      await tool.execute("repair-create-apply", {
        action: "apply",
        proposal_id: (created.details as { id: string }).id,
      });

      await tool.execute("repair-read", { action: "read", skill_name: skillName });

      const patchArgs = {
        action: "patch",
        skill_name: skillName,
        old_string: "Check weather before outdoor recommendations.",
        new_string: "Check weather and alerts before outdoor recommendations.",
      };
      if (mode === "off") {
        await expect(tool.execute("repair-disabled", patchArgs)).rejects.toThrow(
          "disabled by autonomous mode off",
        );
        return;
      }

      await expect(tool.execute("repair-unused", patchArgs)).rejects.toThrow(
        "was not used in this run",
      );
      recordRunSkillUsage({
        runId,
        name: skillName,
        source: "workspace",
        activation: "read",
        skillFile: path.join(workspaceDir, "skills", skillName, "SKILL.md"),
      });
      const patch = await tool.execute("repair-patch", patchArgs);
      expect(patch.details).toMatchObject({
        status: mode === "auto" ? "applied" : "pending",
        kind: "update",
      });

      const skillFile = path.join(workspaceDir, "skills", skillName, "SKILL.md");
      if (mode === "propose") {
        await expect(fs.readFile(skillFile, "utf8")).resolves.toContain(
          "Check weather before outdoor recommendations.",
        );
        await expect(
          tool.execute("repair-apply", {
            action: "apply",
            proposal_id: (patch.details as { id: string }).id,
          }),
        ).resolves.toMatchObject({ details: { status: "applied" } });
        await expect(fs.readFile(skillFile, "utf8")).resolves.toContain(
          "Check weather and alerts before outdoor recommendations.",
        );
      } else {
        await expect(fs.readFile(skillFile, "utf8")).resolves.toContain(
          "Check weather and alerts before outdoor recommendations.",
        );
      }
      consumeRunSkillUsage(runId);
    },
  );

  it("matches an aliased used-skill receipt by canonical file", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-repair-alias-");
    const runId = "repair-alias";
    const skillName = "canonical-skill-key";
    const skillFile = path.join(workspaceDir, "skills", skillName, "SKILL.md");
    const tool = createSkillWorkshopTool({
      workspaceDir,
      config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
      agentId: "main",
      origin: { agentId: "main", runId },
    });
    const created = await tool.execute("alias-create", {
      action: "create",
      name: skillName,
      description: "Exercise canonical receipt identity",
      proposal_content: "# Aliased Skill\n\nUse OLD_TOKEN.\n",
    });
    await tool.execute("alias-create-apply", {
      action: "apply",
      proposal_id: (created.details as { id: string }).id,
    });
    await tool.execute("alias-read", { action: "read", skill_name: skillName });
    recordRunSkillUsage({
      runId,
      name: "frontmatter-skill-name",
      source: "workspace",
      activation: "read",
      skillFile,
    });

    await expect(
      tool.execute("alias-patch", {
        action: "patch",
        skill_name: skillName,
        old_string: "Use OLD_TOKEN.",
        new_string: "Use NEW_TOKEN.",
      }),
    ).resolves.toMatchObject({ details: { status: "applied" } });
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("Use NEW_TOKEN.");
    consumeRunSkillUsage(runId);
  });

  it("keeps proposal discovery scoped to the tool agent across workspace changes", async () => {
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
      (listed.details as { proposals: Array<{ id: string; workspaceMismatch?: true }> }).proposals,
    ).toEqual([
      expect.objectContaining({
        id: (second.details as { id: string }).id,
        workspaceMismatch: true,
      }),
      expect.objectContaining({ id: (first.details as { id: string }).id }),
    ]);
    await expect(
      firstTool.execute("call-4", {
        action: "inspect",
        proposal_id: (second.details as { id: string }).id,
      }),
    ).resolves.toMatchObject({ details: { id: (second.details as { id: string }).id } });
  });
});
