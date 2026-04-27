import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectSetupMigrationFreshness } from "./setup.migration-import.js";

const tempRoots = new Set<string>();

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-setup-migration-"));
  tempRoots.add(root);
  return root;
}

async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

describe("setup migration import freshness", () => {
  afterEach(async () => {
    for (const root of tempRoots) {
      await fs.rm(root, { force: true, recursive: true });
    }
    tempRoots.clear();
  });

  it("allows empty config and empty target directories", async () => {
    const root = await makeTempRoot();
    const result = await inspectSetupMigrationFreshness({
      baseConfig: {},
      stateDir: path.join(root, "state"),
      workspaceDir: path.join(root, "workspace"),
    });

    expect(result).toEqual({ fresh: true, reasons: [] });
  });

  it("rejects existing config, workspace files, and state", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    await writeFile(path.join(workspaceDir, "MEMORY.md"), "existing memory\n");
    await writeFile(path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"), "{}\n");

    const result = await inspectSetupMigrationFreshness({
      baseConfig: { gateway: { port: 3131 } },
      stateDir,
      workspaceDir,
    });

    expect(result.fresh).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "existing config values are loaded",
        "workspace MEMORY.md exists",
        "state agents/ exists",
      ]),
    );
  });
});
