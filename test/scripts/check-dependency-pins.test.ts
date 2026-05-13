import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectDependencyPinViolations } from "../../scripts/check-dependency-pins.mjs";
import { cleanupTempDirs, makeTempRepoRoot } from "../helpers/temp-repo.js";

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

function writeJson(filePath: string, value: unknown) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeRepo() {
  const dir = makeTempRepoRoot(tempDirs, "openclaw-dependency-pins-");
  git(dir, ["init", "-q", "--initial-branch=main"]);
  return dir;
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("check-dependency-pins", () => {
  it("accepts exact dependency specs and intentionally ranged peer contracts", () => {
    const dir = makeRepo();
    writeJson(path.join(dir, "package.json"), {
      dependencies: {
        exact: "1.2.3",
        prerelease: "1.2.3-beta.1",
        alias: "npm:@scope/real-package@2.3.4",
        workspace: "workspace:*",
        linked: "link:../linked",
        local: "file:../local",
        gitPinned: "github:owner/repo#0123456789abcdef0123456789abcdef01234567",
      },
      devDependencies: {
        devExact: "4.5.6",
      },
      optionalDependencies: {
        optionalExact: "7.8.9",
      },
      peerDependencies: {
        peerCanRange: "^1.0.0",
      },
    });
    writeFileSync(
      path.join(dir, "pnpm-workspace.yaml"),
      `overrides:
  exact: 1.2.3
  alias: "npm:@scope/real-package@2.3.4"
packageExtensions:
  parent@1.0.0:
    dependencies:
      child: 3.2.1
`,
      "utf8",
    );
    git(dir, ["add", "package.json", "pnpm-workspace.yaml"]);

    expect(collectDependencyPinViolations(dir)).toEqual([]);
  });

  it("rejects floating dependency specs in tracked package manifests", () => {
    const dir = makeRepo();
    mkdirSync(path.join(dir, "extensions", "demo"), { recursive: true });
    writeJson(path.join(dir, "package.json"), {
      dependencies: {
        caret: "^1.2.3",
        tilde: "~1.2.3",
        wildcard: "*",
        tag: "latest",
        broad: ">=1 <2",
        gitFloating: "github:owner/repo#main",
      },
    });
    writeJson(path.join(dir, "extensions", "demo", "package.json"), {
      devDependencies: {
        devCaret: "^4.5.6",
      },
      optionalDependencies: {
        optionalTilde: "~7.8.9",
      },
      peerDependencies: {
        peerCanRange: "^10.0.0",
      },
    });
    git(dir, ["add", "package.json", "extensions/demo/package.json"]);

    expect(collectDependencyPinViolations(dir)).toEqual([
      {
        file: "extensions/demo/package.json",
        section: "devDependencies",
        name: "devCaret",
        spec: "^4.5.6",
      },
      {
        file: "extensions/demo/package.json",
        section: "optionalDependencies",
        name: "optionalTilde",
        spec: "~7.8.9",
      },
      { file: "package.json", section: "dependencies", name: "caret", spec: "^1.2.3" },
      { file: "package.json", section: "dependencies", name: "tilde", spec: "~1.2.3" },
      { file: "package.json", section: "dependencies", name: "wildcard", spec: "*" },
      { file: "package.json", section: "dependencies", name: "tag", spec: "latest" },
      { file: "package.json", section: "dependencies", name: "broad", spec: ">=1 <2" },
      {
        file: "package.json",
        section: "dependencies",
        name: "gitFloating",
        spec: "github:owner/repo#main",
      },
    ]);
  });

  it("rejects floating workspace overrides and package extension dependencies", () => {
    const dir = makeRepo();
    writeJson(path.join(dir, "package.json"), {});
    writeFileSync(
      path.join(dir, "pnpm-workspace.yaml"),
      `overrides:
  exact: 1.2.3
  floating: ^2.0.0
packageExtensions:
  parent@1.0.0:
    dependencies:
      exact-child: 3.2.1
      floating-child: ~4.0.0
`,
      "utf8",
    );
    git(dir, ["add", "package.json", "pnpm-workspace.yaml"]);

    expect(collectDependencyPinViolations(dir)).toEqual([
      {
        file: "pnpm-workspace.yaml",
        section: "overrides",
        name: "floating",
        spec: "^2.0.0",
      },
      {
        file: "pnpm-workspace.yaml",
        section: "packageExtensions.parent@1.0.0.dependencies",
        name: "floating-child",
        spec: "~4.0.0",
      },
    ]);
  });
});
