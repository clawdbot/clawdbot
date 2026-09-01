// Changed Lanes tests cover changed lanes script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEmptyChangedLanes,
  detectChangedLanes,
  hasDeadcodeScannedSource,
  isChangedLaneTestPath,
  isLiveDockerPackageScriptOnlyChange,
  isPackageScriptOnlyChange,
  listChangedPathsFromGit,
  listStagedChangedPaths,
} from "../../scripts/changed-lanes.mts";
import {
  buildChangedCheckCrabboxArgs,
  cleanupCorepackPnpmShimDir,
  createChangedCheckPlan,
  createPnpmManagedCommand,
  createTargetedCoreLintCommand,
  createTargetedExtensionLintCommand,
  createTargetedScriptLintCommand,
  shouldDelegateChangedCheckToCrabbox,
  shouldRunAppcastOwnerTest,
  shouldRunControlUiI18nVerify,
  shouldRunPromptSnapshotCheck,
  shouldRunPromptSnapshotOwnerTest,
  shouldRunDoctorContractOwnerTests,
  shouldRunRuntimeSidecarBaselineCheck,
  shouldRunNpmLockGuard,
  shouldRunDeprecationHygieneChecks,
  shouldRunPluginSdkSurfaceChecks,
  shouldRunSqliteSessionSchemaBaselineCheck,
  shouldRunTestTempCreationReport,
  shouldRunWrapperShadowingCheck,
  createNpmLockGuardCommand,
  delegationFailedBeforeRunning,
} from "../../scripts/check-changed.mts";
import { resolveOxfmtInvocation } from "../../scripts/format-docs.mts";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];
const repoRoot = process.cwd();
const githubActivityHelper = ".agents/skills/openclaw-pr-maintainer/scripts/github-activity.sh";
const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
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

function commitAll(cwd: string, message: string): void {
  git(cwd, ["add", "."]);
  git(cwd, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test User",
    "commit",
    "-q",
    "-m",
    message,
  ]);
}

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

function runChangedLanesCli(cwd: string, args: string[]) {
  return parseChangedLaneOutput(
    execFileSync(process.execPath, [path.join(repoRoot, "scripts", "changed-lanes.mjs"), ...args], {
      cwd,
      encoding: "utf8",
      env: createNestedGitEnv(),
    }),
  );
}

function runRepoScript(script: string, args: string[], env = createNestedGitEnv()) {
  const nodeArgs = script.endsWith(".mts")
    ? ["--import", "tsx", script, ...args]
    : [script, ...args];
  return spawnSync(process.execPath, nodeArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

function writeRepoFile(repoDir: string, filePath: string, contents: string): void {
  const absolutePath = path.join(repoDir, filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, "utf8");
}

const prettyJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function createRootTestLintFixture() {
  const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-root-lint-");
  git(dir, ["init", "-q", "--initial-branch=main"]);
  writeRepoFile(dir, "README.md", "Synthetic changed-check fixture.\n");
  commitAll(dir, "fixture base");
  for (const file of [
    ".oxlintrc.json",
    "tsconfig.json",
    "test/tsconfig.json",
    "test/tsconfig/tsconfig.test.json",
    "test/tsconfig/tsconfig.test.root.json",
    "test/vitest/vitest.test-shards.d.mts",
  ]) {
    writeRepoFile(dir, file, readFileSync(path.join(repoRoot, file), "utf8"));
  }
  for (const [file, source] of Object.entries({
    "src/plugin-sdk/discovery.ts":
      "export function work(): Promise<void> { return Promise.resolve(); }",
    "src/contracts.d.ts": "declare function fromCore(): Promise<void>;",
    "ui/contracts.d.ts": "declare function fromUi(): Promise<void>;",
    "packages/contracts.d.ts": "declare function fromPackage(): Promise<void>;",
  })) {
    writeRepoFile(dir, file, source);
  }
  symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"), "junction");
  mkdirSync(path.join(dir, "scripts"));
  for (const script of ["run-oxlint.mjs", "report-test-temp-creations.mjs"]) {
    symlinkSync(path.join(repoRoot, "scripts", script), path.join(dir, "scripts", script));
  }
  // Stub unrelated package gates at the executable boundary: real pnpm could
  // reconcile the linked toolchain. The CLI and source-only lint wrapper stay real.
  const binDir = path.join(dir, "bin");
  for (const bin of ["pnpm", "corepack"]) {
    writeRepoFile(dir, `bin/${bin}`, "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(binDir, bin), 0o755);
    writeRepoFile(dir, `bin/${bin}.cmd`, "@echo off\r\nexit /b 0\r\n");
  }
  const env: NodeJS.ProcessEnv = {
    ...createNestedGitEnv(),
    OXC_LOG: "debug",
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  delete env.OPENCLAW_TESTBOX;
  delete env.OPENCLAW_OXLINT_SKIP_PREPARE;
  return {
    dir,
    run: (script: string, args: string[]) =>
      spawnSync(process.execPath, [path.join(repoRoot, script), ...args], {
        cwd: dir,
        encoding: "utf8",
        env,
      }),
  };
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
  const formatScript = expectDefined(
    packageJson.scripts["format:check"],
    "format:check package script",
  );
  const [rawScriptBin, ...scriptArgs] = formatScript.split(" ");
  const scriptBin = expectDefined(rawScriptBin, "format:check script binary");
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

// Keep the real gate and managed children; only the external check commands are synthetic.
function runChangedCheckWithRecordedCommands(failingCommand: string | null) {
  const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-check-order-");
  const binDir = path.join(dir, "bin");
  const eventsPath = path.join(dir, "events.jsonl");
  const childPath = path.join(dir, "command.cjs");
  mkdirSync(binDir);
  writeFileSync(eventsPath, "");
  writeFileSync(
    childPath,
    `
const fs = require("node:fs");
const bin = process.argv[2];
const args = process.argv.slice(3);
const events = ${JSON.stringify(eventsPath)};
const active = ${JSON.stringify(path.join(dir, "active"))};
const record = (event) => fs.appendFileSync(events, JSON.stringify({event, bin, args}) + "\\n");
fs.mkdirSync(active);
record("start");
process.on("exit", () => { record("finish"); fs.rmdirSync(active); });
if (bin === "pnpm" && args[0] === ${JSON.stringify(failingCommand)}) {
  console.error("Synthetic check failure: " + args[0]);
  process.exitCode = 23;
}
`,
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const bin of ["pnpm", "node"]) {
    const launcher = path.join(binDir, bin);
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(childPath)} ${bin} "$@"\n`,
    );
    chmodSync(launcher, 0o755);
    writeFileSync(
      `${launcher}.cmd`,
      `@echo off\r\n"${process.execPath}" "${childPath}" ${bin} %*\r\n`,
    );
  }
  const paths = ["src/gateway/server-runtime-state.ts"];
  const result = runRepoScript("scripts/check-changed.mjs", ["--", ...paths], {
    ...createNestedGitEnv(),
    CI: "",
    GITHUB_ACTIONS: "",
    OPENCLAW_CHECK_CHANGED_REMOTE_CHILD: "1",
    OPENCLAW_CHECK_CHANGED_SKIP_DEADCODE: "",
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  const events: { event: string; bin: string; args: string[] }[] = readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { events, paths, result };
}

function createSyntheticMergeRepo(prefix: string): { dir: string; staleBase: string } {
  const dir = makeTempRepoRoot(tempDirs, prefix);
  git(dir, ["init", "-q", "--initial-branch=main"]);
  writeRepoFile(dir, "README.md", "base\n");
  commitAll(dir, "base");
  const staleBase = git(dir, ["rev-parse", "HEAD"]);

  git(dir, ["switch", "-q", "-c", "feature"]);
  writeRepoFile(dir, "src/pr.ts", "export const pr = true;\n");
  commitAll(dir, "feature");

  git(dir, ["switch", "-q", "main"]);
  writeRepoFile(dir, "src/main-only.ts", "export const mainOnly = true;\n");
  commitAll(dir, "main only");
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

function classifyPackageJsonChange(
  prefix: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  const dir = makeTempRepoRoot(tempDirs, prefix);
  git(dir, ["init", "-q", "--initial-branch=main"]);
  writeRepoFile(dir, "package.json", prettyJson(before));
  commitAll(dir, "initial");
  writeRepoFile(dir, "package.json", prettyJson(after));

  const output = execFileSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "changed-lanes.mjs"), "--json", "--base", "HEAD"],
    { cwd: dir, encoding: "utf8", env: createNestedGitEnv() },
  );
  return parseChangedLaneOutput(output);
}

afterEach(() => {
  cleanupCorepackPnpmShimDir();
  cleanupTempDirs(tempDirs);
});

describe("scripts/changed-lanes", () => {
  it.each([
    {
      name: "prints changed lane help without treating --help as a changed path",
      script: "scripts/changed-lanes.mjs",
      expected: {
        contains: "Usage: node scripts/changed-lanes.mjs",
        excludes: "--help: unknown surface",
      },
    },
    {
      name: "prints changed check help without running the changed gate",
      script: "scripts/check-changed.mjs",
      expected: { contains: "Usage: node scripts/check-changed.mjs", excludes: "[check:changed]" },
    },
  ])("$name", ({ script, expected }) => {
    const result = runRepoScript(script, ["--help"], {
      ...createNestedGitEnv(),
      OPENCLAW_TESTBOX: "1",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(expected.contains);
    expect(result.stdout).not.toContain(expected.excludes);
  });

  it("exits cleanly for no changes without local dependencies", () => {
    const result = runRepoScript("scripts/check-changed.mjs", ["--no-changes"], {
      ...createNestedGitEnv(),
      PATH: "/nonexistent",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("[check:changed] no changed paths; nothing to run");
  });

  it("delegates when the local checkout cannot resolve the default base ref", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-check-changed-missing-base-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    commitAll(dir, "initial");
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts/check-changed.mjs")], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...createNestedGitEnv(),
        CI: "",
        GITHUB_ACTIONS: "",
        OPENCLAW_CHECK_CHANGED_REMOTE_CHILD: "",
        OPENCLAW_TESTBOX: "1",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("delegating through Crabbox workload routing");
    expect(result.stderr).not.toContain("ambiguous argument");
  });

  it("delegates path-scoped release metadata when local diff refs are unavailable", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-check-changed-metadata-missing-base-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    commitAll(dir, "initial");
    writeRepoFile(dir, "node_modules/.modules.yaml", "layoutVersion: 5\n");
    writeRepoFile(dir, "node_modules/.bin/oxfmt", "#!/bin/sh\n");
    writeRepoFile(dir, "node_modules/typescript/package.json", '{"name":"typescript"}\n');
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts/check-changed.mjs"), "--", "CHANGELOG.md"],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...createNestedGitEnv(),
          CI: "",
          GITHUB_ACTIONS: "",
          OPENCLAW_CHECK_CHANGED_REMOTE_CHILD: "",
          OPENCLAW_TESTBOX: "",
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("delegating through Crabbox workload routing");
  });

  it.each([
    {
      name: "rejects unknown changed lane options before treating them as paths",
      script: "scripts/changed-lanes.mjs",
      option: "--jsno",
      expected: { stderr: "Unknown option: --jsno", excludes: [] },
    },
    {
      name: "rejects unknown changed check options before treating them as paths",
      script: "scripts/check-changed.mjs",
      option: "--dr-run",
      expected: {
        stderr: "Unknown option: --dr-run\n[check:changed] FAILED (exit 1)",
        excludes: [],
      },
    },
  ])("$name", ({ script, option, expected }) => {
    const result = runRepoScript(script, [option], {
      ...createNestedGitEnv(),
      OPENCLAW_TESTBOX: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(expected.stderr);
    expect(result.stderr).not.toContain("\n    at ");
    for (const excluded of expected.excludes) {
      expect(result.stderr).not.toContain(excluded);
    }
  });

  it("still accepts dash-prefixed explicit changed paths after the separator", () => {
    const result = runRepoScript("scripts/changed-lanes.mjs", ["--json", "--", "--github-output"]);

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

  it.each(["tsgo:core:test", "lint:tmp:tsgo-core-boundary", null])(
    "runs types before broad audits while retaining serial gate execution (%s)",
    (failingCommand) => {
      const { events, paths, result } = runChangedCheckWithRecordedCommands(failingCommand);
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(failingCommand === null ? 0 : 23);
      const commands = events.filter((event) => event.event === "start");
      const planned = createChangedCheckPlan(detectChangedLanes(paths)).commands.map((command) => ({
        bin: command.bin ?? "pnpm",
        args: command.args,
      }));
      const end =
        failingCommand === null
          ? planned.length
          : planned.findIndex((command) => command.args[0] === failingCommand) + 1;
      expect(commands.map(({ bin, args }) => ({ bin, args }))).toEqual(planned.slice(0, end));
      expect(events).toEqual(
        commands.flatMap(({ bin, args }) => [
          { event: "start", bin, args },
          { event: "finish", bin, args },
        ]),
      );
      const broadAudits = commands.filter(({ args }) =>
        args.some((arg) =>
          [
            "check:coercion-helpers",
            "check:deprecated-api-usage",
            "scripts/check-deadcode-exports.mts",
          ].includes(arg),
        ),
      );
      if (failingCommand !== null) {
        expect(result.stderr).toContain(`Synthetic check failure: ${failingCommand}`);
        expect(broadAudits).toEqual([]);
      } else {
        expect(broadAudits).toHaveLength(3);
        const lastTypecheck = commands.findLastIndex(({ args }) => args[0]?.startsWith("tsgo:"));
        for (const audit of broadAudits) {
          expect(commands.indexOf(audit)).toBeGreaterThan(lastTypecheck);
        }
      }
    },
  );

  it("prints changed check dry-run commands", () => {
    const result = runRepoScript("scripts/check-changed.mjs", [
      "--dry-run",
      "--",
      "extensions/lmstudio/src/model-reasoning.ts",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[check:changed:dry-run] lanes=extensions, extensionTests");
    expect(result.stderr).toContain(
      "[check:changed:dry-run] would run: node scripts/run-oxlint.mjs --tsconfig extensions/tsconfig.json extensions/lmstudio/src/model-reasoning.ts",
    );
  });

  it("keeps the hidden maintainer helper trio on tooling checks through both CLIs", () => {
    const paths = [
      githubActivityHelper,
      ".agents/skills/openclaw-pr-maintainer/SKILL.md",
      "test/scripts/github-activity-helper.test.ts",
    ];
    const lanes = runChangedLanesCli(repoRoot, ["--json", "--", ...paths]);
    const result = runRepoScript("scripts/check-changed.mjs", ["--dry-run", "--", ...paths]);

    expectLanes(lanes.lanes, { docs: true, testRoot: true, tooling: true });
    expect(lanes).toMatchObject({ extensionImpactFromCore: false, docsOnly: false });
    expect(lanes.paths.toSorted()).toEqual(paths.toSorted());
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[check:changed:dry-run] lanes=testRoot, docs, tooling");
    const commands = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("[check:changed:dry-run] would run: "))
      .map((line) => line.replace("[check:changed:dry-run] would run: ", ""));
    expect(commands).toEqual([
      "pnpm check:no-conflict-markers",
      "pnpm check:changelog-attributions",
      "pnpm check:doctor-deprecation-registry",
      "pnpm lint:extensions:no-guarded-wildcard-reexports",
      "pnpm lint:extensions:no-plugin-sdk-wildcard-reexports",
      "pnpm dup:check:coverage",
      "pnpm deps:pins:check",
      `pnpm format:check --no-error-on-unmatched-pattern -- ${lanes.paths.join(" ")}`,
      "pnpm deps:patches:check",
      "node scripts/report-test-temp-creations.mjs --base origin/main --head HEAD",
      "pnpm lint:tmp:tsgo-core-boundary",
      "pnpm tsgo:test:root",
      "pnpm check:coercion-helpers",
      "pnpm lint:scripts",
      "node scripts/run-oxlint.mjs --tsconfig test/tsconfig/tsconfig.test.root.json test/scripts/github-activity-helper.test.ts",
    ]);
  });

  it("includes untracked worktree files in the default local diff", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    commitAll(dir, "initial");

    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    writeFileSync(path.join(dir, "scripts", "new-check.mjs"), "export {};\n", "utf8");

    const result = runChangedLanesCli(dir, ["--json", "--base", "HEAD"]);

    expect(result.paths).toEqual(["scripts/new-check.mjs"]);
    expectLanes(result.lanes, { tooling: true });
  });

  it("falls back to a two-dot diff when a delegated checkout has no merge base", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-no-merge-base-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    commitAll(dir, "initial");
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(dir, ["switch", "-q", "--orphan", "feature"]);
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "committed.ts"), "export const committed = 1;\n", "utf8");
    commitAll(dir, "feature base");
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
    commitAll(dir, "initial");
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
    commitAll(dir, "initial");
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(dir, ["switch", "-q", "-c", "feature"]);
    writeRepoFile(dir, "src/committed.test.ts", "export const committed={value:1};\n");
    commitAll(dir, "add test");
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
    commitAll(dir, "initial");
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

  it.each([
    { name: "a root test", count: 1, extension: "ts", otherPaths: [] },
    {
      name: "an all-lane mixed diff",
      count: 1,
      extension: "tsx",
      otherPaths: ["vitest.config.ts"],
    },
    { name: "the ninth root test", count: 9, extension: "ts", otherPaths: [] },
  ])(
    "fails real changed-check lint for $name and passes after repair",
    ({ count, extension, otherPaths }) => {
      const { dir, run } = createRootTestLintFixture();
      const targets = Array.from(
        { length: count },
        (_, index) => `test/root-lint-${index}.test.${extension}`,
      );
      const broken = targets[count - 1]!;
      const violation = [
        'import { work } from "openclaw/plugin-sdk/discovery";',
        "export function run(ready: boolean) {",
        "  if (ready) return;",
        "  work(); fromCore(); fromUi(); fromPackage();",
        "}",
        "run(false);",
        "",
      ].join("\n");
      for (const target of targets) {
        writeRepoFile(dir, target, "export const ready = true;\n");
      }
      writeRepoFile(dir, broken, violation);
      // Neither excluded fixtures nor unchanged tests may be swept into targeted lint.
      writeRepoFile(dir, "test/fixtures/invalid.ts", violation);
      writeRepoFile(dir, "test/unchanged.test.ts", violation);
      const paths = [...targets, "test/fixtures/invalid.ts", "test/deleted.test.ts", ...otherPaths];
      const failed = run("scripts/check-changed.mjs", ["--base", "HEAD", "--", ...paths]);
      const diagnostics = failed.stdout + failed.stderr;
      expect(failed.error, diagnostics).toBeUndefined();
      expect(failed.status, diagnostics).toBe(1);
      expect(diagnostics).toContain("eslint(curly)");
      expect(
        diagnostics.match(/typescript\(no-floating-promises\)/gu) ?? [],
        diagnostics,
      ).toHaveLength(4);
      expect(diagnostics).toContain(broken);
      expect(failed.stderr.trim().split("\n").at(-1)).toBe("[check:changed] FAILED (exit 1)");

      writeRepoFile(
        dir,
        broken,
        violation
          .replace("if (ready) return;", "if (ready) { return; }")
          .replace(
            "work(); fromCore(); fromUi(); fromPackage();",
            "void work(); void fromCore(); void fromUi(); void fromPackage();",
          ),
      );
      const passed = run("scripts/check-changed.mjs", ["--base", "HEAD", "--", ...paths]);
      expect(passed.error, passed.stdout + passed.stderr).toBeUndefined();
      expect(passed.status, passed.stdout + passed.stderr).toBe(0);
      const planned = run("scripts/check-changed.mjs", [
        "--dry-run",
        "--base",
        "HEAD",
        "--",
        ...paths,
      ]);
      expect(planned.status, planned.stderr).toBe(0);
      const lintPrefix =
        "node scripts/run-oxlint.mjs --tsconfig test/tsconfig/tsconfig.test.root.json ";
      const batches = planned.stderr
        .split("\n")
        .filter((line) => line.includes(lintPrefix))
        .map((line) => line.slice(line.indexOf(lintPrefix) + lintPrefix.length).split(" "));
      expect(batches.map((batch) => batch.length)).toEqual(count === 9 ? [8, 1] : [1]);
      expect(batches.flat()).toEqual(targets);
    },
  );

  it("discovers the canonical root test program and preserves ambient and source-alias types", () => {
    const { dir, run } = createRootTestLintFixture();
    const sources = ["test/discovery.test.ts", "test/component.test.tsx"];
    const declarations = ["test/vitest/vitest.test-shards.d.mts", "test/vitest/common.d.cts"];
    const modules = ["test/plain.mts", "test/plain.cts"];
    for (const file of sources) {
      writeRepoFile(
        dir,
        file,
        'import { work } from "openclaw/plugin-sdk/discovery";\nwork(); fromCore(); fromUi(); fromPackage();\n',
      );
    }
    writeRepoFile(dir, declarations[1]!, "export declare function work(): Promise<void>;\n");
    for (const file of modules) {
      writeRepoFile(dir, file, "void Promise.resolve();\n");
    }
    const selected = [...sources, ...declarations, ...modules];
    const result = run("scripts/run-oxlint.mjs", [
      "--tsconfig",
      "test/tsconfig/tsconfig.test.root.json",
      "--format",
      "json",
      ...selected,
    ]);
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    const report = JSON.parse(result.stdout) as {
      number_of_files: number;
      diagnostics: { filename: string; code: string }[];
    };
    expect(report.number_of_files).toBe(selected.length);
    for (const file of selected) {
      // Ordinary .mts/.cts are deliberately outside the canonical root program;
      // declarations with those suffixes are existing program roots.
      const project = modules.includes(file) ? "<none>" : path.join(dir, "test/tsconfig.json");
      expect(result.stderr.replaceAll("\\", "/"), result.stdout).toContain(
        `Got tsconfig for file ${path.join(dir, file).replaceAll("\\", "/")}: ${project.replaceAll("\\", "/")}`,
      );
    }
    for (const file of sources) {
      expect(
        report.diagnostics
          .filter((diagnostic) => diagnostic.filename === file)
          .map((diagnostic) => diagnostic.code),
        result.stdout,
      ).toEqual(Array.from({ length: 4 }, () => "typescript(no-floating-promises)"));
    }
    const config = run("scripts/run-tsgo.mjs", ["--showConfig", "-p", "test/tsconfig.json"]);
    expect(config.error, config.stderr).toBeUndefined();
    expect(config.status, config.stdout + config.stderr).toBe(0);
    const project = JSON.parse(config.stdout) as {
      files: string[];
      compilerOptions: { types: string[] };
    };
    const roots = project.files.map((file) => path.resolve(dir, "test", file));
    expect(roots).toEqual(
      expect.arrayContaining(
        [
          ...sources,
          ...declarations,
          "src/contracts.d.ts",
          "ui/contracts.d.ts",
          "packages/contracts.d.ts",
        ].map((file) => path.join(dir, file)),
      ),
    );
    for (const file of modules) {
      expect(roots).not.toContain(path.join(dir, file));
    }
    expect(project.compilerOptions.types).toEqual(expect.arrayContaining(["node", "vitest"]));
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
    commitAll(dir, "initial");

    mkdirSync(path.join(dir, ".crabbox"), { recursive: true });
    writeFileSync(path.join(dir, ".crabbox", "capture-files.txt"), "stdout.log\n", "utf8");
    writeFileSync(path.join(dir, ".crabbox", "capture-manifest.txt"), "stdout.log\t12\n", "utf8");

    const result = runChangedLanesCli(dir, ["--json", "--base", "HEAD"]);

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
    commitAll(dir, "initial");

    unlinkSync(path.join(dir, "src", "shared", "obsolete.ts"));

    const result = runChangedLanesCli(dir, ["--json", "--base", "HEAD"]);

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
    commitAll(dir, "initial");

    unlinkSync(path.join(dir, "src", "shared", "obsolete.ts"));
    git(dir, ["add", "src/shared/obsolete.ts"]);

    const result = runChangedLanesCli(dir, ["--json", "--staged"]);

    expect(result.paths).toEqual(["src/shared/obsolete.ts"]);
    expectLanes(result.lanes, { core: true, coreTests: true });
  });

  it.each([
    { name: "core source", changedPaths: ["src/agents/api.ts"], expected: true },
    { name: "extension source", changedPaths: ["extensions/copilot/src/a.ts"], expected: true },
    { name: "ui source", changedPaths: ["ui/src/pages/a.ts"], expected: true },
    { name: "package source", changedPaths: ["packages/x/src/a.mts"], expected: true },
    // Matches the `[cm]?[jt]sx?` selector the lint lanes in check-changed.mts use.
    { name: "tsx source", changedPaths: ["ui/src/pages/Page.tsx"], expected: true },
    { name: "jsx source", changedPaths: ["ui/src/pages/Page.jsx"], expected: true },
    { name: "cjs source", changedPaths: ["src/agents/legacy.cjs"], expected: true },
    // An import-only edit can orphan a barrel re-export in a file this diff never
    // touches, so selection is by path; inspecting changed lines would miss it.
    { name: "import-only edit", changedPaths: ["src/agents/tool-surface-plan.ts"], expected: true },
    { name: "docs tree", changedPaths: ["docs/example.ts"], expected: false },
    { name: "scripts tree", changedPaths: ["scripts/check-changed.mjs"], expected: false },
    // knip never reads these, so they must not pull in the scan.
    { name: "markdown under src", changedPaths: ["src/README.md"], expected: false },
    { name: "sql under src", changedPaths: ["src/state/schema.sql"], expected: false },
  ])("selects the dead-export scan for $name", ({ changedPaths, expected }) => {
    expect(hasDeadcodeScannedSource(changedPaths)).toBe(expected);
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

  it.each([
    "extensions/whatsapp/src/config-ui-hints.ts",
    "extensions/mattermost/src/config-schema-core.ts",
    "extensions/telegram/openclaw.plugin.json",
    "extensions/discord/package.json",
    "extensions/slack/security-contract-api.ts",
    "src/config/zod-schema.core.ts",
    "src/channels/plugins/config-schema.ts",
    "scripts/load-channel-config-surface.ts",
  ])("routes %s through the bundled channel config metadata lane", (changedPath) => {
    const result = detectChangedLanes([changedPath]);
    const plan = createChangedCheckPlan(result);

    expect(result.lanes.bundledChannelConfigMetadata).toBe(true);
    expect(plan.commands.map((command) => command.args[0])).toContain(
      "check:bundled-channel-config-metadata",
    );
  });

  it("keeps unrelated plugin runtime changes out of the bundled channel metadata lane", () => {
    const result = detectChangedLanes(["extensions/whatsapp/src/monitor.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(result.lanes.bundledChannelConfigMetadata).toBe(false);
    expect(plan.commands.map((command) => command.args[0])).not.toContain(
      "check:bundled-channel-config-metadata",
    );
  });

  it("includes bundled channel metadata in the fail-safe all plan", () => {
    const result = detectChangedLanes(["unknown-surface.foo"]);
    const plan = createChangedCheckPlan(result);

    expect(result.lanes.all).toBe(true);
    expect(plan.commands.map((command) => command.args[0])).toContain(
      "check:bundled-channel-config-metadata",
    );
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
    });
    expect(plan.commands.map((command) => command.args[0])).toContain(
      "check:database-first-legacy-stores",
    );
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:core");
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:core:test");
    expect(plan.commands.find((command) => command.args[0] === "tsgo:core")?.env).toEqual({
      PATH: "/usr/bin",
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
      },
    });
  });

  it("targets mixed core, extension, script, and root test lint without full-owner fan-out", () => {
    const result = detectChangedLanes([
      "src/gateway/node-registry.ts",
      "extensions/lmstudio/src/models.fetch.ts",
      "scripts/check-changed.mjs",
      "test/helpers/temp-dir.ts",
    ]);
    const plan = createChangedCheckPlan(result, { env: { PATH: "/usr/bin" } });

    expect(plan.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "lint core changed file",
          args: [
            "scripts/run-oxlint.mjs",
            "--tsconfig",
            "config/tsconfig/oxlint.core.json",
            "src/gateway/node-registry.ts",
          ],
        }),
        expect.objectContaining({
          name: "lint extension changed file",
          args: [
            "scripts/run-oxlint.mjs",
            "--tsconfig",
            "extensions/tsconfig.json",
            "extensions/lmstudio/src/models.fetch.ts",
          ],
        }),
        expect.objectContaining({
          name: "lint script changed file",
          args: [
            "scripts/run-oxlint.mjs",
            "--tsconfig",
            "config/tsconfig/oxlint.scripts.json",
            "scripts/check-changed.mjs",
          ],
        }),
        expect.objectContaining({
          name: "lint test root changed file",
          args: [
            "scripts/run-oxlint.mjs",
            "--tsconfig",
            "test/tsconfig/tsconfig.test.root.json",
            "test/helpers/temp-dir.ts",
          ],
        }),
      ]),
    );
    const commandNames = plan.commands.map((command) => command.args[0]);
    for (const fullLane of ["lint:core", "lint:extensions", "lint:scripts"]) {
      expect(commandNames).not.toContain(fullLane);
    }
  });

  it.each([
    {
      name: "mixed UI TypeScript and CSS",
      paths: ["ui/src/app-routes.ts", "ui/src/styles/base.css"],
      oxlintTargets: ["ui/src/app-routes.ts"],
      stylelintTargets: ["ui/src/app-routes.ts", "ui/src/styles/base.css"],
    },
    {
      name: "UI CSS only",
      paths: ["ui/src/styles/base.css"],
      oxlintTargets: [],
      stylelintTargets: ["ui/src/styles/base.css"],
    },
    {
      name: "public theme palette only",
      paths: ["ui/public/themes/tide.css"],
      oxlintTargets: [],
      stylelintTargets: ["ui/public/themes/tide.css"],
    },
  ])("targets style lint for $name without broad core lint", (testCase) => {
    const plan = createChangedCheckPlan(detectChangedLanes(testCase.paths), {
      env: { PATH: "/usr/bin" },
    });

    expect(plan.commands.map((command) => command.args[0])).not.toContain("lint:core");
    const oxlint = plan.commands.find((command) => command.name.startsWith("lint core changed"));
    if (testCase.oxlintTargets.length === 0) {
      expect(oxlint).toBeUndefined();
    } else {
      expect(oxlint?.args.slice(3)).toEqual(testCase.oxlintTargets);
    }
    expect(
      plan.commands.find((command) => command.name.startsWith("lint UI changed style")),
    ).toMatchObject({
      bin: "node",
      args: ["--import", "tsx", "scripts/run-stylelint.mts", ...testCase.stylelintTargets],
    });
  });

  it.each([
    {
      owner: "core",
      paths: [
        "src/gateway/node-registry.ts",
        "src/gateway/node-registry.invoke-stream.ts",
        "src/gateway/server-methods/nodes.invoke.ts",
        "src/gateway/server-methods/nodes.invoke-deadline.ts",
        "src/node-host/runtime.ts",
        "src/node-host/runner.ts",
        "src/plugins/provider-self-hosted-setup.ts",
        "packages/gateway-client/src/timeouts.ts",
        "packages/normalization-core/src/number-coercion.ts",
      ],
      pluralName: "lint core changed files",
      singularName: "lint core changed file",
      fullLane: "lint:core",
    },
    {
      owner: "extension",
      paths: [
        "extensions/lmstudio/src/embedding-provider.ts",
        "extensions/lmstudio/src/stream.ts",
        "extensions/lmstudio/src/model-reasoning.ts",
        "extensions/lmstudio/src/models.fetch.ts",
        "extensions/lmstudio/src/setup.ts",
        "extensions/lmstudio/src/defaults.ts",
        "extensions/lmstudio/src/provider-auth.ts",
        "extensions/lmstudio/src/runtime.ts",
        "extensions/lmstudio/src/models.ts",
      ],
      pluralName: "lint extension changed files",
      singularName: "lint extension changed file",
      fullLane: "lint:extensions",
    },
  ])("batches broad $owner changes without falling back to full lint", (testCase) => {
    const result = detectChangedLanes(testCase.paths);
    const plan = createChangedCheckPlan(result, { env: { PATH: "/usr/bin" } });
    const commands = plan.commands.filter(
      (command) => command.name === testCase.pluralName || command.name === testCase.singularName,
    );

    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.args.slice(3).length)).toEqual([8, 1]);
    expect(commands.flatMap((command) => command.args.slice(3)).toSorted()).toEqual(
      testCase.paths.toSorted(),
    );
    expect(plan.commands.map((command) => command.args[0])).not.toContain(testCase.fullLane);
  });

  it.each([
    {
      name: "routes UI production changes to UI prod and core test lanes",
      path: "ui/src/app.ts",
      expected: {
        includes: ["tsgo:ui", "tsgo:core:test", "lint:ui:i18n"],
        excludes: ["tsgo:core"],
      },
    },
    {
      name: "routes the UI production config to UI prod and core test lanes",
      path: "tsconfig.ui.json",
      expected: { includes: ["tsgo:ui", "tsgo:core:test", "lint:core"], excludes: [] },
    },
  ])("$name", ({ path: changedPath, expected }) => {
    const result = detectChangedLanes([changedPath]);
    const commands = createChangedCheckPlan(result, {
      env: { PATH: "/usr/bin" },
    }).commands.map((command) => command.args[0]);

    expectLanes(result.lanes, { coreTests: true, ui: true });
    for (const command of expected.includes) {
      expect(commands).toContain(command);
    }
    for (const command of expected.excludes) {
      expect(commands).not.toContain(command);
    }
  });

  it("falls back to core lint for a non-lintable core test asset", () => {
    const result = detectChangedLanes([
      "packages/ai/test/fixtures/provider-transport-parity/openai-success.snap.txt",
    ]);
    const commands = createChangedCheckPlan(result, {
      env: { PATH: "/usr/bin" },
    }).commands.map((command) => command.args[0]);

    expectLanes(result.lanes, { coreTests: true });
    expect(commands).toContain("lint:core");
  });

  it.each(["scripts/control-ui-i18n.ts", "scripts/lib/example.ts", "tsconfig.scripts.json"])(
    "routes %s to the scripts typecheck lane",
    (changedPath) => {
      const result = detectChangedLanes([changedPath]);
      const plan = createChangedCheckPlan(result);

      expect(result.lanes.scripts).toBe(true);
      expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:scripts");
      expect(plan.commands.map((command) => command.args[0])).toContain("check:script-erasability");
    },
  );

  it("routes script erasability guard changes back through the guard", () => {
    const result = detectChangedLanes(["scripts/check-script-erasability.mjs"]);
    const plan = createChangedCheckPlan(result);

    expect(plan.commands.map((command) => command.args[0])).toContain("check:script-erasability");
  });

  it("keeps the scripts lane when another change selects the full lane", () => {
    const result = detectChangedLanes(["package.json", "scripts/example.mts"]);

    expect(result.lanes.all).toBe(true);
  });

  it("routes Control UI i18n tooling changes through keyless catalog verification", () => {
    const result = detectChangedLanes(["scripts/control-ui-i18n-verify.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(shouldRunControlUiI18nVerify(result.paths)).toBe(true);
    expect(plan.commands.map((command) => command.args[0])).toContain("lint:ui:i18n");
    expect(shouldRunControlUiI18nVerify(["ui/config/control-ui-locales.ts"])).toBe(true);
    expect(shouldRunControlUiI18nVerify(["scripts/lib/control-ui-i18n-config.json"])).toBe(true);
    expect(shouldRunControlUiI18nVerify(["scripts/lib/example.ts"])).toBe(false);
  });

  it.each([
    ["test/ordinary.test.ts", true, true],
    ["test/scripts/owner.test.ts", true, true],
    ["test/helpers/support.ts", true, true],
    ["test/component.test.tsx", true, true],
    ["test/vitest/foo.config.ts", true, true],
    ["test/vitest/vitest-runtime-helper.d.mts", true, true],
    ["test/vitest/vitest-runtime-helper.d.cts", true, true],
    ["test/plain.mts", true, false],
    ["test/plain.cts", true, false],
    ["test/e2e/qa-lab/runtime/system-agent-first-run-docker-client.ts", true, false],
    ["test/e2e/qa-lab/runtime/agent-bundle-mcp-tools-docker-client.ts", true, false],
    ["test/deleted.test.ts", true, false],
    ["test/fixtures/foo.ts", false, false],
    ["test/foo.mjs", false, false],
    ["test/tsconfig/tsconfig.test.root.json", true, false],
    ["test/tsconfig.json", true, false],
  ])(
    "routes %s to root typecheck=%s and targeted lint=%s",
    (changedPath, expectedTestRoot, expectedLint) => {
      const { dir, run } = createRootTestLintFixture();
      if (!changedPath.endsWith(".json")) {
        writeRepoFile(
          dir,
          changedPath,
          expectedLint
            ? "export const ready = true;\n"
            : 'if (true) console.log("excluded");\nPromise.resolve();\n',
        );
      }
      if (changedPath === "test/deleted.test.ts") {
        unlinkSync(path.join(dir, changedPath));
      }
      const result = run("scripts/check-changed.mjs", [
        "--dry-run",
        "--base",
        "HEAD",
        "--",
        changedPath,
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr.includes("would run: pnpm tsgo:test:root")).toBe(expectedTestRoot);
      if (!expectedLint) {
        const excluded = run("scripts/check-changed.mjs", ["--base", "HEAD", "--", changedPath]);
        expect(excluded.error, excluded.stderr).toBeUndefined();
        expect(excluded.status, excluded.stdout + excluded.stderr).toBe(0);
        expect(excluded.stderr).not.toContain("lint test root changed");
      }
      const lintCommands = result.stderr
        .split("\n")
        .filter((line) => line.includes("would run:") && line.includes("run-oxlint.mjs"));
      expect(lintCommands).toEqual(
        expectedLint
          ? [
              `[check:changed:dry-run] would run: node scripts/run-oxlint.mjs --tsconfig test/tsconfig/tsconfig.test.root.json ${changedPath}`,
            ]
          : [],
      );
      expect(result.stderr).not.toContain("would run: pnpm lint\n");
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

  it.each([
    {
      name: "targets small core lint diffs",
      create: createTargetedCoreLintCommand,
      targets: [
        ".github/workflows/ci.yml",
        "scripts/check-changed.mjs",
        "src/agents/auth-profiles/usage.ts",
        "test/scripts/changed-lanes.test.ts",
      ],
      expected: {
        name: "lint core changed file",
        tsconfig: "config/tsconfig/oxlint.core.json",
        path: "src/agents/auth-profiles/usage.ts",
      },
    },
    {
      name: "targets small extension lint diffs",
      create: createTargetedExtensionLintCommand,
      targets: ["extensions/lmstudio/src/model-reasoning.ts", "docs/help/testing.md"],
      expected: {
        name: "lint extension changed file",
        tsconfig: "extensions/tsconfig.json",
        path: "extensions/lmstudio/src/model-reasoning.ts",
      },
    },
    {
      name: "targets small script lint diffs",
      create: createTargetedScriptLintCommand,
      targets: ["scripts/check-changed.mjs", "test/scripts/changed-lanes.test.ts"],
      expected: {
        name: "lint script changed file",
        tsconfig: "config/tsconfig/oxlint.scripts.json",
        path: "scripts/check-changed.mjs",
      },
    },
  ])("$name", ({ create, targets, expected }) => {
    expect(create(targets, { PATH: "/usr/bin" }, { fileExists: () => true })).toEqual({
      name: expected.name,
      bin: "node",
      args: ["scripts/run-oxlint.mjs", "--tsconfig", expected.tsconfig, expected.path],
      env: { PATH: "/usr/bin" },
    });
  });

  it("reenables local-check policy for changed typecheck commands", () => {
    const result = detectChangedLanes(["packages/normalization-core/src/string-normalization.ts"]);
    const plan = createChangedCheckPlan(result, {
      env: { OPENCLAW_LOCAL_CHECK: "0", PATH: "/usr/bin" },
    });

    expect(plan.commands.find((command) => command.args[0] === "tsgo:core")?.env).toEqual({
      OPENCLAW_LOCAL_CHECK: "1",
      OPENCLAW_TSGO_SPARSE_SKIP: "1",
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
    const shimDir = expectDefined(
      (command.env?.PATH ?? "").split(path.delimiter)[0],
      "CI Corepack pnpm shim directory",
    );

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

  it("keeps trusted changed gates local unless remote proof is explicit", () => {
    const result = detectChangedLanes(["src/config/config.ts"]);
    expect(
      shouldDelegateChangedCheckToCrabbox(
        ["--base", "origin/main"],
        { PATH: "/usr/bin" },
        { result },
      ),
    ).toBe(false);
    expect(shouldDelegateChangedCheckToCrabbox([], { OPENCLAW_TESTBOX: "1" }, { result })).toBe(
      true,
    );

    expect(buildChangedCheckCrabboxArgs(["--base", "origin/main", "--head", "HEAD"])).toEqual([
      "scripts/crabbox-wrapper.mjs",
      "run",
      "--workload",
      "ci-fast",
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

  it("keeps a changed export signature in its local source lane", () => {
    const result = detectChangedLanes(["src/config/config.ts"]);

    expect(shouldDelegateChangedCheckToCrabbox([], {}, { result })).toBe(false);
  });

  it("adds the dead export scan only for production source changes", () => {
    const command = {
      name: "dead export scan (skip with OPENCLAW_CHECK_CHANGED_SKIP_DEADCODE=1)",
      bin: "node",
      args: ["--import", "tsx", "scripts/check-deadcode-exports.mts"],
      env: expect.any(Object),
    };
    const sourceResult = detectChangedLanes(["src/config/config.ts"]);
    const toolingResult = detectChangedLanes(["scripts/check-changed.mjs"]);

    expect(createChangedCheckPlan(sourceResult).commands).toContainEqual(command);
    expect(createChangedCheckPlan(toolingResult).commands).not.toContainEqual(command);
    expect(
      createChangedCheckPlan(sourceResult, {
        env: { OPENCLAW_CHECK_CHANGED_SKIP_DEADCODE: "1" },
      }).commands,
    ).not.toContainEqual(command);
  });

  it("keeps classified changed gates local", () => {
    const docsResult = detectChangedLanes(["docs/reference/test.md"]);
    const noChangesResult = detectChangedLanes([]);
    const metadataResult = detectChangedLanes(["CHANGELOG.md"]);
    const mixedResult = detectChangedLanes(["CHANGELOG.md", "src/config/config.ts"]);

    expect(shouldDelegateChangedCheckToCrabbox([], {}, { result: noChangesResult })).toBe(false);
    expect(shouldDelegateChangedCheckToCrabbox([], {}, { result: docsResult })).toBe(false);
    for (const result of [docsResult, noChangesResult, metadataResult, mixedResult]) {
      expect(shouldDelegateChangedCheckToCrabbox([], {}, { result })).toBe(false);
    }
    for (const result of [docsResult, metadataResult, mixedResult]) {
      expect(shouldDelegateChangedCheckToCrabbox([], { OPENCLAW_TESTBOX: "1" }, { result })).toBe(
        true,
      );
    }
  });

  it("keeps generated schema baseline owner checks local", () => {
    const result = detectChangedLanes([
      "docs/.generated/sqlite-session-transcript-schema-baseline.sha256",
    ]);
    expect(result.docsOnly).toBe(true);
    expect(shouldDelegateChangedCheckToCrabbox([], {}, { result })).toBe(false);
  });

  it("delegates staged changed gates as explicit remote paths", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-check-changed-staged-delegate-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    commitAll(dir, "initial");
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
    commitAll(dir, "initial");
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

  it.each([
    {
      name: "selects compiler-owned graphs for core test leaf changes",
      path: "src/agents/embedded-agent-runner/run/attempt-system-prompt.test.ts",
      expected: {
        lanes: { coreTests: true },
        includes: ["tsgo:core:test"],
        excludes: ["tsgo:core"],
        coreTestChecks: ["checkBoundary", "checkTypes"],
      },
    },
    {
      name: "routes core test-only changes to core test lanes only",
      path: "packages/normalization-core/src/string-normalization.test-support.ts",
      expected: {
        lanes: { coreTests: true },
        includes: ["tsgo:core:test"],
        excludes: ["tsgo:core"],
      },
    },
    {
      name: "routes extension production changes to extension prod and extension test lanes",
      path: "extensions/lmstudio/src/model-reasoning.ts",
      expected: {
        lanes: { extensions: true, extensionTests: true },
        includes: ["tsgo:extensions", "tsgo:extensions:test"],
        excludes: [],
      },
    },
    {
      name: "routes extension test-only changes to extension test lanes only",
      path: "extensions/discord/src/index.test-helpers.ts",
      expected: {
        lanes: { extensionTests: true },
        includes: ["tsgo:extensions:test"],
        excludes: ["tsgo:extensions"],
      },
    },
  ])("$name", ({ path: changedPath, expected }) => {
    const result = detectChangedLanes([changedPath]);
    const plan = createChangedCheckPlan(result);
    const commands = plan.commands.map((command) => command.args[0]);

    expectLanes(result.lanes, expected.lanes);
    expect(plan.commands.flatMap((command) => command.coreTestCheck ?? [])).toEqual(
      "coreTestChecks" in expected ? expected.coreTestChecks : [],
    );
    for (const command of expected.includes) {
      expect(commands).toContain(command);
    }
    for (const command of expected.excludes) {
      expect(commands).not.toContain(command);
    }
  });

  it.each([{ otherPaths: [] }, { otherPaths: [githubActivityHelper] }])(
    "expands public core/plugin contracts with $otherPaths to extension validation",
    ({ otherPaths }) => {
      const result = detectChangedLanes(["src/plugin-sdk/core.ts", ...otherPaths]);
      const plan = createChangedCheckPlan(result);

      expect(result.extensionImpactFromCore).toBe(true);
      expectLanes(result.lanes, {
        core: true,
        coreTests: true,
        extensions: true,
        extensionTests: true,
        tooling: otherPaths.length > 0,
      });
      expect(plan.commands.map((command) => command.args[0])).toEqual(
        expect.arrayContaining([
          "tsgo:core",
          "tsgo:core:test",
          "tsgo:extensions",
          "tsgo:extensions:test",
        ]),
      );
    },
  );

  it.each([
    "pnpm-lock.yaml",
    ".agents/skills/openclaw-pr-maintainer/scripts/unknown-helper.sh",
    `${githubActivityHelper}.bak`,
    `${githubActivityHelper}/child.sh`,
    `other/${githubActivityHelper}`,
    ".agents/skills/openclaw-pr-maintainer-extra/scripts/github-activity.sh",
    ".agents/config.json",
    ".agents/skills/autoreview/scripts/autoreview",
    ".agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs",
  ])("fails safe for %s even alongside the hidden maintainer helper", (changedPath) => {
    for (const paths of [[changedPath], [githubActivityHelper, changedPath]]) {
      const result = detectChangedLanes(paths);
      const plan = createChangedCheckPlan(result);

      expectLanes(result.lanes, { all: true, tooling: paths.includes(githubActivityHelper) });
      expect(result.extensionImpactFromCore).toBe(true);
      expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:all");
      expect(plan.commands.map((command) => command.args[0])).toContain("lint");
      expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
    }
  });

  it.each([
    ...[
      githubActivityHelper,
      `./${githubActivityHelper}`,
      githubActivityHelper.replaceAll("/", "\\"),
    ].map((helperPath) => ({
      name: `routes hidden maintainer helper ${helperPath} to tooling instead of all lanes`,
      paths: [helperPath],
      excludesTests: true,
    })),
    {
      name: "routes gitignore changes to tooling instead of all lanes",
      paths: [".gitignore"],
      excludesTests: true,
    },
    {
      name: "routes root hygiene config changes to tooling instead of all lanes",
      paths: [
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
      ],
      excludesTests: true,
    },
    {
      name: "routes VS Code workspace settings to tooling instead of all lanes",
      paths: [".vscode/settings.json", ".vscode/extensions.json"],
      excludesTests: true,
    },
    {
      name: "routes legacy root sandbox Dockerfile moves to tooling instead of all lanes",
      paths: [
        "Dockerfile.sandbox",
        "Dockerfile.sandbox-browser",
        "Dockerfile.sandbox-common",
        "scripts/docker/sandbox/Dockerfile",
        "scripts/docker/sandbox/Dockerfile.browser",
        "scripts/docker/sandbox/Dockerfile.common",
      ],
      excludesTests: true,
    },
    {
      name: "routes legacy root asset deletions as tooling during root cleanup",
      paths: ["assets/avatar-placeholder.svg", "assets/chrome-extension/icons/icon128.png"],
      excludesTests: false,
    },
  ])("$name", ({ paths, excludesTests }) => {
    const result = detectChangedLanes(paths);
    const commands = createChangedCheckPlan(result).commands.map((command) => command.args[0]);

    expectLanes(result.lanes, { tooling: true });
    expect(result.extensionImpactFromCore).toBe(false);
    expect(commands).toContain("lint:scripts");
    expect(commands).not.toContain("tsgo:all");
    if (excludesTests) {
      expect(commands).not.toContain("test");
    }
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
      "max-lines suppression ratchet",
      "assertion SAFETY comment ratchet",
      "changelog attributions",
      "doctor deprecation registry",
      "guarded extension wildcard re-exports",
      "plugin-sdk wildcard re-exports",
      "duplicate scan target coverage",
      "dependency pin guard",
      "format changed files",
      "plugin boundaries",
      "wrapper shadowing",
      "package patch guard",
      "test temp creation report (warning-only)",
      "core tsgo graph boundary",
      "typecheck core tests",
      "coercion helper declaration guard",
      "deprecated API usage",
      // These live-Docker paths include `src/gateway/*.live.test.ts`, and the
      // full-tree knip scan sees test files, so a deleted last consumer can
      // orphan an export here too.
      "dead export scan (skip with OPENCLAW_CHECK_CHANGED_SKIP_DEADCODE=1)",
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
    const before = prettyJson({
      name: "fixture",
      scripts: { "test:docker:all": "node scripts/test-docker-all.mjs" },
      dependencies: { leftpad: "1.0.0" },
    });
    const after = prettyJson({
      name: "fixture",
      scripts: {
        "test:docker:all": "node scripts/test-docker-all.mjs",
        "test:docker:live-acp-bind:droid":
          "OPENCLAW_LIVE_ACP_BIND_AGENT=droid bash scripts/test-live-acp-bind-docker.sh",
      },
      dependencies: { leftpad: "1.0.0" },
    });

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

  it.each([
    {
      name: "classifies live Docker package script changes from the git diff",
      prefix: "openclaw-live-docker-package-",
      before: {
        name: "fixture",
        scripts: { "test:docker:all": "node scripts/test-docker-all.mjs" },
      },
      after: {
        name: "fixture",
        scripts: {
          "test:docker:all": "node scripts/test-docker-all.mjs",
          "test:docker:live-acp-bind:droid":
            "OPENCLAW_LIVE_ACP_BIND_AGENT=droid bash scripts/test-live-acp-bind-docker.sh",
        },
      },
      expected: { liveDockerTooling: true },
    },
    {
      name: "classifies normal package script changes from the git diff",
      prefix: "openclaw-package-scripts-",
      before: {
        name: "fixture",
        scripts: { test: "node --import tsx scripts/test-projects.mts" },
        dependencies: { leftpad: "1.0.0" },
      },
      after: {
        name: "fixture",
        scripts: {
          test: "node --import tsx scripts/test-projects.mts",
          "test:profile": "node scripts/profile-tests.mjs",
        },
        dependencies: { leftpad: "1.0.0" },
      },
      expected: { tooling: true },
    },
  ])("$name", ({ prefix, before, after, expected }) => {
    const result = classifyPackageJsonChange(prefix, before, after);

    expect(result.paths).toEqual(["package.json"]);
    expectLanes(result.lanes, expected);
  });

  it("keeps non-script package changes off the live Docker focused gate", () => {
    const before = prettyJson({
      name: "fixture",
      scripts: {},
      dependencies: { leftpad: "1.0.0" },
    });
    const after = prettyJson({
      name: "fixture",
      scripts: {
        "test:docker:live-acp-bind:droid":
          "OPENCLAW_LIVE_ACP_BIND_AGENT=droid bash scripts/test-live-acp-bind-docker.sh",
      },
      dependencies: { leftpad: "1.0.1" },
    });

    expect(isLiveDockerPackageScriptOnlyChange(before, after)).toBe(false);
  });

  it("routes package script-only changes through the tooling gate", () => {
    const before = prettyJson({
      name: "fixture",
      scripts: { test: "node test.js" },
      dependencies: { leftpad: "1.0.0" },
    });
    const after = prettyJson({
      name: "fixture",
      scripts: { test: "node test.js", "test:profile": "node scripts/profile-tests.mjs" },
      dependencies: { leftpad: "1.0.0" },
    });

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
      "docs/.generated/config-baseline.counts.json",
      "docs/.generated/config-baseline.sha256",
      "package.json",
    ]);
    const plan = createChangedCheckPlan(result, { staged: true });

    expectLanes(result.lanes, {
      docs: true,
      releaseMetadata: true,
    });
    const commands = plan.commands.map((command) => command.args[0]);
    expect(commands).toEqual([
      "check:no-conflict-markers",
      "check:changelog-attributions",
      "check:doctor-deprecation-registry",
      "lint:extensions:no-guarded-wildcard-reexports",
      "lint:extensions:no-plugin-sdk-wildcard-reexports",
      "dup:check:coverage",
      "check:coercion-helpers",
      "deps:pins:check",
      "format:check",
      "--import",
      "check:deprecated-api-usage",
      "plugins:boundary-report:ci",
      "check:wrapper-shadowing",
      "deps:patches:check",
      "release-metadata:check",
      "android:version:check",
      "config:schema:check",
      "config:docs:check",
      "deps:root-ownership:check",
    ]);
    expect(commands).not.toContain("ios:version:check");
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

  it("runs the npm package-lock guard for dependency package surfaces", () => {
    expect(
      shouldRunNpmLockGuard([
        "extensions/slack/package.json",
        "extensions/slack/deps/local-runtime/package.json",
        "scripts/generate-npm-package-lock.mts",
      ]),
    ).toBe(true);

    const result = detectChangedLanes(["extensions/slack/package.json"]);
    const plan = createChangedCheckPlan(result);
    const npmLockGuard = createNpmLockGuardCommand(["extensions/slack/package.json"]);

    expect(npmLockGuard?.args.slice(0, 3)).toEqual([
      "--import",
      "tsx",
      "scripts/generate-npm-package-lock.mts",
    ]);
    expect(
      npmLockGuard?.args.some((arg) => arg.replaceAll("\\", "/").endsWith("extensions/slack")),
    ).toBe(true);
    expect(plan.commands.map((command) => command.name)).toContain("npm package-lock guard");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("deps:npm-lock:check");
  });

  it.each([
    {
      name: "runs prompt snapshot drift checks for prompt snapshot generator surfaces",
      predicate: shouldRunPromptSnapshotCheck,
      predicatePaths: [
        "scripts/generate-prompt-snapshots.ts",
        "test/helpers/agents/happy-path-prompt-snapshots.ts",
        "test/fixtures/agents/prompt-snapshots/runtime-happy-path/telegram-direct-codex-message-tool.md",
        "test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/discord-group-codex-message-tool.md.diff",
      ],
      changedPath: "test/helpers/agents/happy-path-prompt-snapshots.ts",
      expected: {
        exact: [{ name: "prompt snapshot drift", args: ["prompt:snapshots:check"] }],
        partial: [
          {
            name: "prompt snapshot owner test",
            args: ["test:serial", "test/scripts/prompt-snapshots.test.ts"],
          },
        ],
      },
    },
    {
      name: "runs the prompt snapshot owner test for model fixture generator surfaces",
      predicate: shouldRunPromptSnapshotOwnerTest,
      predicatePaths: [
        "scripts/sync-codex-model-prompt-fixture.ts",
        "test/fixtures/agents/prompt-snapshots/codex-model-catalog/gpt-5.5.pragmatic.source.json",
      ],
      changedPath: "scripts/sync-codex-model-prompt-fixture.ts",
      expected: {
        exact: [],
        partial: [
          {
            name: "prompt snapshot owner test",
            args: ["test:serial", "test/scripts/prompt-snapshots.test.ts"],
          },
        ],
      },
    },
    {
      name: "runs runtime sidecar baseline checks for baseline owner surfaces",
      predicate: shouldRunRuntimeSidecarBaselineCheck,
      predicatePaths: [
        "scripts/generate-runtime-sidecar-paths-baseline.ts",
        "scripts/lib/bundled-runtime-sidecar-paths.json",
        "src/plugins/runtime-sidecar-paths-baseline.ts",
        "src/plugins/runtime-sidecar-paths.ts",
      ],
      changedPath: "scripts/lib/bundled-runtime-sidecar-paths.json",
      expected: {
        exact: [{ name: "runtime sidecar baseline", args: ["runtime-sidecars:check"] }],
        partial: [
          {
            name: "runtime sidecar owner test",
            args: ["test:serial", "src/plugins/bundled-plugin-metadata.test.ts"],
          },
        ],
      },
    },
    {
      name: "runs doctor contract owner tests for extension module and manifest changes",
      predicate: shouldRunDoctorContractOwnerTests,
      predicatePaths: [
        "extensions/telegram/doctor-contract-api.ts",
        "extensions/telegram/openclaw.plugin.json",
        "extensions/codex/src/migration/session-binding-sidecars.ts",
      ],
      changedPath: "extensions/telegram/doctor-contract-api.ts",
      expected: {
        exact: [],
        partial: [
          {
            name: "doctor contract declaration + closure guard tests",
            args: [
              "test:serial",
              "src/plugins/doctor-contract-declarations.test.ts",
              "src/plugins/doctor-contract-closure-guard.test.ts",
            ],
          },
        ],
      },
    },
    {
      name: "runs SQLite sessions/transcripts schema baseline checks for baseline owner surfaces",
      predicate: shouldRunSqliteSessionSchemaBaselineCheck,
      predicatePaths: [
        "src/state/openclaw-agent-schema.sql",
        "scripts/generate-sqlite-session-schema-baseline.ts",
        "scripts/lib/sqlite-session-schema-baseline.ts",
        "test/scripts/sqlite-session-schema-baseline.test.ts",
        "docs/.generated/sqlite-session-transcript-schema-baseline.sha256",
      ],
      changedPath: "src/state/openclaw-agent-schema.sql",
      expected: {
        exact: [
          {
            name: "SQLite sessions/transcripts schema baseline",
            args: ["sqlite:sessions-schema:check"],
          },
        ],
        partial: [],
      },
    },
  ])("$name", ({ predicate, predicatePaths, changedPath, expected }) => {
    expect(predicate(predicatePaths)).toBe(true);
    const commands = createChangedCheckPlan(detectChangedLanes([changedPath])).commands;
    for (const command of expected.exact) {
      expect(commands).toContainEqual(command);
    }
    for (const command of expected.partial) {
      expect(commands).toContainEqual(expect.objectContaining(command));
    }
  });

  it.each([
    "src/plugin-sdk/core.ts",
    "scripts/plugin-sdk-surface-report.mts",
    "scripts/sync-plugin-sdk-exports.mts",
    "scripts/lib/plugin-sdk-entries.mts",
    "scripts/lib/plugin-sdk-entrypoints.json",
    "extensions/tsconfig.package-boundary.paths.json",
    "extensions/xai/tsconfig.json",
  ])("runs Plugin SDK export and surface checks for %s", (changedPath) => {
    expect(shouldRunPluginSdkSurfaceChecks([changedPath])).toBe(true);
    expect(shouldRunPluginSdkSurfaceChecks(["package.json"])).toBe(true);
    expect(shouldRunPluginSdkSurfaceChecks(["src/config/sessions/session-accessor.ts"])).toBe(
      false,
    );

    const result = detectChangedLanes([changedPath]);
    const plan = createChangedCheckPlan(result);

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

  it.each([
    "extensions/copilot/src/tool-bridge.test.ts",
    "extensions/codex/src/app-server/dynamic-tool-build.test.ts",
    "extensions/copilot/src/test-support/fixture.ts",
    "test/helpers/plugins/fixture.ts",
    "scripts/check-no-extension-test-core-imports.ts",
    "scripts/check-file-utils.ts",
    "scripts/check-changed.mts",
  ])("checks extension test import boundaries for %s", (changedPath) => {
    const plan = createChangedCheckPlan(detectChangedLanes([changedPath]));
    expect(plan.commands).toContainEqual({
      name: "extension test core imports",
      args: ["lint:plugins:no-extension-test-core-imports"],
    });
  });

  it.each([
    ["src/agents/prepared-model-runtime.copilot.integration.test.ts", true],
    ["src/plugins/loader.ts", true],
    ["src/gateway/gateway-acp-bind.live.test.ts", true],
    ["packages/normalization-core/src/result.ts", true],
    ["ui/src/app.ts", true],
    ["test/helpers/temp-dir.ts", true],
    ["test/tsconfig/tsconfig.core.test.agents-root.json", true],
    ["scripts/check-tsgo-core-boundary.mts", true],
    ["scripts/lib/tsgo-core-test-shards.mts", true],
    ["scripts/check-changed.mts", true],
    ["tsconfig.json", true],
    ["docs/ci.md", false],
    ["extensions/copilot/index.ts", false],
  ])("routes the core tsgo graph boundary for %s: %s", (changedPath, expected) => {
    const commands = createChangedCheckPlan(detectChangedLanes([changedPath])).commands;
    expect(commands.some((command) => command.args[0] === "lint:tmp:tsgo-core-boundary")).toBe(
      expected,
    );
  });

  it("runs deprecation hygiene checks for outcome-changing paths and all lanes", () => {
    expect(
      shouldRunDeprecationHygieneChecks([
        "src/plugin-sdk/core.ts",
        "extensions/slack/index.ts",
        "packages/gateway-protocol/src/index.ts",
        "scripts/lib/plugin-sdk-entries.mts",
        "scripts/check-deprecated-api-usage.mts",
        "scripts/plugin-boundary-report.ts",
        "src/plugins/compat/registry.ts",
        "package.json",
      ]),
    ).toBe(true);
    expect(shouldRunDeprecationHygieneChecks(["docs/plugins/sdk-migration.md"])).toBe(false);

    for (const result of [
      detectChangedLanes(["extensions/slack/index.ts"]),
      detectChangedLanes(["unknown-surface.foo"]),
    ]) {
      const plan = createChangedCheckPlan(result);
      expect(plan.commands).toContainEqual({
        name: "deprecated API usage",
        args: ["check:deprecated-api-usage"],
      });
      expect(plan.commands).toContainEqual({
        name: "plugin boundaries",
        args: ["plugins:boundary-report:ci"],
      });
    }
  });

  it("runs wrapper shadowing for source and guard-owner changes", () => {
    expect(
      shouldRunWrapperShadowingCheck([
        "src/channels/turn/run-channel-turn.ts",
        "scripts/check-wrapper-shadowing.mts",
        "scripts/check-export-name-collisions.mts",
        "scripts/lib/ts-guard-utils.mts",
        "package.json",
      ]),
    ).toBe(true);
    expect(
      shouldRunWrapperShadowingCheck([
        "docs/concepts/message-lifecycle.md",
        "scripts/lib/wrapper-shadowing-baseline.json",
        "scripts/lib/export-name-collision-baseline.json",
      ]),
    ).toBe(false);

    const plan = createChangedCheckPlan(
      detectChangedLanes(["scripts/check-wrapper-shadowing.mts"]),
    );
    expect(plan.commands).toContainEqual({
      name: "wrapper shadowing",
      args: ["check:wrapper-shadowing"],
    });
  });

  it("guards release metadata package changes to the top-level version field", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-release-metadata-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "fixture", version: "2026.4.20", dependencies: { leftpad: "1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    commitAll(dir, "initial");

    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "fixture", version: "2026.4.21", dependencies: { leftpad: "1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    git(dir, ["add", "package.json"]);
    expect(
      execFileSync(
        process.execPath,
        [
          "--import",
          tsxImport,
          path.join(repoRoot, "scripts", "check-release-metadata-only.mts"),
          "--staged",
        ],
        {
          cwd: dir,
          env: {
            ...createNestedGitEnv(),
            TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json"),
          },
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
        [
          "--import",
          tsxImport,
          path.join(repoRoot, "scripts", "check-release-metadata-only.mts"),
          "--staged",
        ],
        {
          cwd: dir,
          env: {
            ...createNestedGitEnv(),
            TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json"),
          },
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
      "apps/macos/Package.swift",
      "apps/macos/Tests/OpenClawIPCTests/Fixtures/state.json",
      "apps/macos-mlx-tts/Sources/OpenClawMLXTTS/main.swift",
      "apps/shared/OpenClawKit/Sources/OpenClawKit/Client.swift",
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
      expect(plan.commands.map((command) => command.args[0])).not.toContain("android:lint");
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

  it.each([
    "apps/macos/Tests/OpenClawIPCTests/MacNodeHostWorkerTests.swift",
    "./apps/macos/Tests/OpenClawIPCTests/RemovedTests.swift",
    "apps\\macos\\Tests\\OpenClawIPCTests\\Nested\\WorkerTests.swift",
  ])("keeps Swift test-only changes out of local packaging tests: %s", (changedPath) => {
    const plan = createChangedCheckPlan(detectChangedLanes([changedPath]), {
      env: { PATH: "/usr/bin" },
      platform: "darwin",
      swiftlintAvailable: true,
    });

    expect(plan.commands.map((command) => command.args[0])).toContain("lint:apps");
    expect(plan.commands.map((command) => command.name)).toContain(
      "native state schema version guard",
    );
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test:macos:ci");
  });

  it("preserves the full changed gate alongside a Swift test change", () => {
    const fullPlan = createChangedCheckPlan(detectChangedLanes(["pnpm-lock.yaml"]));
    const mixedPlan = createChangedCheckPlan(
      detectChangedLanes([
        "pnpm-lock.yaml",
        "apps/macos/Tests/OpenClawIPCTests/MacNodeHostWorkerTests.swift",
      ]),
    );
    const withoutFormat = (plan: typeof fullPlan) =>
      plan.commands.filter((command) => command.name !== "format changed files");

    expect(fullPlan.commands.map((command) => command.args[0])).toEqual(
      expect.arrayContaining(["tsgo:all", "lint"]),
    );
    expect(withoutFormat(mixedPlan)).toEqual(withoutFormat(fullPlan));
  });

  it("runs macOS CI tests for workspace rsync receiver owners", () => {
    for (const changedPath of [
      "src/shared/worker-bundle-hash.ts",
      "src/worker/workspace-rsync-receiver.ts",
      "src/gateway/worker-environments/workspace-sync.ts",
      "src/gateway/worker-environments/workspace-sync-helpers.ts",
      "src/gateway/worker-environments/workspace-accepted-sync.ts",
      "src/gateway/worker-environments/workspace-accepted-remote-script.ts",
      "src/gateway/worker-environments/workspace-mutation-remote-script.ts",
      "src/gateway/worker-environments/workspace-rsync-path.test.ts",
    ]) {
      const plan = createChangedCheckPlan(detectChangedLanes([changedPath]), {
        env: { PATH: "/usr/bin" },
        platform: "linux",
        swiftlintAvailable: false,
      });

      expect(plan.commands).toContainEqual(
        expect.objectContaining({
          name: "macOS app CI tests",
          args: ["test:macos:ci"],
        }),
      );
    }
  });

  it("runs the native state schema guard for either contract owner", () => {
    for (const changedPath of [
      "apps/shared/OpenClawKit/Sources/OpenClawNativeState/OpenClawNativeStateSQLite.swift",
      "src/state/openclaw-state-db-contract.ts",
    ]) {
      const plan = createChangedCheckPlan(detectChangedLanes([changedPath]), {
        env: { PATH: "/usr/bin" },
        platform: "linux",
        swiftlintAvailable: false,
      });

      expect(plan.commands).toContainEqual(
        expect.objectContaining({
          name: "native state schema version guard",
          bin: "node",
          args: ["scripts/check-native-state-schema-version.mjs"],
        }),
      );
    }
  });

  it.each([false, true])(
    "runs macOS app CI tests for macOS packaging scripts and owner tests (mixed Swift test: %s)",
    (includeSwiftTest) => {
      for (const changedPath of [
        "scripts/codesign-mac-app.sh",
        "scripts/create-dmg.sh",
        "scripts/lib/plistbuddy.sh",
        "scripts/lib/swift-toolchain.sh",
        "scripts/mac-elevation-host.sh",
        "scripts/notarize-mac-artifact.sh",
        "scripts/package-mac-app.sh",
        "scripts/package-mac-dist.sh",
        "scripts/restart-mac.sh",
        "scripts/stage-mac-node-worker.sh",
        "scripts/test-macos-native.mts",
        "test/scripts/macos-native-test-launch.test.ts",
        "scripts/verify-mac-node-worker.mjs",
        "scripts/verify-mac-node-worker-fs.mjs",
        "scripts/materialize-mac-node-worker.py",
        "scripts/lib/mac-app-bundle.sh",
        "scripts/lib/mac-native-inventory.py",
        "scripts/lib/mac-worker-portability.mjs",
        "scripts/lib/mac-node-worker-proof-state.mjs",
        "scripts/lib/mac-bundle-mutation.py",
        "test/helpers/mac-native.ts",
        "test/helpers/mac-signing.ts",
        "test/scripts/mac-node-worker.test.ts",
        "test/scripts/verify-mac-node-worker-fs.test.ts",
        "test/scripts/restart-mac.test.ts",
        "test/scripts/mac-elevation-artifact.test-support.ts",
        "test/scripts/mac-native-fixtures.test-support.ts",
        "test/scripts/mac-node-worker-materialization.test-support.ts",
        "test/scripts/codesign-mac-app.test.ts",
        "test/scripts/create-dmg.test.ts",
        "test/scripts/mac-elevation-host.test.ts",
        "test/scripts/notarize-mac-artifact.test.ts",
        "test/scripts/package-mac-app.test.ts",
        "test/scripts/package-mac-dist.test.ts",
      ]) {
        const result = detectChangedLanes([
          changedPath,
          ...(includeSwiftTest
            ? ["apps/macos/Tests/OpenClawIPCTests/MacNodeHostWorkerTests.swift"]
            : []),
        ]);
        const plan = createChangedCheckPlan(result, {
          env: { PATH: "/usr/bin" },
          platform: "linux",
          swiftlintAvailable: false,
        });

        expectLanes(result.lanes, {
          scripts: changedPath.endsWith(".mts"),
          testRoot: changedPath.endsWith(".ts"),
          tooling: true,
          apps: includeSwiftTest,
        });
        expect(plan.commands.map((command) => command.args[0])).not.toContain("lint:apps");
        expect(plan.commands).toContainEqual(
          expect.objectContaining({
            name: "macOS app CI tests",
            args: ["test:macos:ci"],
          }),
        );
      }
    },
  );

  it.each<[string, string[], boolean]>([
    ["standalone test", ["test/scripts/swift-build-cache-metadata.test.ts"], false],
    ["production owner", ["scripts/swift-build-cache-metadata.py"], true],
    [
      "test with a native dependency",
      ["test/scripts/swift-build-cache-metadata.test.ts", "scripts/lib/swift-toolchain.sh"],
      true,
    ],
  ])("routes Swift cache metadata checks for %s", (_label, paths, macosCi) => {
    const plan = createChangedCheckPlan(detectChangedLanes(paths), {
      env: { PATH: "/usr/bin" },
      platform: "linux",
      swiftlintAvailable: false,
    });

    expect(
      plan.commands.filter((command) => command.name === "Swift build cache metadata tests"),
    ).toEqual([
      expect.objectContaining({
        args: ["test:serial", "test/scripts/swift-build-cache-metadata.test.ts"],
      }),
    ]);
    expect(plan.commands.some((command) => command.args[0] === "test:macos:ci")).toBe(macosCi);
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

  it.each<[string, NodeJS.Platform, boolean, boolean]>([
    ["apps/ios/Sources/RootTabs.swift", "darwin", true, false],
    ["apps/macos/Sources/OpenClawMac/AppDelegate.swift", "darwin", false, true],
    ["apps/shared/OpenClawKit/Sources/OpenClawKit/Client.swift", "linux", true, true],
    ["apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift", "linux", true, true],
  ])(
    "preserves Swift lint for %s on %s with SwiftLint=%s",
    (changedPath, platform, swiftlintAvailable, macosCi) => {
      const plan = createChangedCheckPlan(detectChangedLanes([changedPath]), {
        env: { CI: "1", PATH: "/usr/bin" },
        platform,
        swiftlintAvailable,
      });
      const commands = plan.commands.map((command) => command.args[0]);

      expect(commands).toContain("lint:apps");
      expect(commands).not.toContain("android:lint");
      expect(commands.includes("test:macos:ci")).toBe(macosCi);
    },
  );

  it.each<[string, NodeJS.Platform, boolean]>([
    [
      "apps/android/app/src/test/java/ai/openclaw/app/gateway/GatewaySessionReconnectTest.kt",
      "darwin",
      true,
    ],
    [
      "apps/android/app/src/test/java/ai/openclaw/app/gateway/GatewaySessionReconnectTest.kt",
      "linux",
      false,
    ],
    ["apps/android/app/src/main/java/ai/openclaw/app/MainActivity.kt", "darwin", false],
    ["apps/android/app/src/main/AndroidManifest.xml", "linux", true],
    ["apps/android/app/build.gradle.kts", "linux", false],
    ["apps/android/settings.gradle.kts", "darwin", true],
  ])(
    "selects only Android lint for %s on %s with SwiftLint=%s",
    (changedPath, platform, swiftlintAvailable) => {
      const result = detectChangedLanes([changedPath]);
      const plan = createChangedCheckPlan(result, {
        env: { CI: "1", PATH: "/usr/bin" },
        platform,
        swiftlintAvailable,
      });

      expectLanes(result.lanes, { apps: true });
      expect
        .soft(plan.commands)
        .toContainEqual(expect.objectContaining({ args: ["android:lint"] }));
      expect.soft(plan.commands.map((command) => command.args[0])).not.toContain("lint:apps");
      expect
        .soft(plan.commands.map((command) => command.name))
        .not.toContain("lint apps (swiftlint unavailable on this host)");
      expect(plan.commands.map((command) => command.args[0])).not.toContain("test:macos:ci");
    },
  );

  it.each([false, true])("preserves mixed native lint with SwiftLint=%s", (swiftlintAvailable) => {
    for (const { paths, androidLint, macosCi } of [
      { paths: ["apps/ios/Sources/RootTabs.swift"], androidLint: false, macosCi: false },
      {
        paths: [
          "apps/android/app/src/main/AndroidManifest.xml",
          "apps/ios/Sources/RootTabs.swift",
          "apps/shared/OpenClawKit/Sources/OpenClawKit/Client.swift",
        ],
        androidLint: true,
        macosCi: true,
      },
    ]) {
      const plan = createChangedCheckPlan(detectChangedLanes(paths), {
        env: { CI: "1", PATH: "/usr/bin" },
        platform: "linux",
        swiftlintAvailable,
      });
      const commands = new Set(plan.commands.map((command) => command.args[0]));

      expect(commands.has("android:lint")).toBe(androidLint);
      expect(commands.has("lint:apps")).toBe(swiftlintAvailable);
      expect(commands.has("test:macos:ci")).toBe(macosCi);
      expect(
        plan.commands.some(
          (command) => command.name === "lint apps (swiftlint unavailable on this host)",
        ),
      ).toBe(!swiftlintAvailable);
    }
  });

  it.each(["apps/.i18n/native-source.json", "apps/web/index.ts", "appcast.xml"])(
    "keeps non-native app assets out of native lint: %s",
    (changedPath) => {
      const plan = createChangedCheckPlan(detectChangedLanes([changedPath]), {
        platform: "linux",
        swiftlintAvailable: false,
      });

      expect(plan.commands.map((command) => command.args[0])).not.toContain("android:lint");
      expect(plan.commands.map((command) => command.args[0])).not.toContain("lint:apps");
      expect(plan.commands.map((command) => command.name)).not.toContain(
        "lint apps (swiftlint unavailable on this host)",
      );
    },
  );

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
  });

  it.each([
    {
      name: "keeps shared Vitest wiring changes out of check test execution",
      paths: ["test/vitest/vitest.shared.config.ts"],
      expected: "lint:scripts",
    },
    {
      name: "keeps setup changes out of check test execution",
      paths: ["test/setup.ts"],
      expected: "lint:scripts",
    },
    {
      name: "does not route generated plugin bundle artifacts as direct Vitest targets",
      paths: [
        "extensions/demo/src/host/assets/.bundle.hash",
        "extensions/canvas/scripts/bundle-a2ui.test.ts",
      ],
      expected: "tsgo:extensions",
    },
    {
      name: "routes changed extension Vitest configs to only their owning shard",
      paths: ["test/vitest/vitest.extension-discord.config.ts"],
      expected: "lint:scripts",
    },
  ])("$name", ({ paths, expected }) => {
    const commands = createChangedCheckPlan(detectChangedLanes(paths)).commands.map(
      (command) => command.args[0],
    );

    expect(commands).toContain(expected);
    expect(commands).not.toContain("test");
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

  it.each([
    {
      name: "adds the max-lines suppression ratchet with worktree and staged bases",
      commandName: "max-lines suppression ratchet",
      worktreeOptions: { base: "main", head: "feature" },
      expected: {
        worktree: ["check:max-lines-ratchet", "--base", "main"],
        staged: ["check:max-lines-ratchet", "--staged", "--base", "HEAD"],
      },
    },
    {
      name: "adds the assertion SAFETY comment ratchet for production source",
      commandName: "assertion SAFETY comment ratchet",
      worktreeOptions: { base: "main" },
      expected: {
        worktree: ["check:assertion-safety", "--base", "main"],
        staged: ["check:assertion-safety", "--staged", "--base", "HEAD"],
      },
    },
  ])("$name", ({ commandName, worktreeOptions, expected }) => {
    const result = detectChangedLanes(["src/runtime.ts"]);
    const worktreePlan = createChangedCheckPlan(result, worktreeOptions);
    const stagedPlan = createChangedCheckPlan(result, { staged: true });

    expect(worktreePlan.commands.find((command) => command.name === commandName)).toMatchObject({
      args: expected.worktree,
    });
    expect(stagedPlan.commands.find((command) => command.name === commandName)).toMatchObject({
      args: expected.staged,
    });
  });

  it.each(["config/env-var-count-budget.txt", "scripts/check-env-var-count.mts"])(
    "routes %s through the single baseline-ratchet entry",
    (changedPath) => {
      const commands = createChangedCheckPlan(detectChangedLanes([changedPath])).commands;

      expect(commands).toContainEqual(
        expect.objectContaining({ args: ["check:max-lines-ratchet", "--base", "origin/main"] }),
      );
      expect(commands.map((command) => command.args[0])).not.toContain("check:env-var-count");
    },
  );

  it("routes the shared shrink-ratchet owner through both baseline entries", () => {
    const commands = createChangedCheckPlan(
      detectChangedLanes(["scripts/lib/shrink-ratchet.mts"]),
    ).commands.map((command) => command.args);

    expect(commands).toContainEqual(["check:max-lines-ratchet", "--base", "origin/main"]);
    expect(commands).toContainEqual(["check:assertion-safety", "--base", "origin/main"]);
  });

  it("keeps the temp creation report out of non-test changed paths", () => {
    const result = detectChangedLanes(["scripts/check-changed.mjs"]);
    const plan = createChangedCheckPlan(result);

    expect(shouldRunTestTempCreationReport(result.paths)).toBe(false);
    expect(plan.commands.map((command) => command.name)).not.toContain(
      "test temp creation report (warning-only)",
    );
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
      testRoot: false,
      apps: false,
      docs: false,
      tooling: false,
      liveDockerTooling: false,
      bundledChannelConfigMetadata: false,
      releaseMetadata: false,
      all: false,
    });
    expect(plan.commands).toEqual([
      { name: "conflict markers", args: ["check:no-conflict-markers"] },
      { name: "changelog attributions", args: ["check:changelog-attributions"] },
      { name: "doctor deprecation registry", args: ["check:doctor-deprecation-registry"] },
      {
        name: "guarded extension wildcard re-exports",
        args: ["lint:extensions:no-guarded-wildcard-reexports"],
      },
      {
        name: "plugin-sdk wildcard re-exports",
        args: ["lint:extensions:no-plugin-sdk-wildcard-reexports"],
      },
      { name: "duplicate scan target coverage", args: ["dup:check:coverage"] },
      { name: "coercion helper declaration guard", args: ["check:coercion-helpers"] },
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
      { name: "doctor deprecation registry", args: ["check:doctor-deprecation-registry"] },
      {
        name: "guarded extension wildcard re-exports",
        args: ["lint:extensions:no-guarded-wildcard-reexports"],
      },
      {
        name: "plugin-sdk wildcard re-exports",
        args: ["lint:extensions:no-plugin-sdk-wildcard-reexports"],
      },
      { name: "duplicate scan target coverage", args: ["dup:check:coverage"] },
      { name: "coercion helper declaration guard", args: ["check:coercion-helpers"] },
      { name: "dependency pin guard", args: ["deps:pins:check"] },
      {
        name: "format changed files",
        args: ["format:check", "--no-error-on-unmatched-pattern", "--", "docs/ci.md", "README.md"],
      },
      { name: "package patch guard", args: ["deps:patches:check"] },
    ]);
  });
});

describe("delegationFailedBeforeRunning", () => {
  // The wrapper only prints a run summary once the command reached the box, so
  // the summary is the evidence that a verdict exists at all.
  it("treats a lease or network failure as never having run", () => {
    const output = [
      'request failed: Get "https://backend.blacksmith.sh/api/testbox/list?all=true": context deadline exceeded',
      "blacksmith testbox run exited 1",
    ].join("\n");

    expect(delegationFailedBeforeRunning(output)).toBe(true);
  });

  it("treats a reported command exit as a real check failure", () => {
    const output = [
      "  64.95s  failed:1   typecheck core tests",
      '{"provider":"blacksmith-testbox","runStatus":"failed","errorKind":"command-exit","exitCode":1}',
    ].join("\n");

    // Falling back locally here would re-run on macOS and could pass a lane
    // whose truth is Linux, turning a red gate green.
    expect(delegationFailedBeforeRunning(output)).toBe(false);
  });

  it("treats a full workload-routing provider outage as never having run", () => {
    // Provider selection happens before any dispatch, so an exhausted routing
    // chain (every doctor failing) can never carry a remote verdict.
    const output = [
      "[crabbox] no ready provider for workload=ci-fast",
      "[crabbox] provider readiness blacksmith-testbox:doctor exited 1,daytona:doctor exited 124,azure:doctor exited 124,aws:doctor exited 124",
    ].join("\n");

    expect(delegationFailedBeforeRunning(output)).toBe(true);
  });

  it("does not mistake an infrastructure error kind for a command verdict", () => {
    const output = [
      "failed to acquire lease for testbox",
      '{"provider":"blacksmith-testbox","runStatus":"failed","errorKind":"lease-timeout","exitCode":1}',
    ].join("\n");

    expect(delegationFailedBeforeRunning(output)).toBe(true);
  });

  // A crash after dispatch produces no summary either, so absence of one cannot
  // be read as "never ran" — that is how an unknown Linux result would go green.
  it("fails closed when the wrapper dies without saying why", () => {
    expect(delegationFailedBeforeRunning("node: killed\n")).toBe(false);
    expect(delegationFailedBeforeRunning("")).toBe(false);
  });

  it("keeps a command verdict authoritative even alongside network noise", () => {
    const output = [
      'request failed: Get "https://backend.blacksmith.sh/api/testbox/list": context deadline exceeded',
      '{"provider":"blacksmith-testbox","runStatus":"failed","errorKind":"command-exit","exitCode":1}',
    ].join("\n");

    expect(delegationFailedBeforeRunning(output)).toBe(false);
  });
});
