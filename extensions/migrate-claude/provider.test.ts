import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactMigrationPlan } from "openclaw/plugin-sdk/migration";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHomePath } from "./helpers.js";
import { buildClaudeMigrationProvider } from "./provider.js";
import {
  cleanupTempRoots,
  makeConfigRuntime,
  makeContext,
  makeTempRoot,
  writeFile,
} from "./test/provider-helpers.js";

function planItemById(
  items: readonly { id: string; kind?: string; action?: string }[],
  id: string,
) {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) {
    throw new Error(`expected migration plan item ${id}`);
  }
  return item;
}

describe("Claude migration provider", () => {
  afterEach(async () => {
    await cleanupTempRoots();
  });

  it("registers a Claude migration provider", () => {
    const provider = buildClaudeMigrationProvider();
    expect(provider.id).toBe("claude");
    expect(provider.label).toBe("Claude");
  });

  it("resolves tilde source paths against the OS home when OPENCLAW_HOME is set", () => {
    const previous = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = path.join(path.sep, "tmp", "openclaw-home");
    try {
      expect(resolveHomePath("~/.claude")).toBe(path.join(os.homedir(), ".claude"));
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previous;
      }
    }
  });

  it("rejects missing Claude sources before planning", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "missing");
    const provider = buildClaudeMigrationProvider();

    await expect(
      provider.plan(
        makeContext({ source, stateDir: path.join(root, "state"), workspaceDir: root }),
      ),
    ).rejects.toThrow("Claude state was not found");
  });

  it("plans project memory, MCP servers, commands, skills, and manual review items", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "project");
    const workspaceDir = path.join(root, "workspace");
    await writeFile(path.join(source, "CLAUDE.md"), "# Project instructions\n");
    await writeFile(path.join(source, "CLAUDE.local.md"), "local-only\n");
    await writeFile(
      path.join(source, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            env: { ANTHROPIC_API_KEY: "short-dev-key" },
          },
        },
      }),
    );
    await writeFile(
      path.join(source, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { PreToolUse: [] },
        permissions: { allow: ["Bash(*)"] },
        env: { FOO: "bar" },
      }),
    );
    await writeFile(path.join(source, ".claude", "commands", "commit.md"), "Commit $ARGUMENTS\n");
    await writeFile(path.join(source, ".claude", "skills", "Review", "SKILL.md"), "# Review\n");
    await writeFile(path.join(source, ".claude", "agents", "reviewer.md"), "# Reviewer\n");

    const provider = buildClaudeMigrationProvider();
    const plan = await provider.plan(
      makeContext({ source, stateDir: path.join(root, "state"), workspaceDir }),
    );

    expect(plan.summary.total).toBeGreaterThan(0);
    expect(planItemById(plan.items, "workspace:CLAUDE.md").kind).toBe("workspace");
    expect(planItemById(plan.items, "config:mcp-server:project-mcp:filesystem").kind).toBe(
      "config",
    );
    expect(planItemById(plan.items, "skill:claude-command-commit").action).toBe("create");
    expect(planItemById(plan.items, "skill:review").action).toBe("copy");
    expect(planItemById(plan.items, "archive:CLAUDE.local.md").action).toBe("archive");
    expect(planItemById(plan.items, "archive:project-agents").action).toBe("archive");
    const manualHooksItem = plan.items.find((item) => item.id.startsWith("manual:hooks:"));
    expect(manualHooksItem?.kind).toBe("manual");

    const redacted = JSON.stringify(redactMigrationPlan(plan));
    expect(redacted).not.toContain("short-dev-key");
    expect(redacted).toContain("[redacted]");
  });

  it("applies project imports without reading global Claude state", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "project");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    await writeFile(path.join(source, "CLAUDE.md"), "# Project instructions\n");
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "# Existing agents\n");
    await writeFile(
      path.join(source, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          },
        },
      }),
    );
    await writeFile(path.join(source, ".claude", "commands", "ship.md"), "Ship $ARGUMENTS\n");
    await writeFile(path.join(source, ".claude", "skills", "Review", "SKILL.md"), "# Review\n");

    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
    } as never;
    const provider = buildClaudeMigrationProvider();
    const result = await provider.apply(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        reportDir,
        runtime: makeConfigRuntime(config),
        config,
      }),
    );

    expect(result.summary.errors).toBe(0);
    const mcpItem = result.items.find(
      (item) => item.id === "config:mcp-server:project-mcp:filesystem",
    );
    expect(mcpItem?.status).toBe("migrated");
    expect((config as { mcp?: { servers?: Record<string, unknown> } }).mcp?.servers).toEqual({
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      },
    });
    expect(await fs.readFile(path.join(workspaceDir, "AGENTS.md"), "utf8")).toContain(
      "Imported from Claude: project CLAUDE.md",
    );
    await expect(
      fs.access(path.join(workspaceDir, "skills", "claude-command-ship", "SKILL.md")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(workspaceDir, "skills", "review", "SKILL.md")),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(reportDir, "summary.md"))).resolves.toBeUndefined();
  });
});
