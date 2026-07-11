// skill_workshop tests cover proposal creation/revision/listing without
// applying generated skills to the workspace.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

    const revised = await tool.execute("call-2", {
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

    const revisedByName = await tool.execute("call-5", {
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
      proposal_content: "# Weather Planner\n\nCheck weather, alerts, and timing.\n",
    });

    expect((update.content[0] as { text: string }).text).toBe(
      `Created skill update proposal ${(update.details as { id: string }).id} (pending) for weather-planner.`,
    );
    expect(update.details).toMatchObject({
      status: "pending",
      kind: "update",
      skillKey: "weather-planner",
    });

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
