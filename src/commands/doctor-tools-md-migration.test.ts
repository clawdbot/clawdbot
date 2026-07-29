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
const LEGACY_AGENTS_GUIDANCE_REWRITES = [
  [
    "generic workspace template",
    "Skills provide your tools. When you need one, check its `SKILL.md`. Keep local notes (camera names, SSH details, voice preferences) in `TOOLS.md`.",
    "Skills define how tools work. Keep environment-specific local notes in this section.",
  ],
  [
    "default template lowercase parenthetical",
    "- Keep environment-specific notes in `TOOLS.md` (notes for skills).",
    "- Keep environment-specific notes in this file's `## Tools` section.",
  ],
  [
    "default template title-case parenthetical",
    "- Keep environment-specific notes in `TOOLS.md` (Notes for Skills).",
    "- Keep environment-specific notes in this file's `## Tools` section.",
  ],
  [
    "current lesson reminder",
    "- You learn a lesson -> update `AGENTS.md`, `TOOLS.md`, or the relevant skill.",
    "- You learn a lesson -> update `AGENTS.md` or the relevant skill.",
  ],
  [
    "original lesson reminder",
    "- When you learn a lesson → update AGENTS.md, TOOLS.md, or the relevant skill",
    "- When you learn a lesson → update AGENTS.md or the relevant skill",
  ],
  [
    "Chinese generic template with English Skills",
    "Skills 提供你的工具。当你需要某个工具时，查看它的 `SKILL.md`。在 `TOOLS.md` 中保存本地笔记（摄像头名称、SSH 详情、语音偏好等）。",
    "Skills 定义工具的使用方式。请将环境特定的本地笔记保存在本节中。",
  ],
  [
    "Chinese generic template",
    "技能提供你的工具。当你需要某个工具时，查看它的 `SKILL.md`。在 `TOOLS.md` 中保存本地笔记（摄像头名称、SSH 详情、语音偏好等）。",
    "技能定义工具的使用方式。请将环境特定的本地笔记保存在本节中。",
  ],
  [
    "Chinese default template",
    "- 在 `TOOLS.md` 中保存环境特定的笔记（Skills 注意事项）。",
    "- 将环境特定的笔记保存在本文件的 `## Tools` 部分。",
  ],
  [
    "Chinese default template with Skills",
    "- 将环境相关的备注保存在 `TOOLS.md`（Skills 备注）中。",
    "- 将环境相关的备注保存在本文件的 `## Tools` 部分。",
  ],
  [
    "Chinese default template with translated skills",
    "- 将环境相关的备注保存在 `TOOLS.md`（技能备注）中。",
    "- 将环境相关的备注保存在本文件的 `## Tools` 部分。",
  ],
  [
    "Chinese lesson reminder with Skills",
    "- 当你学到教训 → 更新 AGENTS.md、TOOLS.md 或相关 Skills 文件",
    "- 当你学到教训 → 更新 AGENTS.md 或相关 Skills 文件",
  ],
  [
    "Chinese lesson reminder with translated skills",
    "- 当你学到教训 → 更新 AGENTS.md、TOOLS.md 或相关技能文件",
    "- 当你学到教训 → 更新 AGENTS.md 或相关技能文件",
  ],
] as const;

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

  it("warns when the merged AGENTS.md will exceed the agent bootstrap file limit", async () => {
    const fixture = await createFixture();
    const agents = `# Agent\n\n## Tools\n\n${"a".repeat(15_000)}\n`;
    const tools = `${"b".repeat(15_000)}\n`;
    const merged = `${agents}\n### Local notes (migrated from TOOLS.md)\n\n${tools}`;
    fixture.cfg.agents!.list![0]!.bootstrapMaxChars = 20_000;
    await fs.writeFile(fixture.agentsPath, agents);
    await fs.writeFile(fixture.toolsPath, tools);

    const findings = await collectToolsMdMigrationFindings(fixture.cfg);

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/tools-md-migration",
        requirement: "tools-md-merged-bootstrap-limit",
        message: `Agent "main" TOOLS.md migration will produce a ${merged.length}-character AGENTS.md, exceeding its configured bootstrapMaxChars limit of 20000. Raise \`agents.entries.*.bootstrapMaxChars\` for this agent, or \`agents.defaults.bootstrapMaxChars\` as fallback, to preserve all migrated instructions.`,
      }),
    );
  });

  it("checks every agent budget while migrating a shared workspace once", async () => {
    const fixture = await createFixture();
    const agents = `# Agent\n\n## Tools\n\n${"a".repeat(15_000)}\n`;
    const tools = `${"b".repeat(15_000)}\n`;
    const merged = `${agents}\n### Local notes (migrated from TOOLS.md)\n\n${tools}`;
    fixture.cfg.agents!.list = [
      { id: "main", default: true, workspace: fixture.workspace, bootstrapMaxChars: 40_000 },
      { id: "limited", workspace: fixture.workspace, bootstrapMaxChars: 20_000 },
    ];
    await fs.writeFile(fixture.agentsPath, agents);
    await fs.writeFile(fixture.toolsPath, tools);

    const findings = await collectToolsMdMigrationFindings(fixture.cfg);

    expect(
      findings.filter((finding) => finding.requirement === "tools-md-merged-bootstrap-limit"),
    ).toEqual([
      expect.objectContaining({
        target: "limited",
        message: `Agent "limited" TOOLS.md migration will produce a ${merged.length}-character AGENTS.md, exceeding its configured bootstrapMaxChars limit of 20000. Raise \`agents.entries.*.bootstrapMaxChars\` for this agent, or \`agents.defaults.bootstrapMaxChars\` as fallback, to preserve all migrated instructions.`,
      }),
    ]);

    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    expect(result).toMatchObject({ changes: [expect.any(String)], warnings: [] });
    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(merged);
    await expect(readOnlyArchive(fixture.stateDir)).resolves.toEqual(Buffer.from(tools));
    await expectMissing(fixture.toolsPath);
  });

  it("does not emit a bootstrap limit finding for a normal-sized merge", async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.agentsPath, "# Agent\n\n## Tools\n\nExisting notes.\n");
    await fs.writeFile(fixture.toolsPath, "Local camera: kitchen\n");

    const findings = await collectToolsMdMigrationFindings(fixture.cfg);

    expect(findings).not.toContainEqual(
      expect.objectContaining({ requirement: "tools-md-merged-bootstrap-limit" }),
    );
  });

  it.each(LEGACY_AGENTS_GUIDANCE_REWRITES)(
    "rewrites the %s without leaving a TOOLS.md directive",
    async (_label, legacy, current) => {
      const fixture = await createFixture();
      await fs.writeFile(fixture.agentsPath, `# Agent\n\n## Tools\n\n${legacy}\n`);
      await fs.writeFile(fixture.toolsPath, LEGACY_TOOLS_MD_TEMPLATE_FIXTURE);

      const result = await maybeMigrateToolsMd({
        cfg: fixture.cfg,
        shouldRepair: true,
        env: fixture.env,
      });

      expect(result.warnings).toEqual([]);
      const migratedAgents = await fs.readFile(fixture.agentsPath, "utf8");
      expect(migratedAgents).toContain(current);
      expect(migratedAgents).not.toContain(legacy);
      expect(migratedAgents).not.toContain("TOOLS.md");
      await expectMissing(fixture.toolsPath);
    },
  );

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
