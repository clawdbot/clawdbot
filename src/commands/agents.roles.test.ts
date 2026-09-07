import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentTeam } from "../agents/agent-team.js";
import { loadAgentTemplate } from "../agents/agent-templates.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { readConfigFileSnapshot, resetConfigRuntimeState } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { agentsAddCommand } from "./agents.commands.add.js";
import { agentsTeamCreateCommand } from "./agents.commands.team.js";
import { createCapturingTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-agent-roles-" });

beforeAll(async () => {
  await tempDirs.setup();
});
afterAll(async () => {
  await tempDirs.cleanup();
});

async function withState(run: (root: string, configPath: string) => Promise<void>): Promise<void> {
  const root = await tempDirs.make();
  const configPath = path.join(root, "openclaw.json");
  await withEnvAsync(
    {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: undefined,
      OPENCLAW_HOME: root,
    },
    async () => {
      resetConfigRuntimeState();
      try {
        await run(root, configPath);
      } finally {
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        resetConfigRuntimeState();
      }
    },
  );
}

async function readConfig(): Promise<OpenClawConfig> {
  const snapshot = await readConfigFileSnapshot();
  expect(snapshot.valid).toBe(true);
  return snapshot.sourceConfig ?? snapshot.config;
}

function existingFleet(root: string): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      defaults: { maxConcurrent: 3, subagents: { maxConcurrent: 2 } },
      entries: {
        ambient: { workspace: path.join(root, "ambient") },
        observer: { workspace: path.join(root, "observer") },
      },
    },
    tools: { agentToAgent: { enabled: false } },
  };
}

describe("role and team creation through persisted configuration", () => {
  it("preserves an established implicit main and its routing when adding a team", async () => {
    await withState(async (root, configPath) => {
      const workspace = path.join(root, "existing-workspace");
      const initial = {
        agents: { defaults: { workspace } },
        bindings: [{ agentId: "main", match: { channel: "test-channel" } }],
      };
      await fs.mkdir(workspace);
      await fs.writeFile(path.join(workspace, "AGENTS.md"), "Existing operating program\n");
      await fs.writeFile(configPath, JSON.stringify(initial));
      const result = await createAgentTeam({ workspaceRoot: path.join(root, "team") });
      expect(result).toMatchObject({ status: "created", coordinatorId: "coordinator" });
      const config = await readConfig();
      expect(Object.keys(config.agents?.entries ?? {})).toEqual([
        "main",
        "coordinator",
        "researcher",
        "writer",
        "reviewer",
      ]);
      expect(config.agents?.entries?.main?.workspace).toBe(workspace);
      expect(config.bindings).toEqual(initial.bindings);
      expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe(
        "Existing operating program\n",
      );
    });
  });

  it.each([false, true])("distinguishes implicit main from authored main: %s", async (authored) => {
    await withState(async (_root, configPath) => {
      const original = JSON.stringify({ agents: { entries: { main: {} } } });
      if (authored) {
        await fs.writeFile(configPath, original);
      }
      const result = await createAgentTeam({ coordinator: "main" });
      if (authored) {
        expect(result).toMatchObject({ status: "error", message: expect.stringContaining("main") });
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
      } else {
        expect(result).toMatchObject({ status: "created", coordinatorId: "main" });
        expect(Object.keys((await readConfig()).agents?.entries ?? {})).toEqual([
          "main",
          "researcher",
          "writer",
          "reviewer",
        ]);
      }
    });
  });

  it("adds a role with its workspace program and complete identity without bootstrapping again", async () => {
    await withState(async (root, configPath) => {
      await fs.writeFile(configPath, JSON.stringify(existingFleet(root)));
      const workspace = path.join(root, "editor");
      const { runtime, logs, errors } = createCapturingTestRuntime();
      await agentsAddCommand(
        { name: "Editor", role: "writer", workspace, nonInteractive: true, json: true },
        runtime,
      );
      expect(errors).toEqual([]);
      const summary: unknown = JSON.parse(logs.join("\n"));
      expect(summary).toMatchObject({ agentId: "editor", workspace });
      const template = await loadAgentTemplate("writer");
      for (const file of template.manifest.files) {
        expect(await fs.readFile(path.join(workspace, file), "utf8")).toBe(template.files[file]);
      }
      expect(await fs.readFile(path.join(workspace, "USER.md"), "utf8")).toContain("# USER.md");
      const config = await readConfig();
      expect(config.agents?.entries?.editor?.identity).toEqual(template.manifest.identity);
      expect(config.agents?.entries?.editor?.subagents).toEqual({ allowAgents: [] });
      expect(config.agents?.entries?.editor?.skills).toBeUndefined();
      await expect(fs.access(path.join(workspace, "BOOTSTRAP.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const ensured = await ensureAgentWorkspace({ dir: workspace, ensureBootstrapFiles: true });
      expect(ensured.bootstrapPending).toBe(false);
      await expect(fs.access(path.join(workspace, "BOOTSTRAP.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it.each([false, true])(
    "creates directed teams and preserves defaults with an existing ambient owner: %s",
    async (hasAmbientOwner) => {
      await withState(async (root, configPath) => {
        const initial = existingFleet(root);
        if (hasAmbientOwner && initial.agents?.defaults) {
          initial.agents.defaults.systemAgent = { agentId: " ambient " };
        }
        await fs.writeFile(configPath, JSON.stringify(initial));
        const before = await readConfig();
        const coordinatorId = hasAmbientOwner ? "docs-lead" : "coordinator";
        const specialistIds = ["researcher", "writer", "reviewer"].map((id) =>
          hasAmbientOwner ? `docs-${id}` : id,
        );
        const workspaceRoot = path.join(root, hasAmbientOwner ? "team-workspaces" : "workspace");
        const { runtime, logs } = createCapturingTestRuntime();
        await agentsTeamCreateCommand(
          {
            ...(hasAmbientOwner ? { coordinator: "lead", prefix: "docs", workspaceRoot } : {}),
            nonInteractive: true,
            json: true,
          },
          runtime,
        );
        const summary: unknown = JSON.parse(logs.join("\n"));
        expect(summary).toMatchObject({
          coordinatorId,
          ambientOwnerId: hasAmbientOwner ? "ambient" : coordinatorId,
          agents: [coordinatorId, ...specialistIds].map((agentId) => ({
            agentId,
            workspace: path.join(workspaceRoot, agentId),
          })),
          ...(hasAmbientOwner
            ? { note: "ambient owner stays ambient; talk to the coordinator by name" }
            : {}),
        });
        const config = await readConfig();
        expect(config.agents?.entries?.[coordinatorId]?.subagents).toEqual({
          allowAgents: specialistIds,
          delegationMode: "prefer",
        });
        for (const id of specialistIds) {
          expect(config.agents?.entries?.[id]?.subagents).toEqual({ allowAgents: [] });
        }
        expect(config.agents?.defaults).toEqual({
          ...before.agents?.defaults,
          systemAgent: hasAmbientOwner
            ? before.agents?.defaults?.systemAgent
            : { agentId: coordinatorId },
        });
        expect(config.tools).toEqual(before.tools);
        expect(config.agents?.entries?.ambient).toEqual(before.agents?.entries?.ambient);
        for (const id of [coordinatorId, ...specialistIds]) {
          expect(config.agents?.entries?.[id]?.workspace).toBe(path.join(workspaceRoot, id));
          expect(config.agents?.entries?.[id]?.default).toBeUndefined();
        }
      });
    },
  );

  it("detects a collision on the last specialist before publishing any team config or workspace", async () => {
    await withState(async (root, configPath) => {
      const initial = existingFleet(root);
      if (initial.agents?.entries) {
        initial.agents.entries.Reviewer = { workspace: path.join(root, "existing-reviewer") };
      }
      const original = JSON.stringify(initial);
      await fs.writeFile(configPath, original);
      const workspaceRoot = path.join(root, "team-workspaces");
      const result = await createAgentTeam({ workspaceRoot });
      expect(result).toMatchObject({
        status: "error",
        message: expect.stringContaining("reviewer"),
      });
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      await expect(fs.access(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
