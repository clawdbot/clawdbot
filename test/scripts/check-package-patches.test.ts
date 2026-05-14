import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectPackagePatchViolations } from "../../scripts/check-package-patches.mjs";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "../helpers/temp-repo.js";

const tempDirs: string[] = [];

const nestedGitEnvKeys = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
] as const;

function createNestedGitEnv(): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of nestedGitEnvKeys) {
    delete env[key];
  }
  return env;
}

function git(cwd: string, args: string[]) {
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: createNestedGitEnv(),
  });
}

function makeRepo() {
  const dir = makeTempRepoRoot(tempDirs, "openclaw-package-patches-");
  git(dir, ["init", "-q", "--initial-branch=main"]);
  writeJsonFile(path.join(dir, "package.json"), { name: "fixture" });
  writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - .\n", "utf8");
  writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  git(dir, ["add", "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]);
  return dir;
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("check-package-patches", () => {
  it("allows the existing legacy pnpm patches", () => {
    const dir = makeRepo();
    mkdirSync(path.join(dir, "patches"), { recursive: true });
    writeFileSync(
      path.join(dir, "pnpm-workspace.yaml"),
      `packages:
  - .
patchedDependencies:
  "baileys@7.0.0-rc11": "patches/baileys@7.0.0-rc11.patch"
  "@agentclientprotocol/claude-agent-acp@0.33.1": "patches/@agentclientprotocol__claude-agent-acp@0.33.1.patch"
`,
      "utf8",
    );
    writeFileSync(
      path.join(dir, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'
patchedDependencies:
  '@agentclientprotocol/claude-agent-acp@0.33.1': 3995624bb834cc60fea1461c7ef33f1fcdd8fb58b8f43f2f1490bc689f6e1be2
  baileys@7.0.0-rc11: a9aea1790d2c65b1ae543c77faca4119bbfb91ee3b6ca6c38d1cad4f5702ada2
`,
      "utf8",
    );
    writeFileSync(path.join(dir, "patches", "baileys@7.0.0-rc11.patch"), "diff\n", "utf8");
    writeFileSync(
      path.join(dir, "patches", "@agentclientprotocol__claude-agent-acp@0.33.1.patch"),
      "diff\n",
      "utf8",
    );
    git(dir, ["add", "pnpm-workspace.yaml", "pnpm-lock.yaml", "patches"]);

    expect(collectPackagePatchViolations(dir)).toEqual([]);
  });

  it("rejects new workspace patchedDependencies and patch files", () => {
    const dir = makeRepo();
    mkdirSync(path.join(dir, "patches"), { recursive: true });
    mkdirSync(path.join(dir, "fixtures"), { recursive: true });
    writeFileSync(
      path.join(dir, "pnpm-workspace.yaml"),
      `packages:
  - .
patchedDependencies:
  "left-pad@1.3.0": "patches/left-pad@1.3.0.patch"
`,
      "utf8",
    );
    writeFileSync(path.join(dir, "patches", "left-pad@1.3.0.patch"), "diff\n", "utf8");
    writeFileSync(path.join(dir, "fixtures", "fixture.patch"), "diff\n", "utf8");
    git(dir, ["add", "pnpm-workspace.yaml", "patches", "fixtures"]);

    expect(collectPackagePatchViolations(dir)).toEqual([
      {
        file: "pnpm-workspace.yaml",
        kind: "patchedDependency",
        detail: "left-pad@1.3.0 -> patches/left-pad@1.3.0.patch",
      },
      {
        file: "fixtures/fixture.patch",
        kind: "patchFile",
        detail: "new package patch file",
      },
      {
        file: "patches/left-pad@1.3.0.patch",
        kind: "patchFile",
        detail: "new package patch file",
      },
    ]);
  });

  it("rejects lockfile-only and package-local patch declarations", () => {
    const dir = makeRepo();
    writeJsonFile(path.join(dir, "package.json"), {
      name: "fixture",
      pnpm: {
        patchedDependencies: {
          "nested@1.0.0": "patches/nested.patch",
        },
      },
    });
    writeFileSync(
      path.join(dir, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'
patchedDependencies:
  hidden@1.0.0: abc123
`,
      "utf8",
    );
    git(dir, ["add", "package.json", "pnpm-lock.yaml"]);

    expect(collectPackagePatchViolations(dir)).toEqual([
      {
        file: "pnpm-lock.yaml",
        kind: "patchedDependency",
        detail: "hidden@1.0.0 -> abc123",
      },
      {
        file: "package.json",
        kind: "packageJsonPatchedDependency",
        detail: "nested@1.0.0 -> patches/nested.patch",
      },
    ]);
  });

  it("skips tracked package manifests deleted in the worktree", () => {
    const dir = makeRepo();
    mkdirSync(path.join(dir, "packages", "deleted"), { recursive: true });
    writeJsonFile(path.join(dir, "packages", "deleted", "package.json"), {
      name: "deleted",
      pnpm: {
        patchedDependencies: {
          "deleted-only@1.0.0": "patches/deleted-only.patch",
        },
      },
    });
    git(dir, ["add", "packages/deleted/package.json"]);
    rmSync(path.join(dir, "packages", "deleted", "package.json"));

    expect(collectPackagePatchViolations(dir)).toEqual([]);
  });
});
