import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectToolsMdMigrationFindings,
  LEGACY_TOOLS_MD_TEMPLATE,
  maybeMigrateToolsMd,
} from "./doctor-tools-md-migration.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tools-md-migration-"));
  tempDirs.push(root);
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

describe("TOOLS.md migration", () => {
  it("previews without mutation, merges verbatim, archives, removes, and reruns idempotently", async () => {
    const fixture = await createFixture();
    const agents = "# Agent\n\n## Tools\n\nExisting notes.\n\n## Safety\n\nBe careful.\n";
    const tools = "### Cameras\n\n- kitchen → wide angle\n";
    await fs.writeFile(fixture.agentsPath, agents);
    await fs.writeFile(fixture.toolsPath, tools);

    await expect(collectToolsMdMigrationFindings(fixture.cfg)).resolves.toEqual([
      expect.objectContaining({
        checkId: "core/doctor/tools-md-migration",
        requirement: "legacy-tools-md",
      }),
    ]);
    await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: false,
      env: fixture.env,
    });
    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(agents);
    await expect(fs.readFile(fixture.toolsPath, "utf8")).resolves.toBe(tools);

    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });
    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    const merged = await fs.readFile(fixture.agentsPath, "utf8");
    expect(merged).toContain(
      `## Tools\n\nExisting notes.\n\n### Local notes (migrated from TOOLS.md)\n\n${tools}`,
    );
    expect(merged.indexOf("### Local notes")).toBeLessThan(merged.indexOf("## Safety"));
    expect(merged).toContain(tools);
    await expect(fs.access(fixture.toolsPath)).rejects.toMatchObject({ code: "ENOENT" });

    const archiveDir = path.join(fixture.stateDir, "backups", "tools-md-migration");
    const archives = await fs.readdir(archiveDir);
    expect(archives).toHaveLength(1);
    await expect(fs.readFile(path.join(archiveDir, archives[0]!), "utf8")).resolves.toBe(tools);

    const rerun = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });
    expect(rerun).toEqual({ changes: [], warnings: [] });
    expect(
      (await fs.readFile(fixture.agentsPath, "utf8")).match(/migrated from TOOLS\.md/gu),
    ).toHaveLength(1);
  });

  it("deletes an untouched template without appending it", async () => {
    const fixture = await createFixture();
    const agents = "# Agent\n\n## Tools\n\nLocal details go here.\n";
    await fs.writeFile(fixture.agentsPath, agents);
    await fs.writeFile(fixture.toolsPath, LEGACY_TOOLS_MD_TEMPLATE);

    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(agents);
    await expect(fs.access(fixture.toolsPath)).rejects.toMatchObject({ code: "ENOENT" });
    const archiveDir = path.join(fixture.stateDir, "backups", "tools-md-migration");
    const [archive] = await fs.readdir(archiveDir);
    await expect(fs.readFile(path.join(archiveDir, archive!), "utf8")).resolves.toBe(
      LEGACY_TOOLS_MD_TEMPLATE,
    );
  });
});
