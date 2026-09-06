// Check Package Patches tests cover check package patches script behavior.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectPackagePatchViolations } from "../../scripts/check-package-patches.mts";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "../helpers/temp-dir.js";
import { writeJsonFile } from "../helpers/temp-repo.js";

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
  const env: NodeJS.ProcessEnv = {
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
  it("allows approved pnpm patches together", () => {
    const approvedPatches = [
      ["@awesome.me/webawesome@3.12.0", "patches/@awesome.me__webawesome@3.12.0.patch"],
      ["baileys@7.0.0-rc12", "patches/baileys@7.0.0-rc12.patch"],
      ["baileys@7.0.0-rc13", "patches/baileys@7.0.0-rc13.patch"],
      ["vitest@5.0.0", "patches/vitest@5.0.0.patch"],
      ["matrix-js-sdk@42.2.0", "patches/matrix-js-sdk@42.2.0.patch"],
    ] as const;
    const dir = makeRepo();
    mkdirSync(path.join(dir, "patches"), { recursive: true });
    writeFileSync(
      path.join(dir, "pnpm-workspace.yaml"),
      `packages:
  - .
patchedDependencies:
${approvedPatches.map(([specifier, patchPath]) => `  "${specifier}": "${patchPath}"`).join("\n")}
`,
      "utf8",
    );
    writeFileSync(
      path.join(dir, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'
patchedDependencies:
${approvedPatches.map(([specifier]) => `  "${specifier}": a9aea1790d2c65b1ae543c77faca4119bbfb91ee3b6ca6c38d1cad4f5702ada2`).join("\n")}
`,
      "utf8",
    );
    for (const [, patchPath] of approvedPatches) {
      writeFileSync(path.join(dir, patchPath), "diff\n", "utf8");
    }
    git(dir, ["add", "pnpm-workspace.yaml", "pnpm-lock.yaml", "patches"]);

    expect(collectPackagePatchViolations(dir)).toEqual([]);
  });

  it.each([
    ["left-pad@1.3.0", "patches/left-pad@1.3.0.patch"],
    ["matrix-js-sdk@42.2.1", "patches/matrix-js-sdk@42.2.1.patch"],
    ["matrix-js-sdk@42.2.0", "patches/matrix-js-sdk@42.2.0-other.patch"],
  ])("rejects unapproved workspace patch %s -> %s", (specifier, patchPath) => {
    const dir = makeRepo();
    mkdirSync(path.join(dir, "patches"), { recursive: true });
    mkdirSync(path.join(dir, "fixtures"), { recursive: true });
    writeFileSync(
      path.join(dir, "pnpm-workspace.yaml"),
      `packages:
  - .
patchedDependencies:
  "${specifier}": "${patchPath}"
`,
      "utf8",
    );
    writeFileSync(path.join(dir, patchPath), "diff\n", "utf8");
    writeFileSync(path.join(dir, "fixtures", "fixture.patch"), "diff\n", "utf8");
    git(dir, ["add", "pnpm-workspace.yaml", "patches", "fixtures"]);

    expect(collectPackagePatchViolations(dir)).toEqual([
      {
        file: "pnpm-workspace.yaml",
        kind: "patchedDependency",
        detail: `${specifier} -> ${patchPath}`,
      },
      {
        file: "fixtures/fixture.patch",
        kind: "patchFile",
        detail: "new package patch file",
      },
      {
        file: patchPath,
        kind: "patchFile",
        detail: "new package patch file",
      },
    ]);
  });

  it("allows deleted legacy patch files during the commit that removes them", () => {
    const dir = makeRepo();
    mkdirSync(path.join(dir, "patches"), { recursive: true });
    writeFileSync(
      path.join(dir, "patches", "@agentclientprotocol__claude-agent-acp@0.33.1.patch"),
      "diff\n",
      "utf8",
    );
    git(dir, ["add", "patches"]);
    rmSync(path.join(dir, "patches", "@agentclientprotocol__claude-agent-acp@0.33.1.patch"));

    expect(collectPackagePatchViolations(dir)).toEqual([]);
  });

  it.each([false, true])(
    "rejects lockfile and package-local patches with toolchain metadata %s",
    (withToolchain) => {
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
        `${withToolchain ? "---\nlockfileVersion: '9.0'\npatchedDependencies:\n  toolchain@1.0.0: toolhash\n---\n" : ""}lockfileVersion: '9.0'
patchedDependencies:
  hidden@1.0.0: abc123
`,
        "utf8",
      );
      git(dir, ["add", "package.json", "pnpm-lock.yaml"]);

      expect(collectPackagePatchViolations(dir)).toEqual([
        ...(withToolchain
          ? [
              {
                file: "pnpm-lock.yaml",
                kind: "patchedDependency",
                detail: "toolchain@1.0.0 -> toolhash",
              },
            ]
          : []),
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
    },
  );

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
