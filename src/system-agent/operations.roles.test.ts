import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAgentRole } from "../agents/agent-roles.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { readConfigFileSnapshot, resetConfigRuntimeState } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as agentProvenance from "../state/agent-provenance.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { listSystemAgentAuditEntriesForTests } from "./audit.test-support.js";
import { executeSystemAgentOperation } from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

afterEach(() => vi.restoreAllMocks());

async function withState(run: (root: string, configPath: string) => Promise<void>): Promise<void> {
  await withTestDir({ prefix: "openclaw-custodian-roles-" }, async (root) => {
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
          await fs.writeFile(
            configPath,
            JSON.stringify({
              agents: {
                ownership: "explicit",
                entries: { ambient: { workspace: path.join(root, "ambient") } },
              },
            }),
          );
          await run(root, configPath);
        } finally {
          closeOpenClawAgentDatabasesForTest();
          closeOpenClawStateDatabaseForTest();
          resetConfigRuntimeState();
        }
      },
    );
  });
}

async function readConfig(): Promise<OpenClawConfig> {
  const snapshot = await readConfigFileSnapshot();
  expect(snapshot.valid).toBe(true);
  return snapshot.sourceConfig ?? snapshot.config;
}

describe("custodian role creation through persisted configuration", () => {
  it("seeds the selected role only after approval and tells the operator where to find it", async () => {
    await withState(async (root, configPath) => {
      const workspace = path.join(root, "editor");
      const operation = {
        kind: "create-agent" as const,
        agentId: "editor",
        role: "writer" as const,
        workspace,
      };
      const original = await fs.readFile(configPath, "utf8");
      const { runtime, lines } = createSystemAgentTestRuntime();
      const proposal = await executeSystemAgentOperation(operation, runtime);
      expect(proposal).toMatchObject({
        applied: false,
        message: expect.stringContaining("Writer"),
      });
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      await expect(fs.access(workspace)).rejects.toMatchObject({ code: "ENOENT" });

      const result = await executeSystemAgentOperation(operation, runtime, { approved: true });
      expect(result).toMatchObject({ applied: true, agentId: "editor", bootstrapPending: false });
      const template = await loadAgentRole("writer");
      const config = await readConfig();
      expect(config.agents?.entries?.editor).toMatchObject({
        workspace,
        identity: template.identity,
        subagents: { allowAgents: [] },
      });
      expect(agentProvenance.readAgentProvenance("editor")).toMatchObject({
        createdVia: "agent",
        creatorAgentId: "openclaw",
      });
      for (const [file, content] of Object.entries(template.files)) {
        expect(await fs.readFile(path.join(workspace, file), "utf8")).toBe(content);
      }
      await expect(fs.access(path.join(workspace, "BOOTSTRAP.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const confirmation = lines.join("\n");
      expect(confirmation).toContain("Created agent Writer (editor)");
      expect(confirmation).toContain("Agents home");
      expect(confirmation).toContain("agent switcher");
    });
  });

  it("creates the approved team with directed delegation and separate role workspaces", async () => {
    await withState(async (root, configPath) => {
      const workspaceRoot = path.join(root, "team");
      const operation = {
        kind: "create-team" as const,
        coordinatorId: "lead",
        prefix: "docs",
        workspaceRoot,
      };
      const original = await fs.readFile(configPath, "utf8");
      const { runtime, lines } = createSystemAgentTestRuntime();
      const proposal = await executeSystemAgentOperation(operation, runtime);
      expect(proposal).toMatchObject({
        applied: false,
        message: expect.stringContaining("team of 4: chief of staff, researcher, writer, reviewer"),
      });
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      await expect(fs.access(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });

      const result = await executeSystemAgentOperation(operation, runtime, {
        approved: true,
        requesterAgentId: "planner",
      });
      expect(result).toMatchObject({
        applied: true,
        agentId: "docs-lead",
        bootstrapPending: false,
      });
      const config = await readConfig();
      const members = [
        ["docs-lead", "coordinator"],
        ["docs-researcher", "researcher"],
        ["docs-writer", "writer"],
        ["docs-reviewer", "reviewer"],
      ] as const;
      expect(Object.keys(config.agents?.entries ?? {})).toEqual([
        "ambient",
        ...members.map(([id]) => id),
      ]);
      for (const [id, role] of members) {
        const workspace = path.join(workspaceRoot, id);
        const template = await loadAgentRole(role);
        expect(config.agents?.entries?.[id]).toMatchObject({
          workspace,
          identity: template.identity,
        });
        expect(agentProvenance.readAgentProvenance(id)).toMatchObject({
          createdVia: "agent",
          creatorAgentId: "planner",
        });
        expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe(
          template.files["AGENTS.md"],
        );
        await expect(fs.access(path.join(workspace, "BOOTSTRAP.md"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      expect(config.agents?.entries?.["docs-lead"]?.subagents).toEqual({
        allowAgents: ["docs-researcher", "docs-writer", "docs-reviewer"],
        delegationMode: "prefer",
      });
      expect(config.agents?.defaults?.systemAgent?.agentId).toBe("docs-lead");
      const confirmation = lines.join("\n");
      expect(confirmation).toContain("docs-lead");
      expect(confirmation).toContain("Agents home");
      expect(confirmation).toContain("agent switcher");
    });
  });

  it.each(["unfinished-bootstrap", "authority-revoked", "post-commit-first", "post-commit-later"])(
    "reports and audits retained members after %s blocks the remaining team",
    async (failure) => {
      await withState(async (root) => {
        const workspaceRoot = path.join(root, "team");
        const retainedAgentIds =
          failure === "post-commit-first"
            ? ["coordinator"]
            : failure === "post-commit-later"
              ? ["coordinator", "researcher", "writer"]
              : ["coordinator", "researcher"];
        if (failure === "post-commit-first" || failure === "post-commit-later") {
          const failingAgentId = failure === "post-commit-first" ? "coordinator" : "writer";
          const recordProvenance = agentProvenance.recordAgentProvenance;
          vi.spyOn(agentProvenance, "recordAgentProvenance").mockImplementation((...args) => {
            if (args[0] === failingAgentId) {
              throw new Error("provenance unavailable");
            }
            return recordProvenance(...args);
          });
        }
        if (failure === "unfinished-bootstrap") {
          const unfinished = await ensureAgentWorkspace({
            dir: path.join(workspaceRoot, "writer"),
            ensureBootstrapFiles: true,
          });
          expect(unfinished.bootstrapPending).toBe(true);
        }
        const { runtime, lines } = createSystemAgentTestRuntime();

        const result = await executeSystemAgentOperation(
          { kind: "create-team", workspaceRoot },
          runtime,
          {
            approved: true,
            beforePersistentApply: () => {
              if (
                failure === "authority-revoked" &&
                agentProvenance.readAgentProvenance("researcher")
              ) {
                throw new Error("authority closed");
              }
            },
          },
        );

        expect(result).toMatchObject({ applied: true });
        const config = await readConfig();
        expect(Object.keys(config.agents?.entries ?? {})).toEqual(["ambient", ...retainedAgentIds]);
        const output = lines.join("\n");
        expect(output).toContain("Team creation incomplete");
        for (const id of retainedAgentIds) {
          const workspace = path.join(workspaceRoot, id);
          expect(config.agents?.entries?.[id]?.workspace).toBe(workspace);
          expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe(
            (await loadAgentRole(id)).files["AGENTS.md"],
          );
          expect(output).toContain(id);
        }
        expect(output).toContain(
          failure === "unfinished-bootstrap"
            ? "unfinished bootstrap"
            : failure === "authority-revoked"
              ? "authority closed"
              : "provenance unavailable",
        );
        expect(output).not.toContain("Created team:");
        expect(listSystemAgentAuditEntriesForTests().at(-1)?.value).toMatchObject({
          operation: "agents.createTeam",
          summary: expect.stringContaining("Team creation incomplete"),
          details: { retainedAgentIds },
        });
        await expect(fs.access(path.join(workspaceRoot, "reviewer"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    },
  );
});
