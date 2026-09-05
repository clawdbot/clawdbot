import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { materializeNativeCompiler, writeNativeFixtureFile } from "./native-boundary-fixture.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const sourceRoot = process.cwd();

function createLinkedCheckoutFixture() {
  const directory = fs.realpathSync.native(roots.make("native-wrapper-worktree-"));
  const primary = path.join(directory, "primary");
  const root = path.join(directory, "linked");
  fs.mkdirSync(primary);
  // Isolate fixture Git writes from hook-owned indexes/objects. Wrapper commands
  // below still inherit the untouched environment and exercise the real bootstrap.
  const gitEnv = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_QUARANTINE_PATH",
  ]) {
    delete gitEnv[key];
  }
  const git = (args: string[]) => {
    const result = spawnSync(
      "git",
      [
        `--git-dir=${path.join(primary, ".git")}`,
        `--work-tree=${primary}`,
        "-c",
        `core.hooksPath=${path.join(directory, "unused-hooks")}`,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd: primary, env: gitEnv, encoding: "utf8", timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  };
  git(["init", "-q"]);
  writeNativeFixtureFile(primary, "package.json", '{"private":true,"type":"module"}\n');
  writeNativeFixtureFile(primary, "pnpm-workspace.yaml", "packages: []\n");
  writeNativeFixtureFile(primary, ".gitignore", "node_modules/\n.artifacts/\n");
  for (const file of [
    "scripts/run-tsgo.mjs",
    "scripts/run-tsgo.mts",
    "scripts/tsx.mjs",
    "scripts/windows-cmd-helpers.mjs",
    "scripts/lib",
  ]) {
    const target = path.join(primary, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(sourceRoot, file), target, { recursive: true });
  }
  git(["add", "."]);
  git(["commit", "-qm", "Synthetic compiler wrapper fixture"]);
  git(["worktree", "add", "--detach", "-q", root]);
  // An ancestor install must not let the worktree's own preload skip its Git fallback.
  expect(path.relative(primary, root)).toBe(`..${path.sep}linked`);
  expect(fs.lstatSync(path.join(root, ".git")).isFile()).toBe(true);
  return { primary, root, git };
}

function installCheckoutTools(root: string) {
  const native = materializeNativeCompiler(root);
  for (const name of ["tsx", "@openclaw/fs-safe"]) {
    const target = path.join(root, "node_modules", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.join(sourceRoot, "node_modules", name), target, "junction");
  }
  return native;
}

function runTsgoEntry(
  root: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return spawnSync(process.execPath, [path.join(root, "scripts/run-tsgo.mjs"), ...args], {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: 25_000,
    killSignal: "SIGKILL",
  });
}

describe("run-tsgo linked worktree entry", () => {
  it("selects its own root compiler from src while preserving relative project semantics", () => {
    const { primary, root } = createLinkedCheckoutFixture();
    installCheckoutTools(primary);
    const native = installCheckoutTools(root);
    const write = (file: string, text: string) => writeNativeFixtureFile(root, file, text);
    const compilerOptions = {
      module: "NodeNext",
      target: "ES2023",
      types: [],
      strict: true,
      noEmit: true,
    };
    write("tsconfig.json", JSON.stringify({ compilerOptions, files: ["wrong-entry.ts"] }));
    write("wrong-entry.ts", 'export const value: number = "wrong project";\n');
    write("src/tsconfig.json", JSON.stringify({ compilerOptions, files: ["entry.ts"] }));
    write("src/entry.ts", "export const value: number = 1;\n");
    const selectionPath = path.join(root, "compiler-selection.json");
    // Record the selected executable and cwd, then let the unchanged native compiler
    // parse -p and check the real project. No bootstrap or compiler result is mocked.
    write(
      "native-compiler.mjs",
      `#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
fs.writeFileSync(${JSON.stringify(selectionPath)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
const result = spawnSync(${JSON.stringify(native)}, process.argv.slice(2), { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
`,
    );
    fs.chmodSync(path.join(root, "native-compiler.mjs"), 0o755);
    const launcher = path.join(root, "node_modules/.bin/tsgo");
    fs.unlinkSync(launcher);
    fs.symlinkSync("../../native-compiler.mjs", launcher, "file");
    if (process.platform === "win32") {
      write("node_modules/.bin/tsgo.cmd", '@node "%~dp0tsgo" %*\r\n');
    }
    const cwd = path.join(root, "src");
    const result = runTsgoEntry(root, ["-p", "tsconfig.json"], { cwd });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const selected: { cwd: string; args: string[] } = JSON.parse(
      fs.readFileSync(selectionPath, "utf8"),
    );
    expect(selected.cwd).toBe(cwd);
    expect(selected.args.slice(0, 2)).toEqual(["-p", "tsconfig.json"]);
    expect(fs.lstatSync(path.join(cwd, "node_modules"), { throwIfNoEntry: false })).toBeUndefined();
  }, 30_000);

  it("refuses a missing local install through its own wrapper without creating dependency links", () => {
    const { primary, root } = createLinkedCheckoutFixture();
    installCheckoutTools(primary);
    const installed = runTsgoEntry(primary, ["--version"]);
    expect(installed.error).toBeUndefined();
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    expect(installed.stdout).toMatch(/^Version \d/m);
    const modules = path.join(root, "node_modules");
    expect(fs.lstatSync(modules, { throwIfNoEntry: false })).toBeUndefined();

    const result = runTsgoEntry(root, ["--version"]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).not.toMatch(/^Version \d/m);
    expect(result.stderr.trim().split("\n").at(-1)).toBe("[tsgo] FAILED (exit 1)");
    expect(fs.lstatSync(modules, { throwIfNoEntry: false })).toBeUndefined();
  }, 30_000);

  it("visibly skips a missing sparse project through its own wrapper before creating dependencies or outputs", () => {
    const { primary, root, git } = createLinkedCheckoutFixture();
    installCheckoutTools(primary);
    git(["config", "core.sparseCheckout", "true"]);
    const result = runTsgoEntry(
      root,
      [
        "-p",
        "test/tsconfig/tsconfig.core.test.json",
        "--tsBuildInfoFile",
        ".artifacts/should-not-exist.tsbuildinfo",
      ],
      { env: { ...process.env, OPENCLAW_TSGO_SPARSE_SKIP: "1" } },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toContain("skipping sparse-missing project");
    expect(result.stderr).toContain("OPENCLAW_TSGO_SPARSE_SKIP=1");
    expect(
      fs.lstatSync(path.join(root, "node_modules"), { throwIfNoEntry: false }),
    ).toBeUndefined();
    expect(fs.existsSync(path.join(root, ".artifacts"))).toBe(false);
  }, 30_000);
});
