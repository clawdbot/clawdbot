// Plugin release pretag pack check tests cover its script-local target and command routing.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_PLUGIN_NPM_REPOSITORY_URL } from "../../scripts/lib/plugin-npm-release.ts";
import {
  collectPluginReleasePretagPackTargets,
  runPluginReleasePretagPackCheck,
} from "../../scripts/plugin-release-pretag-pack-check.ts";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "../helpers/temp-repo.js";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

const tempDirs: string[] = [];

type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: unknown;
};

afterEach(() => {
  cleanupTempDirs(tempDirs);
  execFileSyncMock.mockReset();
});

function createDualPublishPluginRepo() {
  const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-pretag-pack-");
  const packageDir = join(repoDir, "extensions", "demo-plugin");
  mkdirSync(packageDir, { recursive: true });
  writeJsonFile(join(repoDir, "package.json"), { name: "openclaw-test-root", type: "module" });
  writeJsonFile(join(packageDir, "package.json"), {
    name: "@openclaw/demo-plugin",
    version: "2026.4.10",
    type: "module",
    repository: {
      type: "git",
      url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
    },
    openclaw: {
      extensions: ["./index.ts"],
      compat: {
        pluginApi: ">=2026.4.10",
      },
      build: {
        openclawVersion: "2026.4.10",
      },
      install: {
        npmSpec: "@openclaw/demo-plugin",
      },
      release: {
        publishToClawHub: true,
        publishToNpm: true,
      },
    },
  });
  writeFileSync(join(packageDir, "README.md"), "# Demo plugin\n");
  writeFileSync(join(packageDir, "index.ts"), "export const demo = 1;\n");

  return repoDir;
}

function callOptions(index: number): ExecOptions {
  return execFileSyncMock.mock.calls[index]?.[2] as ExecOptions;
}

describe("scripts/plugin-release-pretag-pack-check.ts", () => {
  it("collects dual-published plugin targets for npm and ClawHub pack checks", () => {
    const repoDir = createDualPublishPluginRepo();

    expect(collectPluginReleasePretagPackTargets(repoDir)).toEqual([
      {
        packageDir: "extensions/demo-plugin",
        packageName: "@openclaw/demo-plugin",
        packClawHub: true,
        packNpm: true,
      },
    ]);
  });

  it("runs runtime build, npm pack, and ClawHub pack commands for selected targets", () => {
    const repoDir = createDualPublishPluginRepo();
    execFileSyncMock.mockImplementation(() => "");

    runPluginReleasePretagPackCheck(repoDir);

    expect(execFileSyncMock).toHaveBeenCalledTimes(3);
    expect(execFileSyncMock.mock.calls[0]?.slice(0, 2)).toEqual([
      process.execPath,
      ["scripts/check-plugin-npm-runtime-builds.mjs", "--package", "extensions/demo-plugin"],
    ]);
    expect(callOptions(0)).toMatchObject({ cwd: repoDir, stdio: "inherit" });

    expect(execFileSyncMock.mock.calls[1]?.slice(0, 2)).toEqual([
      "bash",
      ["scripts/plugin-npm-publish.sh", "--pack-dry-run", "extensions/demo-plugin"],
    ]);
    expect(callOptions(1)).toMatchObject({
      cwd: repoDir,
      env: { OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD: "0" },
      stdio: ["inherit", "ignore", "inherit"],
    });

    expect(execFileSyncMock.mock.calls[2]?.slice(0, 2)).toEqual([
      "bash",
      ["scripts/plugin-clawhub-publish.sh", "--pack", "extensions/demo-plugin"],
    ]);
    expect(callOptions(2)).toMatchObject({
      cwd: repoDir,
      env: { OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD: "0" },
      stdio: ["inherit", "ignore", "inherit"],
    });
    expect(callOptions(2).env?.OPENCLAW_CLAWHUB_PACK_OUTPUT_DIR).toContain("clawhub-0");
  });
});
