// Backup CLI process coverage proves workspace exclusion through the shipped command path.
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatCliProcessFailure, runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function listArchiveEntries(archivePath: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push(entry.path);
      entry.resume();
    },
  });
  return entries;
}

it.runIf(process.platform !== "win32")(
  "excludes a configured workspace before archive link validation",
  async () => {
    const root = tempDirs.make("openclaw-backup-cli-workspace-exclusion-");
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(stateDir, "workspace");
    const externalTarget = path.join(root, "external-build");
    const outputDir = path.join(root, "output");
    const configPath = path.join(stateDir, "openclaw.json");
    await Promise.all([
      fs.mkdir(workspaceDir, { recursive: true }),
      fs.mkdir(externalTarget, { recursive: true }),
      fs.mkdir(outputDir, { recursive: true }),
    ]);
    await fs.writeFile(
      configPath,
      JSON.stringify({ agents: { defaults: { workspace: workspaceDir } } }),
    );
    await fs.writeFile(path.join(stateDir, "state-sentinel.txt"), "state\n");
    await fs.writeFile(path.join(workspaceDir, "workspace-notes.txt"), "workspace\n");
    await fs.symlink(externalTarget, path.join(workspaceDir, ".build"), "dir");

    const result = await runCliProcessChild({
      nodeArgs: [
        "--import",
        "tsx",
        "src/entry.ts",
        "backup",
        "create",
        "--no-include-workspace",
        "--output",
        outputDir,
        "--verify",
        "--json",
      ],
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        NODE_DISABLE_COMPILE_CACHE: "1",
        NODE_ENV: undefined,
        NODE_OPTIONS: undefined,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_HOME: root,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_STATE_DIR: stateDir,
        VITEST: undefined,
      },
    });
    if (result.code !== 0) {
      throw new Error(
        formatCliProcessFailure({
          reason: `backup CLI exited with code ${result.code} and signal ${result.signal}`,
          stdout: result.stdout,
          stderr: result.stderr,
        }),
      );
    }

    const output: unknown = JSON.parse(result.stdout);
    expect(output).toMatchObject({ includeWorkspace: false, verified: true });
    if (
      !output ||
      typeof output !== "object" ||
      !("archivePath" in output) ||
      typeof output.archivePath !== "string"
    ) {
      throw new Error("backup CLI did not return an archive path");
    }
    const entries = await listArchiveEntries(output.archivePath);
    expect(entries.some((entry) => entry.endsWith("/state-sentinel.txt"))).toBe(true);
    expect(entries.some((entry) => entry.includes("/workspace/"))).toBe(false);
  },
);
