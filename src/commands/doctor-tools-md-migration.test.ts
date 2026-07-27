import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

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

  it.runIf(process.platform !== "win32")(
    "refuses symlinked AGENTS.md files and interrupted claims",
    async () => {
      const linkedFixture = await createFixture();
      const linkedTarget = path.join(linkedFixture.root, "outside-agents.md");
      await fs.writeFile(linkedTarget, "Private external instructions.\n");
      await fs.writeFile(linkedFixture.toolsPath, "Local tool notes.\n");
      await fs.symlink(linkedTarget, linkedFixture.agentsPath);

      const linkedResult = await maybeMigrateToolsMd({
        cfg: linkedFixture.cfg,
        shouldRepair: true,
        env: linkedFixture.env,
      });

      expect(linkedResult.changes).toEqual([]);
      expect(linkedResult.warnings).toEqual([
        expect.stringContaining("AGENTS.md must be an unlinked regular file"),
      ]);
      await expect(fs.readFile(linkedFixture.toolsPath, "utf8")).resolves.toBe(
        "Local tool notes.\n",
      );
      await expect(fs.readFile(linkedTarget, "utf8")).resolves.toBe(
        "Private external instructions.\n",
      );

      const claimFixture = await createFixture();
      const claimTarget = path.join(claimFixture.root, "outside-claim.md");
      const claimPath = `${claimFixture.agentsPath}.doctor-backup-999999-${Date.now() - 60_000}`;
      await fs.writeFile(claimTarget, "Untrusted claim content.\n");
      await fs.writeFile(claimFixture.toolsPath, "Local tool notes.\n");
      await fs.symlink(claimTarget, claimPath);

      const claimResult = await maybeMigrateToolsMd({
        cfg: claimFixture.cfg,
        shouldRepair: true,
        env: claimFixture.env,
      });

      expect(claimResult.changes).toEqual([]);
      expect(claimResult.warnings).toEqual([
        expect.stringContaining("AGENTS.md migration claim must be an unlinked regular file"),
      ]);
      await expect(fs.readFile(claimFixture.toolsPath, "utf8")).resolves.toBe(
        "Local tool notes.\n",
      );
      await expect(fs.readFile(claimTarget, "utf8")).resolves.toBe("Untrusted claim content.\n");
      await expectMissing(claimFixture.agentsPath);
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

  it("recovers an AGENTS.md publish interrupted after the hard link", async () => {
    const fixture = await createFixture();
    const agents = "# Agent\n\n## Tools\n\nExisting notes.\n";
    const tools = "### Cameras\n\n- kitchen → wide angle\n";
    const merged = `${agents}\n### Local notes (migrated from TOOLS.md)\n\n${tools}`;
    const interruptedAt = Date.now() - 60_000;
    const toolsClaimPath = `${fixture.toolsPath}.doctor-importing-999999-${interruptedAt}-claim`;
    const agentsClaimPath = `${fixture.agentsPath}.doctor-backup-999999-${interruptedAt}`;
    const tempPath = `${fixture.agentsPath}.doctor-writing-999999-${interruptedAt}`;
    await fs.writeFile(toolsClaimPath, tools);
    await fs.writeFile(agentsClaimPath, agents);
    await fs.writeFile(tempPath, merged);
    await fs.link(tempPath, fixture.agentsPath);
    await expect(fs.stat(fixture.agentsPath)).resolves.toMatchObject({ nlink: 2 });

    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(merged);
    await expect(fs.stat(fixture.agentsPath)).resolves.toMatchObject({ nlink: 1 });
    await expect(fs.readdir(fixture.workspace)).resolves.toEqual(["AGENTS.md"]);
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
