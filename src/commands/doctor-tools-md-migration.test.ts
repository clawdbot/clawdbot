import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

import { note } from "../../packages/terminal-core/src/note.js";
import {
  collectToolsMdMigrationFindings,
  LEGACY_TOOLS_MD_TEMPLATE,
  maybeMigrateToolsMd,
} from "./doctor-tools-md-migration.js";

const noteMock = vi.mocked(note);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
    ["untouched template", LEGACY_TOOLS_MD_TEMPLATE],
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
