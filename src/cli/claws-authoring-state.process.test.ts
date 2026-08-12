import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function snapshotTree(root: string): Promise<string[]> {
  const snapshot: string[] = [];
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot.push(`d ${relativePath}`);
        await walk(absolutePath, relativePath);
      } else {
        snapshot.push(`f ${relativePath} ${(await fs.readFile(absolutePath)).toString("base64")}`);
      }
    }
  };
  await walk(root, "");
  return snapshot;
}

async function writeProject(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({
      name: "authoring-state-test",
      version: "1.0.0",
      openclaw: { claw: "CLAW.md" },
    })}\n`,
  );
  await fs.writeFile(
    path.join(root, "CLAW.md"),
    ["---", "schemaVersion: 1", "agent:", "  id: authoring-state-test", "---", ""].join("\n"),
  );
}

function runClaws(root: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", path.resolve("src", "entry.ts"), "claws", ...args],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        NODE_DISABLE_COMPILE_CACHE: "1",
        NODE_ENV: undefined,
        NODE_OPTIONS: undefined,
        NO_COLOR: "1",
        OPENCLAW_CONFIG_PATH: path.join(root, "config", "openclaw.json"),
        OPENCLAW_EXPERIMENTAL_CLAWS: "1",
        OPENCLAW_HIDE_BANNER: "1",
        OPENCLAW_HOME: root,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        VITEST: undefined,
        VITEST_POOL_ID: undefined,
        VITEST_WORKER_ID: undefined,
      },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60_000,
    },
  );
}

describe("Claw authoring process state", () => {
  it("leaves migration-pending operator state unchanged for claws dev", async () => {
    const root = tempDirs.make("openclaw-claws-dev-state-");
    const external = tempDirs.make("openclaw-claws-dev-external-");
    const project = path.join(external, "project");
    const workspace = path.join(external, "dev-workspace");
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.mkdir(path.join(root, "state", "tasks"), { recursive: true });
    await fs.writeFile(path.join(root, "config", "openclaw.json"), "{}\n");
    await fs.writeFile(path.join(root, "state", "tasks", "runs.sqlite"), "legacy state\n");
    await writeProject(project);
    const before = await snapshotTree(root);

    const result = runClaws(root, ["dev", project, "--workspace", workspace, "--json"]);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toBeTruthy();
    expect(await snapshotTree(root)).toEqual(before);
  }, 120_000);
});
