// Parallel readers must be rejected before a cold, dirty, or stale runtime can rebuild.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  BUILD_STAMP_FILE,
  writeBuildStamp,
  writeRuntimePostBuildStamp,
} from "../scripts/lib/local-build-metadata.mts";
import { listCoreRuntimePostBuildOutputs } from "../scripts/runtime-postbuild.mts";
import { spawnNodeEvalSync } from "../src/test-utils/node-process.ts";
import { assertPrebuiltUiE2eRuntime } from "./vitest/vitest.ui-e2e-prebuilt.global-setup.ts";

let root: string;

function write(relative: string, contents = "fixture\n") {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-prebuilt-ui-")));
  vi.stubEnv("OPENCLAW_FORCE_BUILD", undefined);
  vi.stubEnv("OPENCLAW_FORCE_RUNTIME_POSTBUILD", undefined);
  vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", root);
  write(".gitignore", "dist/\n");
  write("package.json", '{"name":"prebuilt-ui-fixture","private":true}\n');
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  for (const file of [
    "dist/entry.js",
    "dist/plugin-sdk/qa-lab.js",
    "dist/plugin-sdk/qa-runtime.js",
    ...listCoreRuntimePostBuildOutputs({ rootDir: root }),
  ]) {
    write(file);
  }
  write("dist/control-ui/index.html", '<script src="./assets/entry.js"></script>');
  write("dist/control-ui/assets/entry.js");
  write("dist/control-ui/asset-manifest.json", '{"assets":["assets/entry.js"]}');
  writeBuildStamp({ cwd: root });
  writeRuntimePostBuildStamp({ cwd: root });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it("admits a ready generation without writing outputs and detects later metadata drift", () => {
  const stampPath = path.join(root, "dist", BUILD_STAMP_FILE);
  const before = fs.readFileSync(stampPath);
  const generation = assertPrebuiltUiE2eRuntime(root);
  expect(assertPrebuiltUiE2eRuntime(root)).toBe(generation);
  expect(fs.readFileSync(stampPath)).toEqual(before);
  write("dist/build-info.json", '{"generation":"later"}');
  expect(assertPrebuiltUiE2eRuntime(root)).not.toBe(generation);
});

it.each([
  { name: "cold build", remove: "dist", reason: "missing_private_qa_dist" },
  {
    name: "missing private QA",
    remove: "dist/plugin-sdk/qa-runtime.js",
    reason: "missing_private_qa_dist",
  },
  {
    name: "missing postbuild output",
    remove: "dist/build-info.json",
    reason: "missing_runtime_postbuild_output",
  },
  { name: "incomplete UI", remove: "dist/control-ui/assets/entry.js", reason: "Control UI assets" },
])("rejects $name without repairing it", ({ remove, reason }) => {
  const target = path.join(root, remove);
  fs.rmSync(target, { recursive: true, force: true });
  expect(() => assertPrebuiltUiE2eRuntime(root)).toThrow(reason);
  expect(fs.existsSync(target)).toBe(false);
});

it.each(["untracked.ts", "package.json"])("rejects dirty source %s", (file) => {
  write(file);
  expect(() => assertPrebuiltUiE2eRuntime(root)).toThrow("source state is dirty");
});

it("rejects an artifact generation built at another HEAD", () => {
  write(`dist/${BUILD_STAMP_FILE}`, '{"head":"different"}');
  expect(() => assertPrebuiltUiE2eRuntime(root)).toThrow("git_head_changed");
});

it.each([
  ["OPENCLAW_FORCE_BUILD", "force_build"],
  ["OPENCLAW_FORCE_RUNTIME_POSTBUILD", "force_runtime_postbuild"],
])("honors the owner's %s rebuild decision", (key, reason) => {
  vi.stubEnv(key, "1");
  expect(() => assertPrebuiltUiE2eRuntime(root)).toThrow(reason);
});

it("rejects unavailable Git identity instead of falling back to mtimes", () => {
  fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
  expect(() => assertPrebuiltUiE2eRuntime(root)).toThrow("Git HEAD is unavailable");
});

it.each([false, true])("sets the native CLI outcome after teardown (drift: %s)", (drift) => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  write(".gitignore", "dist/\nnode_modules/\n");
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"), "junction");
  write(
    "probe.test.ts",
    `import fs from "node:fs";
import { it } from "vitest";
it("finishes before the generation check", () => {
  if (${drift}) fs.writeFileSync(${JSON.stringify(path.join(root, "dist/build-info.json"))}, "changed");
});`,
  );
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    "native fixture",
  );
  writeBuildStamp({ cwd: root });
  writeRuntimePostBuildStamp({ cwd: root });
  const reportFile = path.join(root, ".git/report.json");
  const configFile = path.join(root, ".git/probe.config.mts");
  write(
    ".git/probe.config.mts",
    `import { sharedVitestConfig } from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.shared.config.ts"))};
export default { resolve: sharedVitestConfig.resolve };`,
  );
  const result = spawnNodeEvalSync(
    `import { startVitest } from "vitest/node";
await startVitest("test", [], {
  root: ${JSON.stringify(root)}, config: ${JSON.stringify(configFile)},
  configLoader: "runner", watch: false,
  include: ["probe.test.ts"], pool: "forks", maxWorkers: 1,
  globalSetup: [${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.ui-e2e-prebuilt.global-setup.ts"))}],
  reporters: ["json"], outputFile: ${JSON.stringify(reportFile)},
});`,
    { cwd: repoRoot, timeout: 15_000 },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  expect(report.numPassedTests, JSON.stringify(report) + result.stderr).toBe(1);
  expect(result.status, result.stderr).toBe(drift ? 1 : 0);
  if (drift) {
    expect(result.stderr).toContain("runtime generation changed during the run");
  }
});
