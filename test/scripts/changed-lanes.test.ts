// Changed Lanes tests cover changed lanes script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEmptyChangedLanes,
  detectChangedLanes,
  isChangedLaneTestPath,
  isLiveDockerPackageScriptOnlyChange,
  isPackageScriptOnlyChange,
  listChangedPathsFromGit,
  listStagedChangedPaths,
} from "../../scripts/changed-lanes.mjs";
import {
  buildChangedCheckCrabboxArgs,
  cleanupCorepackPnpmShimDir,
  createChangedCheckChildEnv,
  createChangedCheckPlan,
  createPnpmManagedCommand,
  createTargetedCoreLintCommand,
  createTargetedExtensionLintCommand,
  createTargetedScriptLintCommand,
  shouldDelegateChangedCheckToCrabbox,
  shouldRunAppcastOwnerTest,
  shouldRunCanvasA2uiNativeResourceCheck,
  shouldRunPromptSnapshotCheck,
  shouldRunPromptSnapshotOwnerTest,
  shouldRunRuntimeSidecarBaselineCheck,
  shouldRunShrinkwrapGuard,
  shouldRunPluginSdkApiBaselineCheck,
  shouldRunPluginSdkSurfaceChecks,
  shouldRunSqliteSessionSchemaBaselineCheck,
  shouldRunTestTempCreationReport,
  createShrinkwrapGuardCommand,
} from "../../scripts/check-changed.mjs";
import { resolveOxfmtInvocation } from "../../scripts/format-docs.mjs";
import { isDirectRunPath } from "../../scripts/lib/direct-run.mjs";
import { cleanupTempDirs, makeTempRepoRoot } from "../helpers/temp-repo.js";

const tempDirs: string[] = [];
const repoRoot = process.cwd();
type ExecFileSyncFailure = Error & { status?: number | null; stderr?: Buffer };
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

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: createNestedGitEnv(),
  }).trim();

function expectLanes(
  lanes: ReturnType<typeof createEmptyChangedLanes>,
  expected: Partial<ReturnType<typeof createEmptyChangedLanes>>,
) {
  expect(lanes).toEqual({ ...createEmptyChangedLanes(), ...expected });
}

function parseChangedLaneOutput(output: string): {
  paths: string[];
  lanes: ReturnType<typeof createEmptyChangedLanes>;
} {
  return JSON.parse(output) as {
    paths: string[];
    lanes: ReturnType<typeof createEmptyChangedLanes>;
  };
}

function writeRepoFile(repoDir: string, filePath: string, contents: string): void {
  const absolutePath = path.join(repoDir, filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, "utf8");
}

// Executes the exact "format changed files" plan command with the repo-pinned oxfmt,
// reconstructing `pnpm format:check <plan args>`. Guards the runtime verdict, not just
// plan construction: a misformatted added file must fail, deleted paths must not.
function runChangedFormatLaneWithRepoOxfmt(cwd: string, changedPaths: string[]) {
  const plan = createChangedCheckPlan(detectChangedLanes(changedPaths));
  const formatCommand = plan.commands.find((command) => command.name === "format changed files");
  expect(formatCommand?.args[0]).toBe("format:check");
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const [scriptBin, ...scriptArgs] = packageJson.scripts["format:check"].split(" ");
  expect(scriptBin).toBe("oxfmt");
  const invocation = resolveOxfmtInvocation(
    [...scriptArgs, ...(formatCommand?.args.slice(1) ?? [])],
    { repoRoot },
  );
  return spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    shell: invocation.shell,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

function createSyntheticMergeRepo(prefix: string): { dir: string; staleBase: string } {
  const dir = makeTempRepoRoot(tempDirs, prefix);
  git(dir, ["init", "-q", "--initial-branch=main"]);
  writeRepoFile(dir, "README.md", "base\n");
  git(dir, ["add", "."]);
  git(dir, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test User",
    "commit",
    "-q",
    "-m",
    "base",
  ]);
  const staleBase = git(dir, ["rev-parse", "HEAD"]);

  git(dir, ["switch", "-q", "-c", "feature"]);
  writeRepoFile(dir, "src/pr.ts", "export const pr = true;\n");
  git(dir, ["add", "."]);
  git(dir, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test User",
    "commit",
    "-q",
    "-m",
    "feature",
  ]);

  git(dir, ["switch", "-q", "main"]);
  writeRepoFile(dir, "src/main-only.ts", "export const mainOnly = true;\n");
  git(dir, ["add", "."]);
  git(dir, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test User",
    "commit",
    "-q",
    "-m",
    "main only",
  ]);
  git(dir, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test User",
    "merge",
    "--no-ff",
    "feature",
    "-m",
    "synthetic merge",
  ]);

  return { dir, staleBase };
}

afterEach(() => {
  cleanupCorepackPnpmShimDir();
  cleanupTempDirs(tempDirs);
});

describe("scripts/changed-lanes", () => {
  it("keeps a non-executed changed-gate warning fixture", () => {
    // openclaw-temp-dir: allow test fixture for the temp warning report
    const warningFixture = 'fs.mkdtemp("openclaw-warning-fixture-", () => {})';

    expect(warningFixture).toContain("mkdtemp");
  });

  it("detects direct script execution from Windows argv paths", () => {
    expect(
      isDirectRunPath(
        "C:\\repo\\scripts\\check-changed.mjs",
        "c:\\repo\\scripts\\check-changed.mjs",
        "win32",
      ),
    ).toBe(true);
    expect(
      isDirectRunPath(
        "C:\\repo\\scripts\\changed-lanes.mjs",
        "C:\\repo\\scripts\\check-changed.mjs",
        "win32",
      ),
    ).toBe(false);
  });

  it("prints changed lane help without treating --help as a changed path", () => {
    const result = spawnSync(process.execPath, ["scripts/changed-lanes.mjs", "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: createNestedGitEnv(),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node scripts/changed-lanes.mjs");
    expect(result.stdout).not.toContain("--help: unknown surface");
  });

  it("prints changed check help without running the changed gate", () => {
    const result = spawnSync(process.execPath, ["scripts/check-changed.mjs", "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...createNestedGitEnv(), OPENCLAW_TESTBOX: "1" },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node scripts/check-changed.mjs");
    expect(result.stdout).not.toContain("[check:changed]");
  });

  it("rejects unknown changed lane options before treating them as paths", () => {
    const result = spawnSync(process.execPath, ["scripts/changed-lanes.mjs", "--jsno"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: createNestedGitEnv(),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown option: --jsno");
    expect(result.stderr).not.toContain("\n    at ");
  });

  it("rejects unknown changed check options before treating them as paths", () => {
    const result = spawnSync(process.execPath, ["scripts/check-changed.mjs", "--dr-run"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...createNestedGitEnv(), OPENCLAW_TESTBOX: "1" },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown option: --dr-run");
    expect(result.stderr).not.toContain("\n    at ");
    expect(result.stderr).not.toContain("[check:changed]");
  });

  it("still accepts dash-prefixed explicit changed paths after the separator", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/changed-lanes.mjs", "--json", "--", "--github-output"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: createNestedGitEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseChangedLaneOutput(result.stdout).paths).toEqual(["--github-output"]);
  });

  it("keeps changed check option-shaped paths intact after the separator", () => {
    const args = buildChangedCheckCrabboxArgs(["--staged", "--", "--no-changes"], {
      cwd: repoRoot,
    });

    expect(args.slice(args.indexOf("check:changed") + 1)).toEqual([
      "--staged",
      "--",
      "--no-changes",
    ]);
  });

  it("prints changed check dry-run commands", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/check-changed.mjs", "--dry-run", "--", "extensions/lmstudio/src/api.ts"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: createNestedGitEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[check:changed:dry-run] lanes=extensions, extensionTests");
    expect(result.stderr).toContain(
      "[check:changed:dry-run] would run: node scripts/run-oxlint.mjs --tsconfig config/tsconfig/oxlint.extensions.json extensions/lmstudio/src/api.ts",
    );
  });

  it("includes untracked worktree files in the default local diff", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    git(dir, ["add", "README.md"]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "-m",
      "initial",
    ]);

    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    writeFileSync(path.join(dir, "scripts", "new-check.mjs"), "export {};\n", "utf8");

    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "changed-lanes.mjs"), "--json", "--base", "HEAD"],
      {
        cwd: dir,
        encoding: "utf8",
        env: createNestedGitEnv(),
      },
    );

    const result = parseChangedLaneOutput(output);

    expect(result.paths).toEqual(["scripts/new-check.mjs"]);
    expectLanes(result.lanes, { tooling: true });
  });

  it("falls back to a two-dot diff when a delegated checkout has no merge base", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-no-merge-base-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    git(dir, ["add", "README.md"]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "-m",
      "initial",
    ]);
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(dir, ["switch", "-q", "--orphan", "feature"]);
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "committed.ts"), "export const committed = 1;\n", "utf8");
    git(dir, ["add", "README.md", "src/committed.ts"]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "-m",
      "feature base",
    ]);
    writeFileSync(path.join(dir, "src", "feature.ts"), "export const value = 1;\n", "utf8");

    expect(
      listChangedPathsFromGit({ base: "origin/main", cwd: dir, includeWorktree: false }),
    ).toEqual(["src/committed.ts"]);
    expect(listChangedPathsFromGit({ base: "origin/main", cwd: dir })).toEqual([
      "src/committed.ts",
      "src/feature.ts",
    ]);
  });

  it("prefers raw sync worktree paths over an implausibly broad no-merge-base diff", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-raw-sync-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    for (let index = 0; index < 250; index += 1) {
      writeFileSync(path.join(dir, `baseline-${index}.txt`), "baseline\n", "utf8");
    }
    git(dir, ["add", "."]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "-m",
      "initial",
    ]);
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(dir, ["switch", "-q", "--orphan", "feature"]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "raw sync base",
    ]);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "feature.ts"), "export const value = 1;\n", "utf8");

    const previousRawSync = process.env.OPENCLAW_CHANGED_LANES_RAW_SYNC;
    delete process.env.OPENCLAW_CHANGED_LANES_RAW_SYNC;
    try {
      const normalPaths = listChangedPathsFromGit({ base: "origin/main", cwd: dir });
      expect(normalPaths.length).toBeGreaterThan(200);
      expect(normalPaths).toContain("baseline-0.txt");
      expect(normalPaths).toContain("src/feature.ts");

      process.env.OPENCLAW_CHANGED_LANES_RAW_SYNC = "1";
      expect(listChangedPathsFromGit({ base: "origin/main", cwd: dir })).toEqual([
        "src/feature.ts",
      ]);
    } finally {
      if (previousRawSync === undefined) {
        delete process.env.OPENCLAW_CHANGED_LANES_RAW_SYNC;
      } else {
        process.env.OPENCLAW_CHANGED_LANES_RAW_SYNC = previousRawSync;
      }
    }
  });

  it("includes committed and untracked added files in the changed format check", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-added-format-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeRepoFile(dir, "README.md", "initial\n");
    git(dir, ["add", "."]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "-m",
      "initial",
    ]);
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(dir, ["switch", "-q", "-c", "feature"]);
    writeRepoFile(dir, "src/committed.test.ts", "export const committed={value:1};\n");
    git(dir, ["add", "src/committed.test.ts"]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "-m",
      "add test",
    ]);
    writeRepoFile(dir, "src/untracked.test.ts", "export const untracked={value:1};\n");
    writeRepoFile(dir, "--help", "ignored\n");

    const paths = listChangedPathsFromGit({ base: "origin/main", cwd: dir });
    const plan = createChangedCheckPlan(detectChangedLanes(paths));

    expect(paths).toEqual(["--help", "src/committed.test.ts", "src/untracked.test.ts"]);
    expect(plan.commands.find((command) => command.name === "format changed files")).toEqual({
      name: "format changed files",
      args: [
        "format:check",
        "--no-error-on-unmatched-pattern",
        "--",
        "--help",
        "src/committed.test.ts",
        "src/untracked.test.ts",
      ],
    });
  });

  it("includes staged added, modified, and deleted files in the changed format check", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-staged-format-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeRepoFile(dir, "src/modified.ts", "export const modified = { value: 1 };\n");
    writeRepoFile(dir, "src/removed.ts", "export const removed = { value: 1 };\n");
    git(dir, ["add", "."]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "-m",
      "initial",
    ]);
    writeRepoFile(dir, "src/added.test.ts", "export const added={value:1};\n");
    writeRepoFile(dir, "src/modified.ts", "export const modified={value:2};\n");
    git(dir, ["add", "src/added.test.ts", "src/modified.ts"]);
    git(dir, ["rm", "-q", "src/removed.ts"]);

    const paths = listStagedChangedPaths(dir);
    const plan = createChangedCheckPlan(detectChangedLanes(paths));

    expect(paths).toEqual(["src/added.test.ts", "src/modified.ts", "src/removed.ts"]);
    expect(plan.commands.find((command) => command.name === "format changed files")).toEqual({
      name: "format changed files",
      args: [
        "format:check",
        "--no-error-on-unmatched-pattern",
        "--",
        "src/added.test.ts",
        "src/modified.ts",
        "src/removed.ts",
      ],
    });
  });

  it("fails the changed format check on a misformatted added file and passes once formatted", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-format-added-");
    writeRepoFile(dir, "src/added.test.ts", "export const added={value:1};\n");

    const dirty = runChangedFormatLaneWithRepoOxfmt(dir, ["src/added.test.ts"]);
    expect(dirty.status).not.toBe(0);
    expect(`${dirty.stdout}${dirty.stderr}`).toContain("added.test.ts");

    writeRepoFile(dir, "src/added.test.ts", "export const added = { value: 1 };\n");
    const formatted = runChangedFormatLaneWithRepoOxfmt(dir, ["src/added.test.ts"]);
    expect(formatted.status).toBe(0);
  });

  it("fails the changed format check on a misformatted modified file", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-format-modified-");
    writeRepoFile(dir, "src/modified.ts", "export const modified={value:2};\n");

    const result = runChangedFormatLaneWithRepoOxfmt(dir, ["src/modified.ts"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("modified.ts");
  });

  it("does not fail the changed format check for deleted paths", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-format-deleted-");
    writeRepoFile(dir, "src/kept.ts", "export const kept = { value: 1 };\n");

    const result = runChangedFormatLaneWithRepoOxfmt(dir, ["src/deleted.ts", "src/kept.ts"]);
    expect(result.status).toBe(0);
  });

  it("uses the merge commit first parent instead of a stale PR payload base", () => {
    const { dir, staleBase } = createSyntheticMergeRepo("openclaw-changed-lanes-merge-");

    expect(listChangedPathsFromGit({ base: staleBase, cwd: dir, includeWorktree: false })).toEqual([
      "src/main-only.ts",
      "src/pr.ts",
    ]);
    expect(
      listChangedPathsFromGit({
        base: staleBase,
        cwd: dir,
        includeWorktree: false,
        mergeHeadFirstParent: true,
      }),
    ).toEqual(["src/pr.ts"]);
  });

  it("ignores local Crabbox metadata in the default local diff", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-crabbox-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(dir, ".gitignore"), ".crabbox/\n", "utf8");
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    git(dir, ["add", ".gitignore", "README.md"]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "-m",
      "initial",
    ]);

    mkdirSync(path.join(dir, ".crabbox"), { recursive: true });
    writeFileSync(path.join(dir, ".crabbox", "capture-files.txt"), "stdout.log\n", "utf8");
    writeFileSync(path.join(dir, ".crabbox", "capture-manifest.txt"), "stdout.log\t12\n", "utf8");

    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "changed-lanes.mjs"), "--json", "--base", "HEAD"],
      {
        cwd: dir,
        encoding: "utf8",
        env: createNestedGitEnv(),
      },
    );

    const result = parseChangedLaneOutput(output);

    expect(result.paths).toEqual([]);
    expectLanes(result.lanes, {});
  });

  it("includes deleted worktree files in the default local diff", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-deleted-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    mkdirSync(path.join(dir, "src", "shared"), { recursive: true });
    writeFileSync(
      path.join(dir, "src", "shared", "obsolete.ts"),
      "export const value = 1;\n",
      "utf8",
    );
    git(dir, ["add", "src/shared/obsolete.ts"]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "-m",
      "initial",
    ]);

    unlinkSync(path.join(dir, "src", "shared", "obsolete.ts"));

    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "changed-lanes.mjs"), "--json", "--base", "HEAD"],
      {
        cwd: dir,
        encoding: "utf8",
        env: createNestedGitEnv(),
      },
    );

    const result = parseChangedLaneOutput(output);

    expect(result.paths).toEqual(["src/shared/obsolete.ts"]);
    expectLanes(result.lanes, { core: true, coreTests: true });
  });

  it("includes deleted staged files in the staged diff", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-staged-deleted-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    mkdirSync(path.join(dir, "src", "shared"), { recursive: true });
    writeFileSync(
      path.join(dir, "src", "shared", "obsolete.ts"),
      "export const value = 1;\n",
      "utf8",
    );
    git(dir, ["add", "src/shared/obsolete.ts"]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "-m",
      "initial",
    ]);

    unlinkSync(path.join(dir, "src", "shared", "obsolete.ts"));
    git(dir, ["add", "src/shared/obsolete.ts"]);

    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "changed-lanes.mjs"), "--json", "--staged"],
      {
        cwd: dir,
        encoding: "utf8",
        env: createNestedGitEnv(),
      },
    );

    const result = parseChangedLaneOutput(output);

    expect(result.paths).toEqual(["src/shared/obsolete.ts"]);
    expectLanes(result.lanes, { core: true, coreTests: true });
  });

  it("ignores the explicit path separator", () => {
    const result = detectChangedLanes(["--", "scripts/test-live-acp-bind-docker.sh"]);

    expect(result.paths).toEqual(["scripts/test-live-acp-bind-docker.sh"]);
    expect(result.lanes.liveDockerTooling).toBe(true);
    expect(result.lanes.all).toBe(false);
  });

  it("routes a subagent-announce-only Docker diff through the live Docker lane", () => {
    const result = detectChangedLanes(["scripts/test-live-subagent-announce-docker.sh"]);

    expectLanes(result.lanes, { liveDockerTooling: true });
  });

  it("exposes the shared changed-lane test path classifier", () => {
    expect(isChangedLaneTestPath("src/shared/string-normalization.test.ts")).toBe(true);
    expect(isChangedLaneTestPath("packages/foo/__tests__/helper.ts")).toBe(true);
    expect(isChangedLaneTestPath("src/example.ts")).toBe(false);
    expect(isChangedLaneTestPath("src/latest.ts")).toBe(false);
  });

  it("routes core production changes to core prod and core test lanes", () => {
    const result = detectChangedLanes(["packages/normalization-core/src/string-normalization.ts"]);
    const plan = createChangedCheckPlan(result, { env: { PATH: "/usr/bin" } });

    expectLanes(result.lanes, {
      core: true,
      coreTests: true,
      strictRatchet: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain(
      "check:database-first-legacy-stores",
    );
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:core");
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:core:test");
    expect(plan.commands.find((command) => command.args[0] === "tsgo:core")?.env).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_SPARSE_SKIP: "1",
    });
    expect(plan.commands.find((command) => command.name === "lint core changed file")).toEqual({
      name: "lint core changed file",
      bin: "node",
      args: [
        "scripts/run-oxlint.mjs",
        "--tsconfig",
        "config/tsconfig/oxlint.core.json",
        "packages/normalization-core/src/string-normalization.ts",
      ],
      env: {
        PATH: "/usr/bin",
        OPENCLAW_OXLINT_SKIP_LOCK: "1",
        OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
        OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
      },
    });
  });

  it("routes UI production changes to UI prod and core test lanes", () => {
    const result = detectChangedLanes(["ui/src/app.ts"]);
    const plan = createChangedCheckPlan(result, { env: { PATH: "/usr/bin" } });

    expectLanes(result.lanes, {
      coreTests: true,
      ui: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:ui");
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:core:test");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:core");
  });

  it("routes the UI production config to UI prod and core test lanes", () => {
    const result = detectChangedLanes(["tsconfig.ui.json"]);
    const plan = createChangedCheckPlan(result, { env: { PATH: "/usr/bin" } });

    expectLanes(result.lanes, {
      coreTests: true,
      ui: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:ui");
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:core:test");
  });

  it.each([
    "scripts/control-ui-i18n.ts",
    "scripts/lib/example.ts",
    "scripts/lib/example.d.mts",
    "tsconfig.scripts.json",
  ])("routes %s to the scripts typecheck lane", (changedPath) => {
    const result = detectChangedLanes([changedPath]);
    const plan = createChangedCheckPlan(result);

    expect(result.lanes.scripts).toBe(true);
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:scripts");
  });

  it.each([
    ["test/vitest/foo.config.ts", true, true],
    ["test/vitest/vitest-runtime-helper.d.mts", true, true],
    ["test/fixtures/foo.ts", false, true],
    ["test/foo.mjs", false, true],
    ["test/tsconfig/tsconfig.test.root.json", true, true],
  ])(
    "routes %s to testRoot=%s and tooling=%s",
    (changedPath, expectedTestRoot, expectedTooling) => {
      const result = detectChangedLanes([changedPath]);
      const plan = createChangedCheckPlan(result);

      expect(result.lanes.testRoot).toBe(expectedTestRoot);
      expect(result.lanes.tooling).toBe(expectedTooling);
      expect(plan.commands.map((command) => command.args[0]).includes("tsgo:test:root")).toBe(
        expectedTestRoot,
      );
    },
  );

  it("falls back to full core lint for broad core diffs", () => {
    const targets = Array.from({ length: 9 }, (_, index) => `src/shared/file-${index}.ts`);
    const command = createTargetedCoreLintCommand(targets, { PATH: "/usr/bin" });

    expect(command).toBeNull();
  });

  it("falls back to full extension lint for broad extension diffs", () => {
    const targets = Array.from(
      { length: 9 },
      (_, index) => `extensions/discord/src/file-${index}.ts`,
    );
    const command = createTargetedExtensionLintCommand(targets, { PATH: "/usr/bin" });

    expect(command).toBeNull();
  });

  it("falls back to full core lint when a changed core target was deleted", () => {
    expect(
      createTargetedCoreLintCommand(
        ["src/shared/deleted.ts"],
        { PATH: "/usr/bin" },
        {
          fileExists: () => false,
        },
      ),
    ).toBeNull();
  });

  it("falls back to full core lint for mixed core lint configuration diffs", () => {
    expect(
      createTargetedCoreLintCommand(
        [
          "config/tsconfig/oxlint.core.json",
          "packages/normalization-core/src/string-normalization.ts",
        ],
        { PATH: "/usr/bin" },
        { fileExists: () => true },
      ),
    ).toBeNull();
  });

  it("targets small core lint diffs", () => {
    expect(
      createTargetedCoreLintCommand(
        [
          ".github/workflows/ci.yml",
          "scripts/check-changed.mjs",
          "src/agents/auth-profiles/usage.ts",
          "test/scripts/changed-lanes.test.ts",
        ],
        { PATH: "/usr/bin" },
        { fileExists: () => true },
      ),
    ).toEqual({
      name: "lint core changed file",
      bin: "node",
      args: [
        "scripts/run-oxlint.mjs",
        "--tsconfig",
        "config/tsconfig/oxlint.core.json",
        "src/agents/auth-profiles/usage.ts",
      ],
      env: {
        PATH: "/usr/bin",
      },
    });
  });

  it("targets small extension lint diffs", () => {
    expect(
      createTargetedExtensionLintCommand(
        ["extensions/lmstudio/src/api.ts", "docs/help/testing.md"],
        { PATH: "/usr/bin" },
        { fileExists: () => true },
      ),
    ).toEqual({
      name: "lint extension changed file",
      bin: "node",
      args: [
        "scripts/run-oxlint.mjs",
        "--tsconfig",
        "config/tsconfig/oxlint.extensions.json",
        "extensions/lmstudio/src/api.ts",
      ],
      env: {
        PATH: "/usr/bin",
      },
    });
  });

  it("targets small script lint diffs", () => {
    expect(
      createTargetedScriptLintCommand(
        ["scripts/check-changed.mjs", "test/scripts/changed-lanes.test.ts"],
        { PATH: "/usr/bin" },
        { fileExists: () => true },
      ),
    ).toEqual({
      name: "lint script changed file",
      bin: "node",
      args: [
        "scripts/run-oxlint.mjs",
        "--tsconfig",
        "config/tsconfig/oxlint.scripts.json",
        "scripts/check-changed.mjs",
      ],
      env: {
        PATH: "/usr/bin",
      },
    });
  });

  it("reenables local-check policy for changed typecheck commands", () => {
    const result = detectChangedLanes(["packages/normalization-core/src/string-normalization.ts"]);
    const plan = createChangedCheckPlan(result, {
      env: { OPENCLAW_LOCAL_CHECK: "0", PATH: "/usr/bin" },
    });

    expect(plan.commands.find((command) => command.args[0] === "tsgo:core")?.env).toEqual({
      OPENCLAW_LOCAL_CHECK: "1",
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_SPARSE_SKIP: "1",
      PATH: "/usr/bin",
    });
  });

  it("marks changed-check children as covered by the parent heavy-check lock", () => {
    expect(createChangedCheckChildEnv({ PATH: "/usr/bin" })).toEqual({
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
      PATH: "/usr/bin",
    });
  });

  it("runs CI changed-check children through Corepack pnpm", () => {
    const command = createPnpmManagedCommand(
      { name: "conflict markers", args: ["check:no-conflict-markers"] },
      { CI: "1", PATH: "/usr/bin" },
    );

    expect(command.bin).toBe("corepack");
    expect(command.args).toEqual(["pnpm", "check:no-conflict-markers"]);
  });

  it("cleans CI Corepack pnpm shim temp dirs", () => {
    const command = createPnpmManagedCommand(
      { name: "conflict markers", args: ["check:no-conflict-markers"] },
      { CI: "1", PATH: "/usr/bin" },
    );
    const [shimDir] = (command.env?.PATH ?? "").split(path.delimiter);

    expect(path.basename(shimDir)).toMatch(/^openclaw-corepack-pnpm-/u);
    expect(existsSync(path.join(shimDir, "pnpm"))).toBe(true);

    cleanupCorepackPnpmShimDir();

    expect(existsSync(shimDir)).toBe(false);
  });

  it("keeps local changed-check children on the repo pnpm shim", () => {
    const command = createPnpmManagedCommand(
      { name: "conflict markers", args: ["check:no-conflict-markers"] },
      { PATH: "/usr/bin" },
    );

    expect(command.bin).toBe("pnpm");
    expect(command.args).toEqual(["check:no-conflict-markers"]);
  });

  it("delegates local changed gates to Crabbox before running locally", () => {
    expect(
      shouldDelegateChangedCheckToCrabbox(["--base", "origin/main"], {
        PATH: "/usr/bin",
      }),
    ).toBe(true);

    expect(buildChangedCheckCrabboxArgs(["--base", "origin/main", "--head", "HEAD"])).toEqual([
      "crabbox:run",
      "--",
      "--provider",
      "blacksmith-testbox",
      "--blacksmith-org",
      "openclaw",
      "--blacksmith-workflow",
      ".github/workflows/ci-check-testbox.yml",
      "--blacksmith-job",
      "check",
      "--blacksmith-ref",
      "main",
      "--idle-timeout",
      "90m",
      "--ttl",
      "240m",
      "--timing-json",
      "--",
      "env",
      "OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1",
      "OPENCLAW_CHANGED_LANES_RAW_SYNC=1",
      "CI=1",
      "PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false",
      "corepack",
      "pnpm",
      "check:changed",
      "--base",
      "origin/main",
      "--head",
      "HEAD",
    ]);
  });

  it("delegates staged changed gates as explicit remote paths", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-check-changed-staged-delegate-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    git(dir, ["add", "README.md"]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "-m",
      "initial",
    ]);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "staged.ts"), "export const staged = 1;\n", "utf8");
    git(dir, ["add", "src/staged.ts"]);

    const args = buildChangedCheckCrabboxArgs(["--staged", "--timed"], { cwd: dir });
    expect(args.slice(args.indexOf("check:changed") + 1)).toEqual([
      "--timed",
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--",
      "src/staged.ts",
    ]);
  });

  it("delegates empty staged changed gates without rediscovering unstaged paths", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-check-changed-empty-staged-delegate-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    git(dir, ["add", "README.md"]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "-m",
      "initial",
    ]);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "unstaged.ts"), "export const unstaged = 1;\n", "utf8");

    const args = buildChangedCheckCrabboxArgs(["--staged", "--timed"], { cwd: dir });

    expect(args.slice(args.indexOf("check:changed") + 1)).toEqual(["--timed", "--no-changes"]);
  });

  it("does not delegate dry-run, CI, or remote-child changed gates", () => {
    expect(shouldDelegateChangedCheckToCrabbox(["--dry-run"], {})).toBe(false);
    expect(shouldDelegateChangedCheckToCrabbox([], { GITHUB_ACTIONS: "true" })).toBe(false);
    expect(shouldDelegateChangedCheckToCrabbox([], { CI: "1" })).toBe(false);
    expect(
      shouldDelegateChangedCheckToCrabbox([], { OPENCLAW_CHECK_CHANGED_REMOTE_CHILD: "1" }),
    ).toBe(false);
  });

  it("runs changed-check lint lanes under the parent heavy-check lock", () => {
    const result = detectChangedLanes(["extensions/lmstudio/src/api.ts"]);
    const plan = createChangedCheckPlan(result, { env: { PATH: "/usr/bin" } });
    const lintCommand = plan.commands.find(
      (command) => command.name === "lint extension changed file",
    );

    expect(lintCommand?.env).toEqual({
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
      PATH: "/usr/bin",
    });
  });

  it("runs changed-check app tests under the parent heavy-check lock", () => {
    const result = detectChangedLanes([
      "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift",
    ]);
    const plan = createChangedCheckPlan(result, { env: { PATH: "/usr/bin" } });
    const testCommand = plan.commands.find((command) => command.args[0] === "test:macos:ci");

    expect(testCommand?.env).toEqual({
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
      PATH: "/usr/bin",
    });
  });

  it("routes core test-only changes to core test lanes only", () => {
    const result = detectChangedLanes([
      "packages/normalization-core/src/string-normalization.test.ts",
    ]);

    expectLanes(result.lanes, {
      coreTests: true,
      strictRatchet: true,
    });
    expect(createChangedCheckPlan(result).commands.map((command) => command.args[0])).toContain(
      "tsgo:core:test",
    );
    expect(createChangedCheckPlan(result).commands.map((command) => command.args[0])).not.toContain(
      "tsgo:core",
    );
  });

  it("routes extension production changes to extension prod and extension test lanes", () => {
    const result = detectChangedLanes(["extensions/lmstudio/src/api.ts"]);

    expectLanes(result.lanes, {
      extensions: true,
      extensionTests: true,
    });
    expect(createChangedCheckPlan(result).commands.map((command) => command.args[0])).toContain(
      "tsgo:extensions",
    );
    expect(createChangedCheckPlan(result).commands.map((command) => command.args[0])).toContain(
      "tsgo:extensions:test",
    );
  });

  it("routes extension test-only changes to extension test lanes only", () => {
    const result = detectChangedLanes(["extensions/discord/src/index.test.ts"]);

    expectLanes(result.lanes, {
      extensionTests: true,
    });
    expect(createChangedCheckPlan(result).commands.map((command) => command.args[0])).toContain(
      "tsgo:extensions:test",
    );
    expect(createChangedCheckPlan(result).commands.map((command) => command.args[0])).not.toContain(
      "tsgo:extensions",
    );
  });

  it("expands public core/plugin contracts to extension validation", () => {
    const result = detectChangedLanes(["src/plugin-sdk/core.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(result.extensionImpactFromCore).toBe(true);
    expectLanes(result.lanes, {
      core: true,
      coreTests: true,
      extensions: true,
      extensionTests: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:core");
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:extensions:test");
  });

  it("fails safe for root config changes", () => {
    const result = detectChangedLanes(["pnpm-lock.yaml"]);
    const plan = createChangedCheckPlan(result);

    expect(result.lanes.all).toBe(true);
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:all");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("routes gitignore changes to tooling instead of all lanes", () => {
    const result = detectChangedLanes([".gitignore"]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      tooling: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("routes root hygiene config changes to tooling instead of all lanes", () => {
    const result = detectChangedLanes([
      ".dockerignore",
      ".jscpd.json",
      ".npmignore",
      ".pre-commit-config.yaml",
      ".swiftformat",
      ".swiftlint.yml",
      "Makefile",
      "config/knip.config.ts",
      "config/markdownlint-cli2.jsonc",
      "config/shellcheckrc",
      "config/swiftformat",
      "config/swiftlint.yml",
      "deploy/fly.private.toml",
      "docker-setup.sh",
      "openclaw.podman.env",
      "setup-podman.sh",
      "skills/pyproject.toml",
    ]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      tooling: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("routes VS Code workspace settings to tooling instead of all lanes", () => {
    const result = detectChangedLanes([".vscode/settings.json", ".vscode/extensions.json"]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      tooling: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("routes legacy root sandbox Dockerfile moves to tooling instead of all lanes", () => {
    const result = detectChangedLanes([
      "Dockerfile.sandbox",
      "Dockerfile.sandbox-browser",
      "Dockerfile.sandbox-common",
      "scripts/docker/sandbox/Dockerfile",
      "scripts/docker/sandbox/Dockerfile.browser",
      "scripts/docker/sandbox/Dockerfile.common",
    ]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      tooling: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("routes live Docker ACP tooling changes through a focused gate", () => {
    const result = detectChangedLanes([
      "scripts/lib/live-docker-auth.sh",
      "scripts/test-docker-all.mjs",
      "scripts/test-live-acp-bind-docker.sh",
      "src/gateway/gateway-acp-bind.live.test.ts",
      "docs/help/testing-live.md",
    ]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      docs: true,
      liveDockerTooling: true,
    });
    expect(plan.commands.map((command) => command.name)).toEqual([
      "conflict markers",
      "changelog attributions",
      "guarded extension wildcard re-exports",
      "plugin-sdk wildcard re-exports",
      "duplicate scan target coverage",
      "dependency pin guard",
      "format changed files",
      "package patch guard",
      "test temp creation report (warning-only)",
      "typecheck core tests",
      "lint core",
      "lint scripts",
      "live Docker shell syntax",
      "live Docker scheduler dry run",
    ]);
    expect(plan.commands.find((command) => command.name === "live Docker shell syntax")).toEqual({
      name: "live Docker shell syntax",
      bin: "bash",
      args: [
        "-n",
        "scripts/lib/live-docker-auth.sh",
        "scripts/test-live-acp-bind-docker.sh",
        "scripts/test-live-cli-backend-docker.sh",
        "scripts/test-live-codex-harness-docker.sh",
        "scripts/test-live-gateway-models-docker.sh",
        "scripts/test-live-models-docker.sh",
        "scripts/test-live-subagent-announce-docker.sh",
      ],
    });
    const schedulerDryRun = plan.commands.find(
      (command) => command.name === "live Docker scheduler dry run",
    );
    expect(schedulerDryRun?.bin).toBe("node");
    expect(schedulerDryRun?.args).toEqual(["scripts/test-docker-all.mjs"]);
    expect(schedulerDryRun?.env?.OPENCLAW_DOCKER_ALL_DRY_RUN).toBe("1");
    expect(schedulerDryRun?.env?.OPENCLAW_DOCKER_ALL_LIVE_MODE).toBe("only");
  });

  it("routes live Docker package script-only changes through the focused gate", () => {
    const before = `${JSON.stringify(
      {
        name: "fixture",
        scripts: {
          "test:docker:all": "node scripts/test-docker-all.mjs",
        },
        dependencies: {
          leftpad: "1.0.0",
        },
      },
      null,
      2,
    )}\n`;
    const after = `${JSON.stringify(
      {
        name: "fixture",
        scripts: {
          "test:docker:all": "node scripts/test-docker-all.mjs",
          "test:docker:live-acp-bind:droid":
            "OPENCLAW_LIVE_ACP_BIND_AGENT=droid bash scripts/test-live-acp-bind-docker.sh",
        },
        dependencies: {
          leftpad: "1.0.0",
        },
      },
      null,
      2,
    )}\n`;

    expect(isLiveDockerPackageScriptOnlyChange(before, after)).toBe(true);

    const result = detectChangedLanes(["package.json"], {
      packageJsonChangeKind: "liveDockerTooling",
    });
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      liveDockerTooling: true,
    });
    expect(plan.commands.map((command) => command.name)).toContain("live Docker scheduler dry run");
  });

  it("classifies live Docker package script changes from the git diff", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-live-docker-package-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify(
        {
          name: "fixture",
          scripts: {
            "test:docker:all": "node scripts/test-docker-all.mjs",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    git(dir, ["add", "package.json"]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "-m",
      "initial",
    ]);

    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify(
        {
          name: "fixture",
          scripts: {
            "test:docker:all": "node scripts/test-docker-all.mjs",
            "test:docker:live-acp-bind:droid":
              "OPENCLAW_LIVE_ACP_BIND_AGENT=droid bash scripts/test-live-acp-bind-docker.sh",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "changed-lanes.mjs"), "--json", "--base", "HEAD"],
      {
        cwd: dir,
        encoding: "utf8",
        env: createNestedGitEnv(),
      },
    );

    const result = parseChangedLaneOutput(output);

    expect(result.paths).toEqual(["package.json"]);
    expectLanes(result.lanes, { liveDockerTooling: true });
  });

  it("classifies normal package script changes from the git diff", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-package-scripts-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify(
        {
          name: "fixture",
          scripts: {
            test: "node scripts/test-projects.mjs",
          },
          dependencies: {
            leftpad: "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    git(dir, ["add", "package.json"]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "-m",
      "initial",
    ]);

    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify(
        {
          name: "fixture",
          scripts: {
            test: "node scripts/test-projects.mjs",
            "test:profile": "node scripts/profile-tests.mjs",
          },
          dependencies: {
            leftpad: "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "changed-lanes.mjs"), "--json", "--base", "HEAD"],
      {
        cwd: dir,
        encoding: "utf8",
        env: createNestedGitEnv(),
      },
    );

    const result = parseChangedLaneOutput(output);

    expect(result.paths).toEqual(["package.json"]);
    expectLanes(result.lanes, { tooling: true });
  });

  it("keeps non-script package changes off the live Docker focused gate", () => {
    const before = `${JSON.stringify(
      { name: "fixture", scripts: {}, dependencies: { leftpad: "1.0.0" } },
      null,
      2,
    )}\n`;
    const after = `${JSON.stringify(
      {
        name: "fixture",
        scripts: {
          "test:docker:live-acp-bind:droid":
            "OPENCLAW_LIVE_ACP_BIND_AGENT=droid bash scripts/test-live-acp-bind-docker.sh",
        },
        dependencies: { leftpad: "1.0.1" },
      },
      null,
      2,
    )}\n`;

    expect(isLiveDockerPackageScriptOnlyChange(before, after)).toBe(false);
  });

  it("routes package script-only changes through the tooling gate", () => {
    const before = `${JSON.stringify(
      { name: "fixture", scripts: { test: "node test.js" }, dependencies: { leftpad: "1.0.0" } },
      null,
      2,
    )}\n`;
    const after = `${JSON.stringify(
      {
        name: "fixture",
        scripts: {
          test: "node test.js",
          "test:profile": "node scripts/profile-tests.mjs",
        },
        dependencies: { leftpad: "1.0.0" },
      },
      null,
      2,
    )}\n`;

    expect(isPackageScriptOnlyChange(before, after)).toBe(true);

    const result = detectChangedLanes(["package.json"], {
      packageJsonChangeKind: "tooling",
    });
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      tooling: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
  });

  it("keeps release metadata commits off the full changed gate", () => {
    const result = detectChangedLanes([
      "CHANGELOG.md",
      "apps/android/CHANGELOG.md",
      "apps/android/Config/Version.properties",
      "apps/android/fastlane/metadata/android/en-US/release_notes.txt",
      "apps/android/version.json",
      "apps/ios/CHANGELOG.md",
      "apps/macos/Sources/OpenClaw/Resources/Info.plist",
      "docs/.generated/config-baseline.sha256",
      "package.json",
    ]);
    const plan = createChangedCheckPlan(result, { staged: true });

    expectLanes(result.lanes, {
      docs: true,
      releaseMetadata: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toEqual([
      "check:no-conflict-markers",
      "check:changelog-attributions",
      "lint:extensions:no-guarded-wildcard-reexports",
      "lint:extensions:no-plugin-sdk-wildcard-reexports",
      "dup:check:coverage",
      "deps:pins:check",
      "format:check",
      "scripts/generate-npm-shrinkwrap.mjs",
      "deps:patches:check",
      "release-metadata:check",
      "android:version:check",
      "ios:version:check",
      "config:schema:check",
      "config:docs:check",
      "deps:root-ownership:check",
    ]);
    expect(
      plan.commands.find((command) => command.args[0] === "release-metadata:check")?.args,
    ).toEqual(["release-metadata:check", "--staged"]);
  });

  it("passes release metadata base and head refs as options", () => {
    const result = detectChangedLanes(["CHANGELOG.md"]);
    const plan = createChangedCheckPlan(result, { base: "main", head: "feature" });

    expect(
      plan.commands.find((command) => command.args[0] === "release-metadata:check")?.args,
    ).toEqual(["release-metadata:check", "--base", "main", "--head", "feature"]);
  });

  it("keeps docs plus changelog entries on the docs-only changed gate", () => {
    const result = detectChangedLanes(["CHANGELOG.md", "docs/tools/index.md"]);
    const plan = createChangedCheckPlan(result);

    expect(result.docsOnly).toBe(true);
    expectLanes(result.lanes, {
      docs: true,
    });
    expect(plan.commands.map((command) => command.args[0])).not.toContain("release-metadata:check");
  });

  it("runs the npm shrinkwrap guard for dependency package surfaces", () => {
    expect(
      shouldRunShrinkwrapGuard([
        "npm-shrinkwrap.json",
        "extensions/slack/npm-shrinkwrap.json",
        "extensions/slack/package.json",
        "scripts/generate-npm-shrinkwrap.mjs",
      ]),
    ).toBe(true);

    const result = detectChangedLanes(["extensions/slack/package.json"]);
    const plan = createChangedCheckPlan(result);
    const shrinkwrapGuard = createShrinkwrapGuardCommand(["extensions/slack/package.json"]);

    expect(
      shrinkwrapGuard?.args.some((arg) => arg.replaceAll("\\", "/").endsWith("extensions/slack")),
    ).toBe(true);
    expect(plan.commands.map((command) => command.name)).toContain("npm shrinkwrap guard");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("deps:shrinkwrap:check");
  });

  it("runs prompt snapshot drift checks for prompt snapshot generator surfaces", () => {
    expect(
      shouldRunPromptSnapshotCheck([
        "scripts/generate-prompt-snapshots.ts",
        "test/helpers/agents/happy-path-prompt-snapshots.ts",
        "test/fixtures/agents/prompt-snapshots/runtime-happy-path/telegram-direct-codex-message-tool.md",
      ]),
    ).toBe(true);

    const result = detectChangedLanes(["test/helpers/agents/happy-path-prompt-snapshots.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(plan.commands).toContainEqual({
      name: "prompt snapshot drift",
      args: ["prompt:snapshots:check"],
    });
    expect(plan.commands).toContainEqual(
      expect.objectContaining({
        name: "prompt snapshot owner test",
        args: ["test:serial", "test/scripts/prompt-snapshots.test.ts"],
      }),
    );
  });

  it("runs the prompt snapshot owner test for model fixture generator surfaces", () => {
    expect(
      shouldRunPromptSnapshotOwnerTest([
        "scripts/sync-codex-model-prompt-fixture.ts",
        "test/fixtures/agents/prompt-snapshots/codex-model-catalog/gpt-5.5.pragmatic.source.json",
      ]),
    ).toBe(true);

    const result = detectChangedLanes(["scripts/sync-codex-model-prompt-fixture.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(plan.commands).toContainEqual(
      expect.objectContaining({
        name: "prompt snapshot owner test",
        args: ["test:serial", "test/scripts/prompt-snapshots.test.ts"],
      }),
    );
  });

  it("runs runtime sidecar baseline checks for baseline owner surfaces", () => {
    expect(
      shouldRunRuntimeSidecarBaselineCheck([
        "scripts/generate-runtime-sidecar-paths-baseline.ts",
        "scripts/lib/bundled-runtime-sidecar-paths.json",
        "src/plugins/runtime-sidecar-paths-baseline.ts",
        "src/plugins/runtime-sidecar-paths.ts",
      ]),
    ).toBe(true);

    const result = detectChangedLanes(["scripts/lib/bundled-runtime-sidecar-paths.json"]);
    const plan = createChangedCheckPlan(result);

    expect(plan.commands).toContainEqual({
      name: "runtime sidecar baseline",
      args: ["runtime-sidecars:check"],
    });
    expect(plan.commands).toContainEqual(
      expect.objectContaining({
        name: "runtime sidecar owner test",
        args: ["test:serial", "src/plugins/bundled-plugin-metadata.test.ts"],
      }),
    );
  });

  it("runs SQLite sessions/transcripts schema baseline checks for baseline owner surfaces", () => {
    expect(
      shouldRunSqliteSessionSchemaBaselineCheck([
        "src/state/openclaw-agent-schema.sql",
        "scripts/generate-sqlite-session-schema-baseline.ts",
        "scripts/lib/sqlite-session-schema-baseline.ts",
        "test/scripts/sqlite-session-schema-baseline.test.ts",
        "docs/.generated/sqlite-session-transcript-schema-baseline.sha256",
      ]),
    ).toBe(true);

    const result = detectChangedLanes(["src/state/openclaw-agent-schema.sql"]);
    const plan = createChangedCheckPlan(result);

    expect(plan.commands).toContainEqual({
      name: "SQLite sessions/transcripts schema baseline",
      args: ["sqlite:sessions-schema:check"],
    });
  });

  it("runs Plugin SDK API checks for transitive public contract changes", () => {
    expect(
      shouldRunPluginSdkApiBaselineCheck([
        "src/config/sessions/session-accessor.ts",
        "packages/gateway-protocol/src/schema/approvals.ts",
        "extensions/memory-core/index.ts",
        "scripts/generate-plugin-sdk-api-baseline.ts",
        "scripts/lib/plugin-sdk-doc-metadata.ts",
        "docs/.generated/plugin-sdk-api-baseline.sha256",
      ]),
    ).toBe(true);
    expect(shouldRunPluginSdkApiBaselineCheck(["docs/help/troubleshooting.md"])).toBe(false);

    const result = detectChangedLanes(["src/config/sessions/session-accessor.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(plan.commands).toContainEqual({
      name: "Plugin SDK API baseline",
      args: ["plugin-sdk:api:check"],
    });
    expect(plan.commands.map((command) => command.args[0])).not.toContain(
      "plugin-sdk:surface:check",
    );
  });

  it("runs Plugin SDK export and surface checks for direct SDK changes", () => {
    expect(
      shouldRunPluginSdkSurfaceChecks([
        "src/plugin-sdk/core.ts",
        "scripts/plugin-sdk-surface-report.mjs",
        "scripts/sync-plugin-sdk-exports.mjs",
        "scripts/lib/plugin-sdk-entrypoints.json",
        "package.json",
      ]),
    ).toBe(true);
    expect(shouldRunPluginSdkSurfaceChecks(["src/config/sessions/session-accessor.ts"])).toBe(
      false,
    );

    const result = detectChangedLanes(["src/plugin-sdk/core.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(plan.commands).toContainEqual({
      name: "Plugin SDK API baseline",
      args: ["plugin-sdk:api:check"],
    });
    expect(plan.commands).toContainEqual({
      name: "Plugin SDK package exports",
      args: ["plugin-sdk:check-exports"],
    });
    expect(plan.commands).toContainEqual({
      name: "Plugin SDK surface budget",
      args: ["plugin-sdk:surface:check"],
    });

    const releaseMetadataPlan = createChangedCheckPlan(
      detectChangedLanes(["CHANGELOG.md", "package.json"]),
    );
    expect(releaseMetadataPlan.commands.map((command) => command.args[0])).not.toContain(
      "plugin-sdk:check-exports",
    );
  });

  it("guards release metadata package changes to the top-level version field", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-release-metadata-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "fixture", version: "2026.4.20", dependencies: { leftpad: "1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    git(dir, ["add", "package.json"]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "-m",
      "initial",
    ]);

    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "fixture", version: "2026.4.21", dependencies: { leftpad: "1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    git(dir, ["add", "package.json"]);
    expect(
      execFileSync(
        process.execPath,
        [path.join(repoRoot, "scripts", "check-release-metadata-only.mjs"), "--staged"],
        {
          cwd: dir,
          env: createNestedGitEnv(),
          stdio: "pipe",
        },
      ),
    ).toBeInstanceOf(Buffer);

    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "fixture", version: "2026.4.21", dependencies: { leftpad: "1.0.1" } }, null, 2)}\n`,
      "utf8",
    );
    git(dir, ["add", "package.json"]);
    let failure: ExecFileSyncFailure | undefined;
    try {
      execFileSync(
        process.execPath,
        [path.join(repoRoot, "scripts", "check-release-metadata-only.mjs"), "--staged"],
        {
          cwd: dir,
          env: createNestedGitEnv(),
          stdio: "pipe",
        },
      );
    } catch (error) {
      failure = error as ExecFileSyncFailure;
    }

    expect(failure?.status).toBe(1);
    expect(failure?.stderr?.toString("utf8")).toContain(
      "[release-metadata] package.json changed outside the top-level version field",
    );
  });

  it("routes root test/support changes to the tooling test lane instead of all lanes", () => {
    const result = detectChangedLanes([
      "test/git-hooks-pre-commit.test.ts",
      "test-fixtures/legacy-root-fixture.json",
    ]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      testRoot: true,
      tooling: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("routes legacy Swabble deletions as app surface during the app move", () => {
    const result = detectChangedLanes(["Swabble/Sources/SwabbleKit/WakeWordGate.swift"]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      apps: true,
    });
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
  });

  it("runs macOS app CI tests for macOS app dependency changes", () => {
    for (const changedPath of [
      "apps/macos/Sources/OpenClawMac/AppDelegate.swift",
      "apps/macos-mlx-tts/Sources/OpenClawMLXTTS/main.swift",
      "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift",
      "apps/swabble/Sources/SwabbleKit/WakeWordGate.swift",
      "Swabble/Sources/SwabbleKit/WakeWordGate.swift",
    ]) {
      const result = detectChangedLanes([changedPath]);
      const plan = createChangedCheckPlan(result, {
        env: { PATH: "/usr/bin" },
        platform: "linux",
        swiftlintAvailable: false,
      });

      expect(plan.commands.map((command) => command.args[0])).not.toContain("lint:apps");
      expect(plan.commands).toContainEqual(
        expect.objectContaining({
          name: "lint apps (swiftlint unavailable on this host)",
          bin: "node",
        }),
      );
      expect(plan.commands).toContainEqual(
        expect.objectContaining({
          name: "macOS app CI tests",
          args: ["test:macos:ci"],
        }),
      );
    }
  });

  it("runs macOS app CI tests for macOS packaging scripts and owner tests", () => {
    for (const changedPath of [
      "scripts/codesign-mac-app.sh",
      "scripts/create-dmg.sh",
      "scripts/lib/plistbuddy.sh",
      "scripts/lib/swift-toolchain.sh",
      "scripts/notarize-mac-artifact.sh",
      "scripts/package-mac-app.sh",
      "scripts/package-mac-dist.sh",
      "test/scripts/codesign-mac-app.test.ts",
      "test/scripts/create-dmg.test.ts",
      "test/scripts/notarize-mac-artifact.test.ts",
      "test/scripts/package-mac-app.test.ts",
      "test/scripts/package-mac-dist.test.ts",
    ]) {
      const result = detectChangedLanes([changedPath]);
      const plan = createChangedCheckPlan(result, {
        env: { PATH: "/usr/bin" },
        platform: "linux",
        swiftlintAvailable: false,
      });

      expectLanes(result.lanes, {
        testRoot: changedPath.endsWith(".ts"),
        tooling: true,
      });
      expect(plan.commands.map((command) => command.args[0])).not.toContain("lint:apps");
      expect(plan.commands).toContainEqual(
        expect.objectContaining({
          name: "macOS app CI tests",
          args: ["test:macos:ci"],
        }),
      );
    }
  });

  it("routes appcast changes to appcast owner tests", () => {
    const result = detectChangedLanes(["appcast.xml"]);
    const plan = createChangedCheckPlan(result);

    expect(shouldRunAppcastOwnerTest(result.paths)).toBe(true);
    expect(plan.commands).toContainEqual(
      expect.objectContaining({
        name: "appcast owner tests",
        args: ["test:serial", "test/appcast.test.ts", "test/scripts/make-appcast.test.ts"],
      }),
    );
    expect(plan.commands.map((command) => command.name)).not.toContain("macOS app CI tests");
  });

  it("runs app lint when SwiftLint is available in Testbox", () => {
    const result = detectChangedLanes([
      "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift",
    ]);
    const plan = createChangedCheckPlan(result, {
      env: { CI: "1", PATH: "/usr/bin" },
      platform: "linux",
      swiftlintAvailable: true,
    });

    expect(plan.commands.map((command) => command.args[0])).toContain("lint:apps");
    expect(plan.commands).toContainEqual(
      expect.objectContaining({
        name: "macOS app CI tests",
        args: ["test:macos:ci"],
      }),
    );
  });

  it("keeps macOS app CI tests out of Android-only app changes", () => {
    const result = detectChangedLanes(["apps/android/app/src/main/AndroidManifest.xml"]);
    const plan = createChangedCheckPlan(result, {
      env: { CI: "1", PATH: "/usr/bin" },
      platform: "linux",
      swiftlintAvailable: true,
    });

    expectLanes(result.lanes, {
      apps: true,
    });
    expect(plan.commands.map((command) => command.name)).not.toContain("macOS app CI tests");
  });

  it("routes legacy root asset deletions as tooling during root cleanup", () => {
    const result = detectChangedLanes([
      "assets/avatar-placeholder.svg",
      "assets/chrome-extension/icons/icon128.png",
    ]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      tooling: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
  });

  it("routes A2UI bundle source changes as extension changes", () => {
    const result = detectChangedLanes([
      "extensions/canvas/src/host/a2ui-app/bootstrap.js",
      "extensions/canvas/src/host/a2ui-app/rolldown.config.mjs",
    ]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      extensions: true,
      extensionTests: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:extensions");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
    expect(plan.commands).toContainEqual(
      expect.objectContaining({
        name: "Canvas A2UI native resource sync",
        bin: "node",
        args: ["scripts/sync-native-a2ui.mjs", "--check"],
      }),
    );
  });

  it("checks native A2UI resources when the copied resource tree changes", () => {
    const result = detectChangedLanes([
      "apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/CanvasA2UI/a2ui.bundle.js",
    ]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      apps: true,
    });
    expect(shouldRunCanvasA2uiNativeResourceCheck(result.paths)).toBe(true);
    expect(plan.commands).toContainEqual(
      expect.objectContaining({
        name: "Canvas A2UI native resource sync",
        bin: "node",
        args: ["scripts/sync-native-a2ui.mjs", "--check"],
      }),
    );
  });

  it("checks native A2UI resources when bundle inputs or generated outputs change", () => {
    const result = detectChangedLanes([
      "extensions/canvas/package.json",
      "extensions/canvas/src/host/a2ui/.bundle.hash",
      "extensions/canvas/src/host/a2ui/a2ui.bundle.js",
      "pnpm-lock.yaml",
    ]);
    const plan = createChangedCheckPlan(result);

    expect(shouldRunCanvasA2uiNativeResourceCheck(result.paths)).toBe(true);
    expect(plan.commands).toContainEqual(
      expect.objectContaining({
        name: "Canvas A2UI native resource sync",
        bin: "node",
        args: ["scripts/sync-native-a2ui.mjs", "--check"],
      }),
    );
  });

  it("keeps shared Vitest wiring changes out of check test execution", () => {
    const result = detectChangedLanes(["test/vitest/vitest.shared.config.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("keeps setup changes out of check test execution", () => {
    const result = detectChangedLanes(["test/setup.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("adds the warning-only temp creation report for changed test paths", () => {
    const result = detectChangedLanes(["test/helpers/temp-fixture.ts"]);
    const plan = createChangedCheckPlan(result, { base: "main", head: "feature" });
    const command = plan.commands.find(
      (candidate) => candidate.name === "test temp creation report (warning-only)",
    );

    expect(shouldRunTestTempCreationReport(result.paths)).toBe(true);
    expect(command).toMatchObject({
      bin: "node",
      args: ["scripts/report-test-temp-creations.mjs", "--base", "main", "--head", "feature"],
    });
  });

  it("keeps the temp creation report out of non-test changed paths", () => {
    const result = detectChangedLanes(["scripts/check-changed.mjs"]);
    const plan = createChangedCheckPlan(result);

    expect(shouldRunTestTempCreationReport(result.paths)).toBe(false);
    expect(plan.commands.map((command) => command.name)).not.toContain(
      "test temp creation report (warning-only)",
    );
  });

  it("does not route generated plugin bundle artifacts as direct Vitest targets", () => {
    const result = detectChangedLanes([
      "extensions/demo/src/host/assets/.bundle.hash",
      "extensions/canvas/scripts/bundle-a2ui.test.ts",
    ]);
    const plan = createChangedCheckPlan(result);

    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:extensions");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("routes changed extension Vitest configs to only their owning shard", () => {
    const result = detectChangedLanes(["test/vitest/vitest.extension-discord.config.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("keeps an empty changed path list as a no-op", () => {
    const result = detectChangedLanes([]);
    const plan = createChangedCheckPlan(result);

    expect(result.lanes).toEqual({
      core: false,
      coreTests: false,
      ui: false,
      extensions: false,
      extensionTests: false,
      scripts: false,
      strictRatchet: false,
      testRoot: false,
      apps: false,
      docs: false,
      tooling: false,
      liveDockerTooling: false,
      releaseMetadata: false,
      all: false,
    });
    expect(plan.commands).toEqual([
      { name: "conflict markers", args: ["check:no-conflict-markers"] },
      { name: "changelog attributions", args: ["check:changelog-attributions"] },
      {
        name: "guarded extension wildcard re-exports",
        args: ["lint:extensions:no-guarded-wildcard-reexports"],
      },
      {
        name: "plugin-sdk wildcard re-exports",
        args: ["lint:extensions:no-plugin-sdk-wildcard-reexports"],
      },
      { name: "duplicate scan target coverage", args: ["dup:check:coverage"] },
      { name: "dependency pin guard", args: ["deps:pins:check"] },
      { name: "package patch guard", args: ["deps:patches:check"] },
    ]);
  });

  it("keeps docs-only changes cheap", () => {
    const result = detectChangedLanes(["docs/ci.md", "README.md"]);
    const plan = createChangedCheckPlan(result);

    expect(result.docsOnly).toBe(true);
    expect(plan.commands).toEqual([
      { name: "conflict markers", args: ["check:no-conflict-markers"] },
      { name: "changelog attributions", args: ["check:changelog-attributions"] },
      {
        name: "guarded extension wildcard re-exports",
        args: ["lint:extensions:no-guarded-wildcard-reexports"],
      },
      {
        name: "plugin-sdk wildcard re-exports",
        args: ["lint:extensions:no-plugin-sdk-wildcard-reexports"],
      },
      { name: "duplicate scan target coverage", args: ["dup:check:coverage"] },
      { name: "dependency pin guard", args: ["deps:pins:check"] },
      {
        name: "format changed files",
        args: ["format:check", "--no-error-on-unmatched-pattern", "--", "docs/ci.md", "README.md"],
      },
      { name: "package patch guard", args: ["deps:patches:check"] },
    ]);
  });
});
