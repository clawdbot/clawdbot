// Check Dependency Pins tests cover check dependency pins script behavior.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectDependencyPinViolations } from "../../scripts/check-dependency-pins.mts";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];
const itUnix = process.platform === "win32" ? it.skip : it;
const hangingGitTimeoutMs = 1_000;

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

function writeJson(filePath: string, value: unknown) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function stubHangingGit(cwd: string, stalledSubcommand: "ls-files" | "show") {
  const binDir = path.join(cwd, "fake-git-bin");
  mkdirSync(binDir);
  const fixture = `#!/bin/sh
if [ "$1" = ${JSON.stringify(stalledSubcommand)} ]; then
  trap '' TERM
  exec sleep 60
elif [ "$1" = "ls-files" ]; then
  printf 'package.json\\000'
else
  exit 1
fi
`;
  writeFileSync(path.join(binDir, "git"), fixture, { mode: 0o755 });
  vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);
}

function makeRepo() {
  const dir = makeTempRepoRoot(tempDirs, "openclaw-dependency-pins-");
  git(dir, ["init", "-q", "--initial-branch=main"]);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
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
        gitPinnedPath:
          "github:owner/repo#0123456789abcdef0123456789abcdef01234567&path:packages/pkg",
        tarballPinned:
          "https://codeload.github.com/owner/repo/tar.gz/0123456789abcdef0123456789abcdef01234567",
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
  parent>unused-adapter: "-"
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
        malformedSemver: "01.2.3",
        gitFloating: "github:owner/repo#main",
        fragmentlessGitPath:
          "git+https://github.com/owner/repo/commit/0123456789abcdef0123456789abcdef01234567",
        invalidRemoval: "-",
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
        name: "malformedSemver",
        spec: "01.2.3",
      },
      {
        file: "package.json",
        section: "dependencies",
        name: "gitFloating",
        spec: "github:owner/repo#main",
      },
      {
        file: "package.json",
        section: "dependencies",
        name: "fragmentlessGitPath",
        spec: "git+https://github.com/owner/repo/commit/0123456789abcdef0123456789abcdef01234567",
      },
      { file: "package.json", section: "dependencies", name: "invalidRemoval", spec: "-" },
    ]);
  });

  it("reads tracked package manifests from the index when sparse checkout omits them", () => {
    const dir = makeRepo();
    mkdirSync(path.join(dir, "qa", "convex-credential-broker"), { recursive: true });
    writeJson(path.join(dir, "package.json"), {});
    writeJson(path.join(dir, "qa", "convex-credential-broker", "package.json"), {
      dependencies: {
        exact: "1.2.3",
      },
    });
    git(dir, ["add", "package.json", "qa/convex-credential-broker/package.json"]);
    rmSync(path.join(dir, "qa"), { recursive: true, force: true });

    expect(collectDependencyPinViolations(dir)).toEqual([]);
  });

  itUnix("terminates a SIGTERM-resistant git ls-files at the dependency-pin timeout", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-dependency-pins-ls-files-timeout-");
    stubHangingGit(dir, "ls-files");

    expect(() =>
      collectDependencyPinViolations(dir, { gitTimeoutMs: hangingGitTimeoutMs }),
    ).toThrow(
      `dependency pin guard: git ls-files -z -- *package.json timed out after ${hangingGitTimeoutMs}ms.`,
    );
  });

  itUnix(
    "terminates a SIGTERM-resistant sparse-index git show at the dependency-pin timeout",
    () => {
      const dir = makeRepo();
      writeJson(path.join(dir, "package.json"), {});
      git(dir, ["add", "package.json"]);
      rmSync(path.join(dir, "package.json"));
      stubHangingGit(dir, "show");

      expect(() =>
        collectDependencyPinViolations(dir, { gitTimeoutMs: hangingGitTimeoutMs }),
      ).toThrow(
        `dependency pin guard: git show :package.json timed out after ${hangingGitTimeoutMs}ms.`,
      );
    },
  );

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
