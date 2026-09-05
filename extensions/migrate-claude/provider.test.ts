// Migrate Claude tests cover provider plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactMigrationPlan } from "openclaw/plugin-sdk/migration";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHomePath } from "./helpers.js";
import { buildMemoryItems } from "./memory.js";
import { buildClaudeMigrationProvider } from "./provider.js";
import { CLAUDE_AUTO_MEMORY_MAX_FILES, type ClaudeSource, discoverClaudeSource } from "./source.js";
import { makeConfigRuntime, makeContext, writeFile } from "./test/provider-helpers.js";

let testWorkspace: TempWorkspace;

function planItemById(
  items: readonly {
    id: string;
    kind?: string;
    action?: string;
    status?: string;
    reason?: string;
    details?: Record<string, unknown>;
  }[],
  id: string,
) {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) {
    throw new Error(`expected migration plan item ${id}`);
  }
  return item;
}

describe("Claude migration provider", () => {
  beforeEach(async () => {
    testWorkspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-migrate-claude-",
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await testWorkspace.cleanup();
  });

  it("registers a Claude migration provider", () => {
    const provider = buildClaudeMigrationProvider();
    expect(provider.id).toBe("claude");
    expect(provider.label).toBe("Claude");
  });

  it.each([
    {
      name: "project CLAUDE.md",
      sourceDir: "project-root",
      sourceFile: "CLAUDE.md",
      itemId: "workspace:CLAUDE.md",
      targetFile: "AGENTS.md",
    },
    {
      name: "project .claude/CLAUDE.md",
      sourceDir: "project-root",
      sourceFile: path.join(".claude", "CLAUDE.md"),
      itemId: "workspace:.claude/CLAUDE.md",
      targetFile: "AGENTS.md",
    },
    {
      name: "user ~/.claude/CLAUDE.md",
      sourceDir: ".claude",
      sourceFile: "CLAUDE.md",
      itemId: "memory:user-CLAUDE.md",
      targetFile: "USER.md",
    },
  ])("keeps repeated $name imports byte-identical", async (testCase) => {
    const root = testWorkspace.dir;
    const source = path.join(root, testCase.sourceDir);
    const sourceFile = path.join(source, testCase.sourceFile);
    const workspaceDir = path.join(root, "workspace");
    const context = makeContext({ source, stateDir: path.join(root, "state"), workspaceDir });
    const provider = buildClaudeMigrationProvider();
    await writeFile(sourceFile, "Version one.\n");

    const firstPlan = await provider.plan(context);
    expect(planItemById(firstPlan.items, testCase.itemId).action).toBe("append");
    const firstResult = await provider.apply(context, firstPlan);
    expect(planItemById(firstResult.items, testCase.itemId).status).toBe("migrated");
    const target = path.join(workspaceDir, testCase.targetFile);
    const firstBytes = await fs.readFile(target, "utf8");

    const secondResult = await provider.apply(context);
    expect(planItemById(secondResult.items, testCase.itemId)).toMatchObject({
      status: "skipped",
      reason: "already imported from Claude",
    });
    expect(await fs.readFile(target, "utf8")).toBe(firstBytes);

    await fs.writeFile(sourceFile, "Version two.\n", "utf8");
    const changedResult = await provider.apply(context);
    expect(planItemById(changedResult.items, testCase.itemId).status).toBe("migrated");
    const changedBytes = await fs.readFile(target, "utf8");
    expect(changedBytes).toContain("Version one.");
    expect(changedBytes).toContain("Version two.");
  });

  it("skips empty instructions without creating a target", async () => {
    const root = testWorkspace.dir;
    const source = path.join(root, "project");
    const workspaceDir = path.join(root, "workspace");
    await writeFile(path.join(source, "CLAUDE.md"), "  \n");
    const provider = buildClaudeMigrationProvider();
    const result = await provider.apply(
      makeContext({ source, stateDir: path.join(root, "state"), workspaceDir }),
    );

    expect(planItemById(result.items, "workspace:CLAUDE.md")).toMatchObject({
      status: "skipped",
      reason: "source file is empty",
    });
    await expect(fs.access(path.join(workspaceDir, "AGENTS.md"))).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "rejects an instruction target replaced by a symlink after planning",
    async () => {
      const root = testWorkspace.dir;
      const source = path.join(root, "project");
      const workspaceDir = path.join(root, "workspace");
      const target = path.join(workspaceDir, "AGENTS.md");
      const linkedTarget = path.join(root, "outside.md");
      await writeFile(path.join(source, "CLAUDE.md"), "Protected instruction.\n");
      await writeFile(target, "Existing instructions.\n");
      const context = makeContext({ source, stateDir: path.join(root, "state"), workspaceDir });
      const provider = buildClaudeMigrationProvider();
      const plan = await provider.plan(context);
      const linkedContent =
        "\n\n<!-- Imported from Claude: project CLAUDE.md -->\n\nProtected instruction.\n";
      await writeFile(linkedTarget, linkedContent);
      await fs.rm(target);
      await fs.symlink(linkedTarget, target);

      const result = await provider.apply(context, plan);

      expect(planItemById(result.items, "workspace:CLAUDE.md").status).toBe("error");
      expect(await fs.readFile(linkedTarget, "utf8")).toBe(linkedContent);
    },
  );

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

  it("keeps literal $ patterns in home when expanding tildes", () => {
    const spy = vi.spyOn(os, "homedir").mockReturnValue("/home/$&user");
    try {
      expect(resolveHomePath("~/.claude")).toBe(path.resolve("/home/$&user/.claude"));
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects missing Claude sources before planning", async () => {
    const root = testWorkspace.dir;
    const source = path.join(root, "missing");
    const provider = buildClaudeMigrationProvider();

    await expect(
      provider.plan(
        makeContext({ source, stateDir: path.join(root, "state"), workspaceDir: root }),
      ),
    ).rejects.toThrow("Claude state was not found");
  });

  it("plans and imports only Claude Code auto-memory into the selected agent", async () => {
    const root = testWorkspace.dir;
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
    const root = testWorkspace.dir;
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
    const root = testWorkspace.dir;
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
    const root = testWorkspace.dir;
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
      const root = testWorkspace.dir;
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
      const root = testWorkspace.dir;
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
      const root = testWorkspace.dir;
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
    const root = testWorkspace.dir;
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
    const root = testWorkspace.dir;
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
    const root = testWorkspace.dir;
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
      const root = testWorkspace.dir;
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
      const root = testWorkspace.dir;
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
    const root = testWorkspace.dir;
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
    const root = testWorkspace.dir;
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
    const root = testWorkspace.dir;
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
    const root = testWorkspace.dir;
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
    const generatedSkillItem = planItemById(result.items, "skill:claude-command-ship");
    expect(generatedSkillItem.details?.backupPath).toBeUndefined();
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

  it("backs up the whole generated skill directory before overwriting it", async () => {
    const root = testWorkspace.dir;
    const source = path.join(root, "project");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const targetDir = path.join(workspaceDir, "skills", "claude-command-ship");
    await writeFile(path.join(source, ".claude", "commands", "ship.md"), "Ship safely.\n");
    const provider = buildClaudeMigrationProvider();
    const context = makeContext({ source, stateDir, workspaceDir, reportDir });
    const plan = await provider.plan(context);
    await writeFile(path.join(targetDir, "SKILL.md"), "# Local skill\n");
    await writeFile(path.join(targetDir, "notes.md"), "Keep these notes.\n");

    const conflict = await provider.apply(context, plan);
    expect(planItemById(conflict.items, "skill:claude-command-ship")).toMatchObject({
      status: "conflict",
      reason: "target exists",
    });
    await expect(fs.readFile(path.join(targetDir, "SKILL.md"), "utf8")).resolves.toBe(
      "# Local skill\n",
    );

    const result = await provider.apply({ ...context, overwrite: true }, plan);

    const item = planItemById(result.items, "skill:claude-command-ship");
    expect(item.status).toBe("migrated");
    expect(await fs.readFile(path.join(targetDir, "SKILL.md"), "utf8")).toContain("Ship safely.");
    await expect(fs.readFile(path.join(targetDir, "notes.md"), "utf8")).resolves.toBe(
      "Keep these notes.\n",
    );
    const backupPath = item.details?.backupPath;
    if (typeof backupPath !== "string") {
      throw new Error("expected generated skill backup path");
    }
    await expect(fs.readFile(path.join(backupPath, "SKILL.md"), "utf8")).resolves.toBe(
      "# Local skill\n",
    );
    await expect(fs.readFile(path.join(backupPath, "notes.md"), "utf8")).resolves.toBe(
      "Keep these notes.\n",
    );
    expect(
      JSON.parse(await fs.readFile(path.join(reportDir, "report.json"), "utf8")).items.find(
        (reportItem: { id?: string }) => reportItem.id === item.id,
      )?.details?.backupPath,
    ).toBe(backupPath);
  });

  it.each([false, true])(
    "reports a removed command source without changing its generated skill (overwrite: %s)",
    async (overwrite) => {
      const root = testWorkspace.dir;
      const source = path.join(root, "project");
      const sourceFile = path.join(source, ".claude", "commands", "ship.md");
      const workspaceDir = path.join(root, "workspace");
      const targetDir = path.join(workspaceDir, "skills", "claude-command-ship");
      const targetFile = path.join(targetDir, "SKILL.md");
      const reportDir = path.join(root, "report");
      await writeFile(sourceFile, "Ship safely.\n");
      if (overwrite) {
        await writeFile(targetFile, "# Local skill\n");
      }
      const provider = buildClaudeMigrationProvider();
      const context = makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir,
        reportDir,
        overwrite,
      });
      const plan = await provider.plan(context);
      await fs.unlink(sourceFile);

      const result = await provider.apply(context, plan);

      const item = planItemById(result.items, "skill:claude-command-ship");
      expect(item).toMatchObject({ status: "error", reason: expect.stringContaining("ENOENT") });
      expect(result.summary).toMatchObject({ migrated: 0, errors: 1 });
      expect(item.details?.backupPath).toBeUndefined();
      if (overwrite) {
        await expect(fs.readFile(targetFile, "utf8")).resolves.toBe("# Local skill\n");
      } else {
        await expect(fs.access(targetDir)).rejects.toThrow();
      }
      const report = JSON.parse(await fs.readFile(path.join(reportDir, "report.json"), "utf8"));
      expect(planItemById(report.items, item.id)).toEqual(item);
      await expect(fs.access(path.join(reportDir, "item-backups"))).rejects.toThrow();
    },
  );

  it("reports the generated skill backup when the overwrite fails", async () => {
    const root = testWorkspace.dir;
    const source = path.join(root, "project");
    const workspaceDir = path.join(root, "workspace");
    const reportDir = path.join(root, "report");
    const targetDir = path.join(workspaceDir, "skills", "claude-command-ship");
    await writeFile(path.join(source, ".claude", "commands", "ship.md"), "Ship safely.\n");
    await writeFile(path.join(targetDir, "SKILL.md", "original.md"), "# Local skill\n");

    const provider = buildClaudeMigrationProvider();
    const result = await provider.apply(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir,
        reportDir,
        overwrite: true,
      }),
    );

    const item = planItemById(result.items, "skill:claude-command-ship");
    expect(item.status).toBe("error");
    const backupPath = item.details?.backupPath;
    if (typeof backupPath !== "string") {
      throw new Error("expected failed generated skill overwrite to report its backup path");
    }
    await expect(
      fs.readFile(path.join(backupPath, "SKILL.md", "original.md"), "utf8"),
    ).resolves.toBe("# Local skill\n");
    expect(
      JSON.parse(await fs.readFile(path.join(reportDir, "report.json"), "utf8")).items.find(
        (reportItem: { id?: string }) => reportItem.id === item.id,
      )?.details?.backupPath,
    ).toBe(backupPath);
  });

  it.runIf(process.platform !== "win32")(
    "materializes symlinked generated skills in the backup before overwriting them",
    async () => {
      for (const scenario of ["target-directory", "skill-file"] as const) {
        const root = path.join(testWorkspace.dir, scenario);
        const source = path.join(root, "project");
        const workspaceDir = path.join(root, "workspace");
        const targetDir = path.join(workspaceDir, "skills", "claude-command-ship");
        const outsideDir = path.join(root, "outside");
        const outsideSkill = path.join(outsideDir, "SKILL.md");
        await writeFile(path.join(source, ".claude", "commands", "ship.md"), "Ship safely.\n");
        await writeFile(outsideSkill, "# Outside skill\n");
        if (scenario === "target-directory") {
          await fs.mkdir(path.dirname(targetDir), { recursive: true });
          await fs.symlink(outsideDir, targetDir);
        } else {
          await fs.mkdir(targetDir, { recursive: true });
          await fs.symlink(outsideSkill, path.join(targetDir, "SKILL.md"));
        }

        const provider = buildClaudeMigrationProvider();
        const result = await provider.apply(
          makeContext({
            source,
            stateDir: path.join(root, "state"),
            workspaceDir,
            reportDir: path.join(root, "report"),
            overwrite: true,
          }),
        );

        const item = planItemById(result.items, "skill:claude-command-ship");
        expect(item.status).toBe("migrated");
        const backupPath = item.details?.backupPath;
        if (typeof backupPath !== "string") {
          throw new Error("expected symlinked generated skill backup path");
        }
        expect((await fs.lstat(backupPath)).isSymbolicLink()).toBe(false);
        expect((await fs.lstat(path.join(backupPath, "SKILL.md"))).isSymbolicLink()).toBe(false);
        await expect(fs.readFile(path.join(backupPath, "SKILL.md"), "utf8")).resolves.toBe(
          "# Outside skill\n",
        );
        await expect(fs.readFile(outsideSkill, "utf8")).resolves.toContain("Ship safely.");
      }
    },
  );
});
