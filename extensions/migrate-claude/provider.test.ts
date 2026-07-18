// Migrate Claude tests cover provider plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactMigrationPlan } from "openclaw/plugin-sdk/migration";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHomePath } from "./helpers.js";
import { buildMemoryItems } from "./memory.js";
import { buildClaudeMigrationProvider } from "./provider.js";
import { CLAUDE_AUTO_MEMORY_MAX_FILES, type ClaudeSource, discoverClaudeSource } from "./source.js";
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
    vi.unstubAllEnvs();
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

  it("plans and imports only Claude Code auto-memory into the selected agent", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, ".claude");
    const defaultWorkspace = path.join(root, "workspace-main");
    const targetWorkspace = path.join(root, "workspace-research");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const memoryDir = path.join(source, "projects", "-tmp-research", "memory");
    await writeFile(path.join(memoryDir, "MEMORY.md"), "# Research memory\n");
    await writeFile(path.join(memoryDir, "topics", "api.md"), "# API facts\n");
    await writeFile(path.join(memoryDir, "ignored.txt"), "not memory\n");
    await writeFile(path.join(source, "CLAUDE.md"), "# Global instructions\n");
    const config = {
      agents: {
        defaults: { workspace: defaultWorkspace },
        list: [
          { id: "main", default: true },
          { id: "research", workspace: targetWorkspace },
        ],
      },
    } as never;
    const context = makeContext({
      source,
      stateDir,
      workspaceDir: defaultWorkspace,
      reportDir,
      config,
      targetAgentId: "research",
      itemKinds: ["memory"],
    });
    const provider = buildClaudeMigrationProvider();

    const plan = await provider.plan(context);

    expect(plan.items).toHaveLength(2);
    expect(plan.items.every((item) => item.kind === "memory")).toBe(true);
    expect(plan.items.some((item) => item.id === "workspace:.claude/CLAUDE.md")).toBe(false);
    expect(plan.items.map((item) => item.details?.relativePath)).toEqual([
      "MEMORY.md",
      "topics/api.md",
    ]);
    expect(plan.items.every((item) => item.target?.startsWith(targetWorkspace))).toBe(true);

    const result = await provider.apply(context, plan);

    expect(result.summary).toMatchObject({ migrated: 2, errors: 0, conflicts: 0 });
    const imported = result.items.find((item) => item.details?.relativePath === "topics/api.md");
    expect(imported?.target).toContain(path.join("memory", "imports", "claude-code"));
    await expect(fs.readFile(imported?.target ?? "", "utf8")).resolves.toBe("# API facts\n");
    await expect(fs.access(path.join(targetWorkspace, "USER.md"))).rejects.toThrow();
  });

  it("discovers a user-configured Claude Code auto-memory directory", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, ".claude");
    const customMemory = path.join(root, "custom-memory");
    await writeFile(
      path.join(source, "settings.json"),
      JSON.stringify({ autoMemoryDirectory: customMemory }),
    );
    await writeFile(path.join(customMemory, "MEMORY.md"), "# Custom memory\n");
    const provider = buildClaudeMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
        itemKinds: ["memory"],
      }),
    );

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.source).toBe(path.join(customMemory, "MEMORY.md"));
  });

  it("honors CLAUDE_CONFIG_DIR for a relocated Claude home", async () => {
    const root = await makeTempRoot();
    const relocatedHome = path.join(root, "relocated-claude");
    const memoryDir = path.join(relocatedHome, "projects", "-tmp-project", "memory");
    await writeFile(path.join(memoryDir, "MEMORY.md"), "# Relocated memory\n");
    vi.stubEnv("CLAUDE_CONFIG_DIR", relocatedHome);

    const source = await discoverClaudeSource();

    expect(source.root).toBe(relocatedHome);
    expect(source.homeDir).toBe(relocatedHome);
    expect(source.autoMemorySources.map((entry) => entry.path)).toEqual([memoryDir]);
  });

  it("treats an explicit repo root with a top-level projects/ dir as a project, not a home", async () => {
    const root = await makeTempRoot();
    const projectRoot = path.join(root, "my-monorepo");
    await writeFile(path.join(projectRoot, "projects", "svc-a", "readme.md"), "# svc\n");
    await writeFile(path.join(projectRoot, "settings.json"), "{}\n");

    const source = await discoverClaudeSource(projectRoot);

    expect(source.projectDir).toBe(projectRoot);
    expect(source.homeDir).toBeUndefined();
  });

  it.runIf(process.platform !== "win32")(
    "reports an unreadable configured Claude Code auto-memory directory",
    async () => {
      const root = await makeTempRoot();
      const source = path.join(root, ".claude");
      const customMemory = path.join(root, "custom-memory");
      await writeFile(
        path.join(source, "settings.json"),
        JSON.stringify({ autoMemoryDirectory: customMemory }),
      );
      await writeFile(path.join(customMemory, "MEMORY.md"), "# Custom memory\n");
      await fs.chmod(customMemory, 0o000);
      const provider = buildClaudeMigrationProvider();

      try {
        await expect(
          provider.plan(
            makeContext({
              source,
              stateDir: path.join(root, "state"),
              workspaceDir: path.join(root, "workspace"),
              itemKinds: ["memory"],
            }),
          ),
        ).rejects.toThrow("Unable to read Claude Code auto-memory directory");
      } finally {
        await fs.chmod(customMemory, 0o700);
      }
    },
  );

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "reports an inaccessible configured Claude Code auto-memory directory",
    async () => {
      const root = await makeTempRoot();
      const source = path.join(root, ".claude");
      const lockedParent = path.join(root, "locked-parent");
      const customMemory = path.join(lockedParent, "custom-memory");
      await writeFile(
        path.join(source, "settings.json"),
        JSON.stringify({ autoMemoryDirectory: customMemory }),
      );
      await writeFile(path.join(customMemory, "MEMORY.md"), "# Custom memory\n");
      await fs.chmod(lockedParent, 0o000);
      const provider = buildClaudeMigrationProvider();

      try {
        await expect(
          provider.plan(
            makeContext({
              source,
              stateDir: path.join(root, "state"),
              workspaceDir: path.join(root, "workspace"),
              itemKinds: ["memory"],
            }),
          ),
        ).rejects.toThrow(customMemory);
      } finally {
        await fs.chmod(lockedParent, 0o700);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "reports an unreadable standard Claude Code projects directory",
    async () => {
      const root = await makeTempRoot();
      const source = path.join(root, ".claude");
      const projects = path.join(source, "projects");
      await fs.mkdir(projects, { recursive: true });
      await fs.chmod(projects, 0o000);
      const provider = buildClaudeMigrationProvider();

      try {
        await expect(
          provider.plan(
            makeContext({
              source,
              stateDir: path.join(root, "state"),
              workspaceDir: path.join(root, "workspace"),
              itemKinds: ["memory"],
            }),
          ),
        ).rejects.toThrow("Unable to read Claude Code projects directory");
      } finally {
        await fs.chmod(projects, 0o700);
      }
    },
  );

  it("rejects relative Claude Code auto-memory settings", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, ".claude");
    await writeFile(
      path.join(source, "settings.json"),
      JSON.stringify({ autoMemoryDirectory: "relative-memory" }),
    );
    const provider = buildClaudeMigrationProvider();

    await expect(
      provider.plan(
        makeContext({
          source,
          stateDir: path.join(root, "state"),
          workspaceDir: path.join(root, "workspace"),
          itemKinds: ["memory"],
        }),
      ),
    ).rejects.toThrow("autoMemoryDirectory must be absolute or start with ~/");
  });

  it('rejects bare "~" as a Claude Code auto-memory directory', async () => {
    const root = await makeTempRoot();
    const source = path.join(root, ".claude");
    await writeFile(
      path.join(source, "settings.json"),
      JSON.stringify({ autoMemoryDirectory: "~" }),
    );
    const provider = buildClaudeMigrationProvider();

    await expect(
      provider.plan(
        makeContext({
          source,
          stateDir: path.join(root, "state"),
          workspaceDir: path.join(root, "workspace"),
          itemKinds: ["memory"],
        }),
      ),
    ).rejects.toThrow("autoMemoryDirectory must be absolute or start with ~/");
  });

  it("rejects Claude Code auto-memory that contains the import destination", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, ".claude");
    const workspaceDir = path.join(root, "workspace");
    const customMemory = path.join(workspaceDir, "memory");
    await writeFile(
      path.join(source, "settings.json"),
      JSON.stringify({ autoMemoryDirectory: customMemory }),
    );
    await writeFile(path.join(customMemory, "MEMORY.md"), "# Existing memory\n");
    const provider = buildClaudeMigrationProvider();

    await expect(
      provider.plan(
        makeContext({
          source,
          stateDir: path.join(root, "state"),
          workspaceDir,
          itemKinds: ["memory"],
        }),
      ),
    ).rejects.toThrow("source and OpenClaw import destination must be separate");
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked import destination that resolves into Claude Code memory",
    async () => {
      const root = await makeTempRoot();
      const source = path.join(root, ".claude");
      const memoryDir = path.join(source, "projects", "-tmp-linked", "memory");
      const workspaceDir = path.join(root, "workspace");
      await writeFile(path.join(memoryDir, "MEMORY.md"), "# Source memory\n");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.symlink(memoryDir, path.join(workspaceDir, "memory"));
      const provider = buildClaudeMigrationProvider();

      await expect(
        provider.plan(
          makeContext({
            source,
            stateDir: path.join(root, "state"),
            workspaceDir,
            itemKinds: ["memory"],
          }),
        ),
      ).rejects.toThrow("destination must stay in the selected workspace");
    },
  );

  it.runIf(process.platform !== "win32")(
    "marks a dangling Claude Code memory destination symlink as a conflict",
    async () => {
      const root = await makeTempRoot();
      const source = path.join(root, ".claude");
      const workspaceDir = path.join(root, "workspace");
      await writeFile(
        path.join(source, "projects", "-tmp-linked", "memory", "MEMORY.md"),
        "# Source memory\n",
      );
      const provider = buildClaudeMigrationProvider();
      const context = makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir,
        itemKinds: ["memory"],
        overwrite: true,
      });
      const initial = await provider.plan(context);
      const target = initial.items[0]?.target;
      if (!target) {
        throw new Error("expected planned Claude memory target");
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(path.join(root, "missing-memory.md"), target);

      const plan = await provider.plan(context);

      expect(plan.items[0]).toMatchObject({
        status: "conflict",
        reason: "target is not a regular file",
      });
    },
  );

  it("fails planning when a discovered Claude Code memory directory cannot be read", async () => {
    const root = await makeTempRoot();
    const missingMemory = path.join(root, "missing-memory");
    await writeFile(missingMemory, "not a directory\n");
    const source: ClaudeSource = {
      root,
      confidence: "medium",
      autoMemorySources: [
        {
          id: "missing",
          label: "missing",
          path: missingMemory,
        },
      ],
      archivePaths: [],
    };

    await expect(
      buildMemoryItems({
        source,
        targets: {
          workspaceDir: path.join(root, "workspace"),
          stateDir: path.join(root, "state"),
          agentDir: path.join(root, "state", "agents", "main", "agent"),
        },
        includeInstructions: false,
      }),
    ).rejects.toThrow("Unable to read Claude Code auto-memory directory");
  });

  it("rejects oversized Claude Code auto-memory instead of returning a partial plan", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, ".claude");
    const memoryDir = path.join(source, "projects", "-tmp-large", "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await Promise.all(
      Array.from({ length: CLAUDE_AUTO_MEMORY_MAX_FILES + 1 }, async (_, index) => {
        await fs.writeFile(path.join(memoryDir, `memory-${index}.md`), "memory\n", "utf8");
      }),
    );
    const provider = buildClaudeMigrationProvider();

    await expect(
      provider.plan(
        makeContext({
          source,
          stateDir: path.join(root, "state"),
          workspaceDir: path.join(root, "workspace"),
          itemKinds: ["memory"],
        }),
      ),
    ).rejects.toThrow("safe import limit of 2000 Markdown files");
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
    const commandDescriptionPrefix = "a".repeat(179);
    await writeFile(
      path.join(source, ".claude", "commands", "ship.md"),
      `${commandDescriptionPrefix}😀tail\n`,
    );
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
    const generatedSkill = await fs.readFile(
      path.join(workspaceDir, "skills", "claude-command-ship", "SKILL.md"),
      "utf8",
    );
    expect(generatedSkill.split("\n").find((line) => line.startsWith("description: "))).toBe(
      `description: ${JSON.stringify(commandDescriptionPrefix)}`,
    );
    await expect(
      fs.access(path.join(workspaceDir, "skills", "review", "SKILL.md")),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(reportDir, "summary.md"))).resolves.toBeUndefined();
  });
});
