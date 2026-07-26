import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadExtraBootstrapFilesWithDiagnostics } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExtraBootstrapPatterns } from "../hooks/bundled/bootstrap-extra-files/patterns.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

import { note } from "../../packages/terminal-core/src/note.js";
import {
  collectToolsMdMigrationFindings,
  maybeMigrateToolsMd,
} from "./doctor-tools-md-migration.js";

const noteMock = vi.mocked(note);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const LEGACY_TOOLS_MD_TEMPLATE_FIXTURE =
  [
    "# TOOLS.md - Local Notes",
    "",
    "Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup: camera names and locations, SSH hosts and aliases, preferred TTS voices, speaker/room names, device nicknames, anything environment-specific.",
    "",
    "## Examples",
    "",
    "```markdown",
    "### Cameras",
    "",
    "- living-room → Main area, 180° wide angle",
    "- front-door → Entrance, motion-triggered",
    "",
    "### SSH",
    "",
    "- home-server → 192.168.1.100, user: admin",
    "",
    "### TTS",
    "",
    '- Preferred voice: "Nova" (warm, slightly British)',
    "- Default speaker: Kitchen HomePod",
    "```",
    "",
    "## Why Separate?",
    "",
    "Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.",
    "",
    "---",
    "",
    "Add whatever helps you do your job. This is your cheat sheet.",
    "",
    "## Related",
    "",
    "- [Agent workspace](/concepts/agent-workspace)",
  ].join("\n") + "\n";

afterEach(() => {
  noteMock.mockReset();
});

async function createFixture() {
  const root = await fs.realpath(tempDirs.make("openclaw-tools-md-migration-"));
  const stateDir = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const cfg = {
    agents: { list: [{ id: "main", default: true, workspace }] },
  } as OpenClawConfig;
  return {
    root,
    stateDir,
    workspace,
    cfg,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    agentsPath: path.join(workspace, "AGENTS.md"),
    toolsPath: path.join(workspace, "TOOLS.md"),
  };
}

async function readOnlyArchive(stateDir: string): Promise<Buffer> {
  const archiveDir = path.join(stateDir, "backups", "tools-md-migration");
  const archives = await fs.readdir(archiveDir);
  expect(archives).toHaveLength(1);
  return fs.readFile(path.join(archiveDir, archives[0]!));
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

function configureExtraBootstrapPatterns(
  cfg: OpenClawConfig,
  key: "paths" | "patterns" | "files",
  patterns: string[],
): void {
  cfg.hooks = {
    internal: {
      entries: {
        "bootstrap-extra-files": {
          enabled: true,
          [key]: patterns,
        },
      },
    },
  };
}

describe("TOOLS.md migration", () => {
  it("previews the migration without mutating or archiving workspace files", async () => {
    const fixture = await createFixture();
    const agents = "# Agent\n\n## Tools\n\nExisting notes.\n";
    const tools = "### Cameras\n\n- kitchen → wide angle\n";
    await fs.writeFile(fixture.agentsPath, agents);
    await fs.writeFile(fixture.toolsPath, tools);

    await expect(collectToolsMdMigrationFindings(fixture.cfg)).resolves.toEqual([
      expect.objectContaining({
        checkId: "core/doctor/tools-md-migration",
        requirement: "legacy-tools-md",
      }),
    ]);

    await expect(
      maybeMigrateToolsMd({
        cfg: fixture.cfg,
        shouldRepair: false,
        env: fixture.env,
      }),
    ).resolves.toEqual({ changes: [], warnings: [] });

    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(agents);
    await expect(fs.readFile(fixture.toolsPath, "utf8")).resolves.toBe(tools);
    await expectMissing(fixture.stateDir);
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("will be archived and merged into AGENTS.md when customized"),
      "TOOLS.md migration preview",
    );
  });

  it("appends customized content verbatim under the existing Tools section and is idempotent", async () => {
    const fixture = await createFixture();
    const agents = "# Agent\n\n## Tools\n\nExisting notes.\n\n## Safety\n\nBe careful.\n";
    const tools = "### Cameras\n\n- kitchen → wide angle\n\nKeep trailing spaces.  \n";
    const expected =
      "# Agent\n\n## Tools\n\nExisting notes.\n\n" +
      "### Local notes (migrated from TOOLS.md)\n\n" +
      tools +
      "\n## Safety\n\nBe careful.\n";
    await fs.writeFile(fixture.agentsPath, agents);
    await fs.writeFile(fixture.toolsPath, tools);

    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(expected);
    await expect(readOnlyArchive(fixture.stateDir)).resolves.toEqual(Buffer.from(tools));
    await expectMissing(fixture.toolsPath);

    await expect(
      maybeMigrateToolsMd({
        cfg: fixture.cfg,
        shouldRepair: true,
        env: fixture.env,
      }),
    ).resolves.toEqual({ changes: [], warnings: [] });
    const rerunAgents = await fs.readFile(fixture.agentsPath, "utf8");
    expect(rerunAgents).toBe(expected);
    expect(rerunAgents.match(/migrated from TOOLS\.md/gu)).toHaveLength(1);
  });

  it("migrates every configured nested TOOLS.md beside its sibling AGENTS.md", async () => {
    const fixture = await createFixture();
    configureExtraBootstrapPatterns(fixture.cfg, "paths", [
      "packages/*/AGENTS.md",
      "packages/*/TOOLS.md",
    ]);
    const customizedDir = path.join(fixture.workspace, "packages", "customized");
    const createdDir = path.join(fixture.workspace, "packages", "created");
    const untouchedDir = path.join(fixture.workspace, "packages", "untouched");
    const emptyDir = path.join(fixture.workspace, "packages", "empty");
    await Promise.all(
      [customizedDir, createdDir, untouchedDir, emptyDir].map((dir) =>
        fs.mkdir(dir, { recursive: true }),
      ),
    );
    await fs.writeFile(
      path.join(customizedDir, "AGENTS.md"),
      "# Package\n\n## Tools\n\nExisting.\n",
    );
    await fs.writeFile(path.join(customizedDir, "TOOLS.md"), "### deploy\n\nUse staging.\n");
    await fs.writeFile(path.join(createdDir, "TOOLS.md"), "### inspect\n\nRead only.\n");
    await fs.writeFile(path.join(untouchedDir, "AGENTS.md"), "# Untouched\n");
    await fs.writeFile(path.join(untouchedDir, "TOOLS.md"), LEGACY_TOOLS_MD_TEMPLATE_FIXTURE);
    await fs.writeFile(path.join(emptyDir, "TOOLS.md"), "");

    const findings = await collectToolsMdMigrationFindings(fixture.cfg);
    expect(findings).toHaveLength(4);
    expect(findings.map((finding) => finding.path)).toEqual(
      expect.arrayContaining([
        path.join(customizedDir, "TOOLS.md"),
        path.join(createdDir, "TOOLS.md"),
        path.join(untouchedDir, "TOOLS.md"),
        path.join(emptyDir, "TOOLS.md"),
      ]),
    );

    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(4);
    await expect(fs.readFile(path.join(customizedDir, "AGENTS.md"), "utf8")).resolves.toBe(
      "# Package\n\n## Tools\n\nExisting.\n\n" +
        "### Local notes (migrated from TOOLS.md)\n\n" +
        "### deploy\n\nUse staging.\n",
    );
    await expect(fs.readFile(path.join(createdDir, "AGENTS.md"), "utf8")).resolves.toBe(
      "## Tools\n\n### Local notes (migrated from TOOLS.md)\n\n### inspect\n\nRead only.\n",
    );
    await expect(fs.readFile(path.join(untouchedDir, "AGENTS.md"), "utf8")).resolves.toBe(
      "# Untouched\n",
    );
    await expectMissing(path.join(emptyDir, "AGENTS.md"));
    await Promise.all(
      [customizedDir, createdDir, untouchedDir, emptyDir].map((dir) =>
        expectMissing(path.join(dir, "TOOLS.md")),
      ),
    );
    await expect(
      fs.readdir(path.join(fixture.stateDir, "backups", "tools-md-migration")),
    ).resolves.toHaveLength(4);
    await expect(
      maybeMigrateToolsMd({ cfg: fixture.cfg, shouldRepair: true, env: fixture.env }),
    ).resolves.toEqual({ changes: [], warnings: [] });
  });

  it.each(["patterns", "files"] as const)(
    "discovers nested TOOLS.md through the %s alias",
    async (key) => {
      const fixture = await createFixture();
      configureExtraBootstrapPatterns(fixture.cfg, key, ["packages/*/TOOLS.md"]);
      const packageDir = path.join(fixture.workspace, "packages", key);
      await fs.mkdir(packageDir, { recursive: true });
      await fs.writeFile(path.join(packageDir, "TOOLS.md"), `Notes from ${key}.\n`);

      await expect(collectToolsMdMigrationFindings(fixture.cfg)).resolves.toEqual([
        expect.objectContaining({ path: path.join(packageDir, "TOOLS.md") }),
      ]);
      const result = await maybeMigrateToolsMd({
        cfg: fixture.cfg,
        shouldRepair: true,
        env: fixture.env,
      });
      expect(result.warnings).toEqual([]);
      const hookConfig = fixture.cfg.hooks?.internal?.entries?.["bootstrap-extra-files"];
      expect(hookConfig?.[key]).toEqual(["packages/*/TOOLS.md", "packages/*/AGENTS.md"]);
    },
  );

  it("adds the sibling AGENTS.md pattern after migrating a TOOLS-only configuration", async () => {
    const fixture = await createFixture();
    configureExtraBootstrapPatterns(fixture.cfg, "paths", ["packages/*/TOOLS.md"]);
    const packageDir = path.join(fixture.workspace, "packages", "tools-only");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "TOOLS.md"), "Reachable after migration.\n");

    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(2);
    const hookConfig = fixture.cfg.hooks?.internal?.entries?.["bootstrap-extra-files"];
    expect(hookConfig?.paths).toEqual(["packages/*/TOOLS.md", "packages/*/AGENTS.md"]);
    const patterns = resolveExtraBootstrapPatterns(hookConfig as Record<string, unknown>);
    const loaded = await loadExtraBootstrapFilesWithDiagnostics(fixture.workspace, patterns);
    expect(loaded.files).toEqual([
      expect.objectContaining({
        name: "AGENTS.md",
        path: path.join(packageDir, "AGENTS.md"),
        content: expect.stringContaining("Reachable after migration."),
      }),
    ]);
  });

  it("stops the workspace migration when a configured path escapes the workspace", async () => {
    const fixture = await createFixture();
    const rootTools = "Root notes stay put.\n";
    const outsideDir = path.join(fixture.root, "outside");
    await fs.mkdir(outsideDir);
    await fs.writeFile(fixture.toolsPath, rootTools);
    await fs.writeFile(path.join(outsideDir, "TOOLS.md"), "Outside notes.\n");
    configureExtraBootstrapPatterns(fixture.cfg, "paths", ["../outside/TOOLS.md"]);

    await expect(collectToolsMdMigrationFindings(fixture.cfg)).resolves.toEqual([
      expect.objectContaining({
        severity: "error",
        requirement: "tools-md-migration-blocked",
        message: expect.stringContaining("could not be read safely"),
      }),
    ]);
    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("could not be read safely")]);
    await expect(fs.readFile(fixture.toolsPath, "utf8")).resolves.toBe(rootTools);
    await expect(fs.readFile(path.join(outsideDir, "TOOLS.md"), "utf8")).resolves.toBe(
      "Outside notes.\n",
    );
  });

  it("ignores unrelated unsafe patterns while migrating the root TOOLS.md", async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.toolsPath, "Root-only notes.\n");
    configureExtraBootstrapPatterns(fixture.cfg, "paths", ["../outside/AGENTS.md"]);

    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toContain("Root-only notes.");
    await expectMissing(fixture.toolsPath);
  });

  it("treats a configured but not-yet-created workspace as having no migration sources", async () => {
    const fixture = await createFixture();
    configureExtraBootstrapPatterns(fixture.cfg, "paths", ["packages/*/TOOLS.md"]);
    await fs.rm(fixture.workspace, { recursive: true });

    await expect(collectToolsMdMigrationFindings(fixture.cfg)).resolves.toEqual([]);
    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });
    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Added migrated AGENTS.md bootstrap pattern: packages/*/AGENTS.md",
    ]);
  });

  it.each([
    ["globstar", "packages/**", 1],
    ["character class", "packages/*/TOOL[LS].md", 2],
    ["path-spanning alternatives", "{packages/claimed/TOOLS.md,packages/other/AGENTS.md}", 2],
  ] as const)(
    "recovers an interrupted nested claim discovered through a %s pattern",
    async (_label, pattern, expectedChangeCount) => {
      const fixture = await createFixture();
      const packageDir = path.join(fixture.workspace, "packages", "claimed");
      const toolsPath = path.join(packageDir, "TOOLS.md");
      await fs.mkdir(packageDir, { recursive: true });
      await fs.writeFile(toolsPath, "Recovered nested notes.\n");
      const claimPath = `${toolsPath}.doctor-importing-999999-${Date.now() - 60_000}-claim`;
      await fs.rename(toolsPath, claimPath);
      configureExtraBootstrapPatterns(fixture.cfg, "paths", [pattern]);

      const result = await maybeMigrateToolsMd({
        cfg: fixture.cfg,
        shouldRepair: true,
        env: fixture.env,
      });

      expect(result.warnings).toEqual([]);
      expect(result.changes).toHaveLength(expectedChangeCount);
      await expect(fs.readFile(path.join(packageDir, "AGENTS.md"), "utf8")).resolves.toContain(
        "Recovered nested notes.",
      );
      await expectMissing(toolsPath);
      await expectMissing(claimPath);
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses an in-workspace TOOLS.md file symlink instead of migrating its target",
    async () => {
      const fixture = await createFixture();
      const linkedDir = path.join(fixture.workspace, "packages", "linked");
      const sharedDir = path.join(fixture.workspace, "packages", "shared");
      await fs.mkdir(linkedDir, { recursive: true });
      await fs.mkdir(sharedDir, { recursive: true });
      const sharedTools = path.join(sharedDir, "TOOLS.md");
      await fs.writeFile(sharedTools, "Shared notes.\n");
      await fs.symlink(path.join("..", "shared", "TOOLS.md"), path.join(linkedDir, "TOOLS.md"));
      configureExtraBootstrapPatterns(fixture.cfg, "paths", ["packages/linked/TOOLS.md"]);

      await expect(collectToolsMdMigrationFindings(fixture.cfg)).resolves.toEqual([
        expect.objectContaining({
          severity: "error",
          message: expect.stringContaining("must not be a symlink"),
        }),
      ]);
      await expect(fs.readFile(sharedTools, "utf8")).resolves.toBe("Shared notes.\n");
      await expectMissing(path.join(sharedDir, "AGENTS.md"));
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses a sibling AGENTS.md symlink before archiving or mutating the source",
    async () => {
      const fixture = await createFixture();
      const packageDir = path.join(fixture.workspace, "packages", "linked-agents");
      const outsideAgents = path.join(fixture.root, "outside-agents.md");
      const toolsPath = path.join(packageDir, "TOOLS.md");
      await fs.mkdir(packageDir, { recursive: true });
      await fs.writeFile(outsideAgents, "Private external instructions.\n");
      await fs.writeFile(toolsPath, "Nested tool notes.\n");
      await fs.symlink(outsideAgents, path.join(packageDir, "AGENTS.md"));
      configureExtraBootstrapPatterns(fixture.cfg, "paths", ["packages/*/TOOLS.md"]);

      const result = await maybeMigrateToolsMd({
        cfg: fixture.cfg,
        shouldRepair: true,
        env: fixture.env,
      });

      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([
        expect.stringContaining("AGENTS.md must be an unlinked regular file"),
      ]);
      await expect(fs.readFile(toolsPath, "utf8")).resolves.toBe("Nested tool notes.\n");
      await expect(fs.readFile(outsideAgents, "utf8")).resolves.toBe(
        "Private external instructions.\n",
      );
      await expectMissing(fixture.stateDir);
    },
  );

  it.runIf(process.platform !== "win32")(
    "retargets the hook when an earlier nested migration succeeds before a later failure",
    async () => {
      const fixture = await createFixture();
      const successDir = path.join(fixture.workspace, "packages", "a-success");
      const failedDir = path.join(fixture.workspace, "packages", "z-failed");
      const outsideAgents = path.join(fixture.root, "outside-agents.md");
      await fs.mkdir(successDir, { recursive: true });
      await fs.mkdir(failedDir, { recursive: true });
      await fs.writeFile(path.join(successDir, "TOOLS.md"), "Successfully migrated.\n");
      await fs.writeFile(path.join(failedDir, "TOOLS.md"), "Must remain.\n");
      await fs.writeFile(outsideAgents, "Private external instructions.\n");
      await fs.symlink(outsideAgents, path.join(failedDir, "AGENTS.md"));
      configureExtraBootstrapPatterns(fixture.cfg, "paths", ["packages/*/TOOLS.md"]);

      const result = await maybeMigrateToolsMd({
        cfg: fixture.cfg,
        shouldRepair: true,
        env: fixture.env,
      });

      expect(result.changes).toHaveLength(2);
      expect(result.warnings).toHaveLength(1);
      await expect(fs.readFile(path.join(successDir, "AGENTS.md"), "utf8")).resolves.toContain(
        "Successfully migrated.",
      );
      await expectMissing(path.join(successDir, "TOOLS.md"));
      await expect(fs.readFile(path.join(failedDir, "TOOLS.md"), "utf8")).resolves.toBe(
        "Must remain.\n",
      );
      expect(fixture.cfg.hooks?.internal?.entries?.["bootstrap-extra-files"]?.paths).toEqual([
        "packages/*/TOOLS.md",
        "packages/*/AGENTS.md",
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "stops the workspace migration when a configured nested path follows a symlink outside",
    async () => {
      const fixture = await createFixture();
      const outsideDir = path.join(fixture.root, "outside");
      const packagesDir = path.join(fixture.workspace, "packages");
      await fs.mkdir(outsideDir);
      await fs.mkdir(packagesDir);
      await fs.writeFile(path.join(outsideDir, "TOOLS.md"), "Outside notes.\n");
      await fs.symlink(outsideDir, path.join(packagesDir, "linked"), "dir");
      configureExtraBootstrapPatterns(fixture.cfg, "paths", ["packages/linked/TOOLS.md"]);

      await expect(collectToolsMdMigrationFindings(fixture.cfg)).resolves.toEqual([
        expect.objectContaining({
          severity: "error",
          requirement: "tools-md-migration-blocked",
        }),
      ]);
    },
  );

  it("keeps live claims created from old source files fresh", async () => {
    const ownerPid = process.ppid;
    const oldTimestamp = new Date("2000-01-01T00:00:00.000Z");

    const toolsFixture = await createFixture();
    await fs.writeFile(toolsFixture.toolsPath, "old tool notes\n");
    await fs.utimes(toolsFixture.toolsPath, oldTimestamp, oldTimestamp);
    const toolsClaimPath = `${toolsFixture.toolsPath}.doctor-importing-${ownerPid}-${Date.now()}-claim`;
    await fs.rename(toolsFixture.toolsPath, toolsClaimPath);

    const toolsResult = await maybeMigrateToolsMd({
      cfg: toolsFixture.cfg,
      shouldRepair: true,
      env: toolsFixture.env,
    });

    expect(toolsResult.warnings).toEqual([
      expect.stringContaining(`TOOLS.md migration claim is held by running process ${ownerPid}`),
    ]);
    await expect(fs.stat(toolsClaimPath)).resolves.toMatchObject({
      mtimeMs: oldTimestamp.getTime(),
    });

    const agentsFixture = await createFixture();
    await fs.writeFile(agentsFixture.toolsPath, "old tool notes\n");
    await fs.writeFile(agentsFixture.agentsPath, "# Agent\n");
    await fs.utimes(agentsFixture.agentsPath, oldTimestamp, oldTimestamp);
    const agentsClaimPath = `${agentsFixture.agentsPath}.doctor-backup-${ownerPid}-${Date.now()}`;
    await fs.rename(agentsFixture.agentsPath, agentsClaimPath);

    const agentsResult = await maybeMigrateToolsMd({
      cfg: agentsFixture.cfg,
      shouldRepair: true,
      env: agentsFixture.env,
    });

    expect(agentsResult.warnings).toEqual([
      expect.stringContaining(`AGENTS.md migration claim is held by running process ${ownerPid}`),
    ]);
    await expect(fs.readFile(agentsFixture.toolsPath, "utf8")).resolves.toBe("old tool notes\n");
    await expect(fs.stat(agentsClaimPath)).resolves.toMatchObject({
      mtimeMs: oldTimestamp.getTime(),
    });
  });

  it("appends a Tools section when AGENTS.md has no Tools heading", async () => {
    const fixture = await createFixture();
    const agents = "# Agent\n\nKeep safe.";
    const tools = "Local camera: kitchen → wide angle\n";
    await fs.writeFile(fixture.agentsPath, agents);
    await fs.writeFile(fixture.toolsPath, tools);

    await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(
      `${agents}\n\n## Tools\n\n### Local notes (migrated from TOOLS.md)\n\n${tools}`,
    );
    await expectMissing(fixture.toolsPath);
  });

  it.each([
    ["untouched template", LEGACY_TOOLS_MD_TEMPLATE_FIXTURE],
    ["empty file", ""],
    ["whitespace-only file", " \n\t"],
  ])("deletes the %s without appending content", async (_label, tools) => {
    const fixture = await createFixture();
    const agents = "# Agent\n\n## Tools\n\nLocal details stay unchanged.\n";
    await fs.writeFile(fixture.agentsPath, agents);
    await fs.writeFile(fixture.toolsPath, tools);

    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(agents);
    await expect(readOnlyArchive(fixture.stateDir)).resolves.toEqual(Buffer.from(tools));
    await expectMissing(fixture.toolsPath);
  });

  it("keeps TOOLS.md untouched when the original cannot be archived", async () => {
    const fixture = await createFixture();
    const agents = "# Agent\n\n## Tools\n\nExisting notes.\n";
    const tools = "Local camera: kitchen → wide angle\n";
    await fs.writeFile(fixture.agentsPath, agents);
    await fs.writeFile(fixture.toolsPath, tools);
    await fs.writeFile(fixture.stateDir, "not a directory");

    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(agents);
    await expect(fs.readFile(fixture.toolsPath, "utf8")).resolves.toBe(tools);
  });
});
