import { execFile, type ExecException } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { JsonTestResults } from "vitest/reporters";
import packageJson from "../../package.json" with { type: "json" };
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { resolveVitestHomeSelection } from "../../scripts/lib/vitest-home-selection.mts";
import { spawnOwnedVitestProcess } from "../../scripts/lib/vitest-process.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { proveNestedRetention } from "./nested-retention.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const nestedLifetime = createFixtureLifetime();
afterEach(() => nestedLifetime.cleanup());
const repoRoot = path.resolve(import.meta.dirname, "../..");
const posixIt = process.platform === "win32" ? it.skip : it;

function prepareVitestFixture(root: string, homeName = "home") {
  const tmp = path.join(root, "tmp");
  const home = path.join(root, homeName);
  fs.mkdirSync(tmp);
  fs.mkdirSync(home);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ private: true, type: "module", packageManager: packageJson.packageManager }),
  );
  // Keep pnpm's pinned toolchain record without sharing lockfile writes.
  fs.copyFileSync(path.join(repoRoot, "pnpm-lock.yaml"), path.join(root, "pnpm-lock.yaml"));
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"), "junction");
  return { tmp, home };
}

const intentionalFailure = "intentional failure after SQLite allocation";
const counterfactualFailure = "counterfactual first-file failure after allocation receipt";
const fixtureTests = [
  [
    "tui-pty-harness.e2e.test.ts",
    "opens actual fallback SQLite and retains it until the worker finishes",
  ],
  [
    "tui-pty-local.e2e.test.ts",
    "keeps the same worker namespace alive across files and module resets",
  ],
] as const;

function expectFixtureResults(
  report: JsonTestResults,
  testRoot: string,
  failRun: boolean,
  failFirstFile = false,
) {
  expect(report.testResults.map((file) => file.name)).toEqual(
    fixtureTests.map(([filename]) => path.join(testRoot, filename)),
  );
  for (const [index, [, expectedTitle]] of fixtureTests.entries()) {
    const file = report.testResults[index]!;
    const failure =
      index === 0
        ? failFirstFile
          ? counterfactualFailure
          : undefined
        : failRun
          ? intentionalFailure
          : undefined;
    const expectedStatus = failure ? "failed" : "passed";
    expect(file.status, file.name).toBe(expectedStatus);
    expect(file.message, file.name).toBe("");
    expect(
      file.assertionResults.map(
        ({ ancestorTitles, fullName, title: caseTitle, status, failureMessages }) => ({
          ancestorTitles,
          fullName,
          title: caseTitle,
          status,
          failureMessages: failureMessages?.map((message) => message.split("\n")[0]),
        }),
      ),
      file.name,
    ).toEqual([
      {
        ancestorTitles: [],
        fullName: expectedTitle,
        title: expectedTitle,
        status: expectedStatus,
        failureMessages: failure ? [`AssertionError: ${failure}`] : [],
      },
    ]);
  }
  const failed = Number(failRun) + Number(failFirstFile);
  expect(report).toMatchObject({
    numTotalTests: 2,
    numPassedTests: 2 - failed,
    numFailedTests: failed,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTestSuites: 2,
    numPassedTestSuites: 2 - failed,
    numFailedTestSuites: failed,
    numPendingTestSuites: 0,
    success: failed === 0,
  });
}

const cleanupCases = [
  { route: "main", pool: "threads", failRun: false },
  { route: "main", pool: "threads", failRun: true },
  { route: "main", pool: "forks", failRun: false },
  { route: "main", pool: "forks", failRun: true },
  ...["batch", "live", "profile-main", "profile-runner", "pty"].flatMap((route) => [
    { route, pool: "threads", failRun: false },
    { route, pool: "forks", failRun: true },
  ]),
  ...["profile-main", "profile-runner"].flatMap((route) => [
    { route, pool: "forks", failRun: false },
    { route, pool: "threads", failRun: true },
  ]),
].map((testCase) =>
  Object.assign(testCase, {
    pauseAfterAck: false,
    failFirstFile: false,
    homePolicy: "isolated",
  }),
);
cleanupCases.push({
  route: "profile-runner",
  pool: "forks",
  failRun: true,
  pauseAfterAck: true,
  failFirstFile: false,
  homePolicy: "isolated",
});

posixIt.each([
  ...cleanupCases,
  ...["threads", "forks"].map((pool) => ({
    route: "main",
    pool,
    failRun: true,
    pauseAfterAck: false,
    failFirstFile: true,
    homePolicy: "isolated",
  })),
  ...[
    "hermetic-ambient",
    "staged-live",
    "real-home",
    "profile-only",
    "profile-only-parent-shell",
  ].flatMap((homePolicy) =>
    ["threads", "forks"].map((pool) => ({
      route: homePolicy === "staged-live" ? "live" : "owned",
      pool,
      homePolicy,
      failRun: false,
      pauseAfterAck: false,
      failFirstFile: false,
    })),
  ),
])(
  "$route cleans its namespace after $pool completion ($homePolicy, failed run: $failRun, paused after acknowledgement: $pauseAfterAck, first-file failure: $failFirstFile)",
  async ({ route, pool, failRun, pauseAfterAck, failFirstFile, homePolicy }) => {
    const root = tempDirs.make("oc-vt-state-");
    const profileOnly = homePolicy === "profile-only" || homePolicy === "profile-only-parent-shell";
    const { tmp, home } = prepareVitestFixture(root, profileOnly ? "home-$source" : "home");
    const realHome = homePolicy === "real-home";
    const hermetic = homePolicy === "hermetic-ambient";
    const profileLoaded = profileOnly || ["staged-live", "real-home"].includes(homePolicy);
    const staged = homePolicy === "staged-live";
    const syntheticCredential = "synthetic-home-source-only";
    const credentialRelativePath = ".claude/.credentials.json";
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, credentialRelativePath), syntheticCredential);
    fs.writeFileSync(path.join(home, "profile-marker"), "synthetic-profile");
    fs.writeFileSync(
      path.join(home, ".profile"),
      'export VITEST_HOME_SOURCE_MARKER=$(cat "$HOME/profile-marker")\n',
    );

    // These namespaces belong to callers, not the child invocation. Keep an open
    // SQLite reader in a sibling PID namespace throughout the real Vitest run.
    const siblingRoot = path.join(tmp, "openclaw-test-state", `${process.pid}-7`);
    fs.mkdirSync(siblingRoot, { recursive: true });
    const sibling = new DatabaseSync(path.join(siblingRoot, "sentinel.sqlite"));
    const explicitPath = path.join(home, "live-state", "state", "openclaw.sqlite");
    const receiptPath = path.join(root, "receipt.json");
    const databaseModule = JSON.stringify(path.join(repoRoot, "src/state/openclaw-state-db.ts"));
    const setupModule = path.join(repoRoot, hermetic ? "test/setup.env.ts" : "test/setup.ts");
    const configReceiptPath = path.join(root, "config-home.json");
    const testRoot = path.join(root, "src/tui");
    const configRoot = path.join(root, "test/vitest");
    fs.mkdirSync(testRoot, { recursive: true });
    fs.mkdirSync(configRoot, { recursive: true });
    fs.writeFileSync(path.join(root, "tiny.ts"), "export const answer: number = 42;");
    fs.writeFileSync(
      path.join(root, "resources.ts"),
      `
import fs from "node:fs";
import path from "node:path";
import os, { homedir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { createJiti } from "jiti";
import { expect, vi } from "vitest";
import { resolveOpenClawStateSqlitePath } from ${JSON.stringify(path.join(repoRoot, "src/state/openclaw-state-db.paths.ts"))};
import { withTempHomeCore } from ${JSON.stringify(path.join(repoRoot, "src/plugin-sdk/test-helpers/temp-home.ts"))};
import { createTempHomeEnv } from ${JSON.stringify(path.join(repoRoot, "src/test-utils/temp-home.ts"))};
const capturedDefault = os.homedir;
const capturedNamed = homedir;
const capturedHome = homedir();
const namespace = os.tmpdir();
const allowedRoot = ${realHome ? JSON.stringify(home) : "namespace"};
function assertContained(value) {
  const relative = path.relative(allowedRoot, value);
  expect(!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep), value).toBe(true);
}
export function assertHomeBoundary() {
  for (const value of [os.homedir(), homedir(), capturedDefault(), capturedNamed(), capturedHome]) assertContained(value);
  // The actual env:{} resolver must be contained before any database is opened.
  const fallbackPath = resolveOpenClawStateSqlitePath({});
  assertContained(fallbackPath);
  return fallbackPath;
}
assertHomeBoundary();
export function restoreHomeMocks() {
  vi.spyOn(os, "homedir").mockReturnValue(path.join(namespace, "mock-home"));
  syncBuiltinESMExports();
  expect(os.homedir()).toBe(path.join(namespace, "mock-home"));
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  assertHomeBoundary();
}
export async function allocateResources() {
  const home = process.env.HOME;
  expect(process.env.VITEST_HOME_SOURCE_MARKER).toBe(${profileLoaded ? '"synthetic-profile"' : "undefined"});
  expect(process.env.VITEST_UNREQUESTED_PROFILE).toBeUndefined();
  const credential = path.join(home, ${JSON.stringify(credentialRelativePath)});
  expect(fs.existsSync(credential)).toBe(${staged || realHome});
  if (${staged || realHome}) expect(fs.readFileSync(credential, "utf8")).toBe(${JSON.stringify(syntheticCredential)});
  ${realHome ? `expect(home).toBe(${JSON.stringify(home)});` : `assertContained(home); expect(home).not.toBe(path.join(namespace, "home"));`}
  const cache = path.join(process.env.XDG_CACHE_HOME, "openclaw/jiti/fixture");
  const jiti = createJiti(import.meta.url, { fsCache: cache, moduleCache: false, tryNative: false });
  expect((await jiti.import(${JSON.stringify(path.join(root, "tiny.ts"))})).answer).toBe(42);
  expect(fs.readdirSync(cache).length).toBeGreaterThan(0);
  let sdkHome;
  await withTempHomeCore(async (base) => { sdkHome = base; }, { skipSessionCleanup: true });
  expect(fs.existsSync(sdkHome)).toBe(false);
  const shared = await createTempHomeEnv("oc-shared-home-");
  await shared.restore();
  expect(fs.existsSync(shared.home)).toBe(false);
  const roots = [path.dirname(sdkHome), path.dirname(shared.home)];
  for (const root of roots) expect(fs.readdirSync(root)).toEqual([]);
  return { home, cache, roots };
}
`,
    );
    fs.writeFileSync(
      path.join(testRoot, fixtureTests[0][0]),
      `import fs from "node:fs";
import { expect, it } from "vitest";
import { openOpenClawStateDatabase, closeOpenClawStateDatabaseForTest } from ${databaseModule};
import { allocateResources, assertHomeBoundary, restoreHomeMocks } from "../../resources.ts";
const resources = await allocateResources();
it(${JSON.stringify(fixtureTests[0][1])}, () => {
  restoreHomeMocks();
  const fallbackPath = assertHomeBoundary();
  const first = openOpenClawStateDatabase();
  expect(first.db.prepare("SELECT count(*) AS count FROM sqlite_schema").get().count).toBeGreaterThan(0);
  closeOpenClawStateDatabaseForTest();
  expect(first.db.isOpen).toBe(false);
  const reopened = openOpenClawStateDatabase();
  const fallback = openOpenClawStateDatabase({ env: {} });
  expect(fallback.path).toBe(fallbackPath);
  const explicit = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: ${JSON.stringify(path.dirname(path.dirname(explicitPath)))} } });
  globalThis[Symbol.for("openclaw.stateLeakFixture")] = { reopened, fallback, explicit, resources, assertHomeBoundary, pid: process.pid };
  fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ path: reopened.path }));
  ${failFirstFile ? `expect.fail(${JSON.stringify(counterfactualFailure)});` : ""}
});
`,
    );
    fs.writeFileSync(
      path.join(testRoot, fixtureTests[1][0]),
      `import fs from "node:fs";
import { expect, it, vi } from "vitest";
const previous = globalThis[Symbol.for("openclaw.stateLeakFixture")];
previous.assertHomeBoundary();
vi.restoreAllMocks();
vi.resetModules();
const { allocateResources, assertHomeBoundary } = await import("../../resources.ts");
assertHomeBoundary();
const { openOpenClawStateDatabase } = await import(${databaseModule});
const resources = await allocateResources();
it(${JSON.stringify(fixtureTests[1][1])}, () => {
  expect(process.pid).toBe(previous.pid);
  expect(previous.reopened.db.isOpen).toBe(true);
  expect(previous.explicit.db.isOpen).toBe(true);
  expect(previous.fallback.db.isOpen).toBe(true);
  expect(assertHomeBoundary()).toBe(previous.fallback.path);
  const current = openOpenClawStateDatabase();
  expect(current.path).toBe(previous.reopened.path);
  expect(current.db.prepare("SELECT count(*) AS count FROM sqlite_schema").get().count).toBeGreaterThan(0);
  expect(fs.existsSync(current.path)).toBe(true);
  expect(resources.home).toBe(previous.resources.home);
  expect(resources.roots).not.toEqual(previous.resources.roots);
  fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ path: current.path, resetVerified: true, resources: [previous.resources, resources] }));
  if (process.env.OPENCLAW_TUI_PTY_MIRROR_PATH) fs.appendFileSync(process.env.OPENCLAW_TUI_PTY_MIRROR_PATH, "namespace fixture frame\\n");
  ${failRun ? `expect.fail(${JSON.stringify(intentionalFailure)});` : ""}
});
`,
    );
    const configName = route === "live" ? "live" : route === "pty" ? "tui-pty" : "unit";
    const configPath = path.join(configRoot, `vitest.${configName}.config.ts`);
    fs.writeFileSync(
      configPath,
      `import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os, { homedir } from "node:os";
import { BaseSequencer } from "vitest/node";
const capturedDefault = os.homedir;
const capturedNamed = homedir;
const capturedHome = homedir();
const namespace = os.tmpdir();
const expectedNativeHome = ${realHome ? JSON.stringify(home) : 'path.join(namespace, "home")'};
for (const value of [os.homedir(), homedir(), capturedDefault(), capturedNamed(), capturedHome]) {
  assert.equal(value, expectedNativeHome, "native home must be selected before config/application imports");
}
fs.writeFileSync(${JSON.stringify(configReceiptPath)}, JSON.stringify({ namespace, nativeHome: capturedHome }));
const { sharedVitestConfig } = await import(${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.shared.config.ts"))});
class AlphabeticalSequencer extends BaseSequencer {
  async sort(files) { return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId)); }
}
export default {
  resolve: sharedVitestConfig.resolve,
  plugins: sharedVitestConfig.plugins,
  cacheDir: ${JSON.stringify(path.join(root, ".vite"))},
  test: {
    include: ["src/tui/*.e2e.test.ts"],
    reporters: ["default", "json"],
    outputFile: ${JSON.stringify(path.join(root, "report.json"))},
    pool: ${JSON.stringify(pool)}, isolate: false, fileParallelism: false, maxWorkers: 1,
    sequence: { sequencer: AlphabeticalSequencer },
    runner: ${JSON.stringify(path.join(repoRoot, "test/non-isolated-runner.ts"))},
    setupFiles: [${JSON.stringify(setupModule)}],
  },
};
`,
    );
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      COREPACK_HOME: process.env.COREPACK_HOME,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_STATE_HOME: path.join(home, "state"),
      LIVE: "0",
      OPENCLAW_LIVE_TEST: "0",
      OPENCLAW_LIVE_GATEWAY: "0",
      CI: "1",
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
      pnpm_config_verify_deps_before_run: "false",
    };
    if (profileOnly) {
      // Node's piped stdin selects .bashrc in level-zero macOS Bash; a parent shell
      // reaches BASH_ENV instead. Neither may run before the selected profile.
      env.SHLVL = homePolicy === "profile-only-parent-shell" ? "1" : "0";
      env.BASH_ENV = path.join(root, "ambient-profile.sh");
      fs.writeFileSync(env.BASH_ENV, "export VITEST_UNREQUESTED_PROFILE=bash-env\n");
      fs.writeFileSync(path.join(home, ".bashrc"), "export VITEST_UNREQUESTED_PROFILE=bashrc\n");
    }
    if (homePolicy !== "isolated") {
      env.OPENCLAW_LIVE_TEST = profileOnly ? "0" : "1";
      env.OPENCLAW_LIVE_USE_REAL_HOME = staged ? "0" : "1";
      env.OPENCLAW_LIVE_TEST_QUIET = "1";
    }
    const vitestArgs = ["--root", root, "--configLoader", "native"];
    const profileDir = path.join(root, "profiles");
    const pauseReceipt = path.join(root, "pause.json");
    if (pauseAfterAck) {
      const preload = path.join(root, "pause-after-ack.cjs");
      fs.writeFileSync(
        preload,
        `
const { subscribe } = require("node:diagnostics_channel");
const fs = require("node:fs");
const isVitestFork = arg => typeof arg === "string" && arg.replaceAll("\\\\", "/").endsWith("/vitest/dist/workers/forks.js");
if (isVitestFork(process.argv[1]) && process.send) {
  const send = process.send;
  process.send = function(message, ...args) {
    if (message?.__vitest_worker_response__ === true && message.type === "stopped" && message.willExit === true) {
      const callbackIndex = args.length - 1;
      const callback = args[callbackIndex];
      args[callbackIndex] = function(...callbackArgs) {
        // The patched transport exits in this callback. Stop after its response
        // flushes, before that exit can race the parent's message observation.
        if (!callbackArgs[0]) process.kill(process.pid, "SIGSTOP");
        return callback.apply(this, callbackArgs);
      };
    }
    return send.call(this, message, ...args);
  };
}
subscribe("child_process", ({ process: child }) => {
  let selected = false;
  let acknowledged = false;
  child.once("spawn", () => {
    selected = child.spawnargs.some(isVitestFork);
  });
  child.on("message", message => {
    if (selected && message?.__vitest_worker_response__ === true && message.type === "stopped") acknowledged = true;
  });
  child.once("exit", (code, signal) => {
    if (selected) fs.writeFileSync(${JSON.stringify(pauseReceipt)}, JSON.stringify({ acknowledged, code, signal }));
  });
});
`,
      );
      env.NODE_OPTIONS = `--require=${preload}`;
    }
    const mirrorPath = path.join(root, "mirror.ansi");
    const batchEntry = path.join(root, "batch.mts");
    fs.writeFileSync(
      batchEntry,
      `import { runVitestBatch } from ${JSON.stringify(path.join(repoRoot, "scripts/lib/vitest-batch-runner.mts"))};
process.exitCode = await runVitestBatch({ config: ${JSON.stringify(configPath)}, args: ${JSON.stringify(vitestArgs)}, targets: [], env: process.env });`,
    );
    const ownedEntry = path.join(root, "owned.mts");
    fs.writeFileSync(
      ownedEntry,
      `import { spawnOwnedVitestProcess } from ${JSON.stringify(path.join(repoRoot, "scripts/lib/vitest-process.mts"))};
const { completion } = spawnOwnedVitestProcess({
  command: process.execPath,
  args: ${JSON.stringify([path.join(repoRoot, "node_modules/vitest/vitest.mjs"), "run", "--config", configPath, ...vitestArgs])},
  // This fixture owns the declared setup mode; ordinary routes classify their own selections.
  homeMode: ${JSON.stringify(hermetic ? "hermetic" : "live-aware")},
  options: { cwd: ${JSON.stringify(root)}, env: process.env, stdio: "inherit" },
});
process.exitCode = (await completion).code ?? 1;`,
    );
    const args =
      route === "owned"
        ? [ownedEntry]
        : route === "main"
          ? [
              path.join(repoRoot, "scripts/run-vitest.mjs"),
              "run",
              "--config",
              configPath,
              ...vitestArgs,
            ]
          : route === "batch"
            ? [batchEntry]
            : route === "live"
              ? [path.join(repoRoot, "scripts/test-live.mts"), "--", ...vitestArgs]
              : route === "pty"
                ? [
                    path.join(repoRoot, "scripts/dev/tui-pty-test-watch.ts"),
                    "--mode",
                    "all",
                    "--no-alt-screen",
                    "--mirror-path",
                    mirrorPath,
                    "--",
                    // The watcher supplies --reporter=dot, overriding config reporters.
                    "--reporter=default",
                    "--reporter=json",
                    ...vitestArgs,
                  ]
                : [
                    path.join(repoRoot, "scripts/run-vitest-profile.mts"),
                    route === "profile-main" ? "main" : "runner",
                    "--output-dir",
                    profileDir,
                    "--",
                    ...vitestArgs,
                  ];
    try {
      const result = await new Promise<{ code: ExecException["code"]; output: string }>(
        (resolve) => {
          execFile(process.execPath, args, { cwd: root, env }, (error, stdout, stderr) => {
            resolve({ code: error ? error.code : 0, output: stdout + stderr });
          });
        },
      );
      expect(result.code, result.output).toBe(failRun ? 1 : 0);
      if (failRun) {
        expect(result.output).toContain(intentionalFailure);
      }
      if (pauseAfterAck) {
        expect(JSON.parse(fs.readFileSync(pauseReceipt, "utf8"))).toEqual({
          acknowledged: true,
          code: null,
          signal: "SIGKILL",
        });
      }
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as {
        path: string;
        resetVerified: boolean;
        resources: Array<{ home: string; cache: string; roots: string[] }>;
      };
      expect(receipt.resetVerified).toBe(true);
      const configReceipt = JSON.parse(fs.readFileSync(configReceiptPath, "utf8"));
      expect(path.dirname(configReceipt.namespace)).toBe(tmp);
      expect(configReceipt.nativeHome).toBe(
        realHome ? home : path.join(configReceipt.namespace, "home"),
      );
      expect(fs.existsSync(configReceipt.namespace)).toBe(false);
      expect(fs.readFileSync(path.join(home, credentialRelativePath), "utf8")).toBe(
        syntheticCredential,
      );
      for (const resource of receipt.resources) {
        for (const owned of [resource.home, resource.cache, ...resource.roots]) {
          expect(fs.existsSync(owned), owned).toBe(
            realHome && (owned === resource.home || owned === resource.cache),
          );
        }
      }
      if (route.startsWith("profile-")) {
        const artifacts = fs.readdirSync(profileDir);
        const profileEvidence = `${result.output}\nProfile artifacts: ${JSON.stringify(artifacts)}`;
        expect(
          artifacts.some((file) => file.endsWith(".cpuprofile")),
          profileEvidence,
        ).toBe(true);
        if (route === "profile-runner") {
          expect(
            artifacts.some((file) => file.endsWith(".heapprofile")),
            profileEvidence,
          ).toBe(true);
        }
        for (const artifact of artifacts) {
          const profile = JSON.parse(fs.readFileSync(path.join(profileDir, artifact), "utf8"));
          if (artifact.endsWith(".cpuprofile")) {
            expect(profile.nodes.length, artifact).toBeGreaterThan(0);
            expect(profile.samples.length, artifact).toBeGreaterThan(0);
            expect(profile.endTime, artifact).toBeGreaterThan(profile.startTime);
          } else if (artifact.endsWith(".heapprofile")) {
            expect(profile.head.children.length, artifact).toBeGreaterThan(0);
            expect(profile.samples.length, artifact).toBeGreaterThan(0);
          }
        }
      }
      if (route === "pty") {
        expect(fs.readFileSync(mirrorPath, "utf8")).toContain("namespace fixture frame");
      }
      expect(fs.existsSync(path.dirname(path.dirname(receipt.path)))).toBe(realHome);
      expect(sibling.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      expect(fs.existsSync(siblingRoot)).toBe(true);
      const explicit = new DatabaseSync(explicitPath, { readOnly: true });
      try {
        expect(
          explicit.prepare("SELECT count(*) AS count FROM sqlite_schema").get()?.count,
        ).toBeGreaterThan(0);
      } finally {
        explicit.close();
      }
      // Receipts can be written before Vitest marks a callback failed. Require its verdict,
      // independently of the paused-worker control's separately asserted forced teardown.
      const report = JSON.parse(
        fs.readFileSync(path.join(root, "report.json"), "utf8"),
      ) as JsonTestResults;
      if (failFirstFile) {
        // Both failures must be exact before testing rejection by the normal matrix validator.
        expectFixtureResults(report, testRoot, failRun, true);
        expect(() => expectFixtureResults(report, testRoot, failRun)).toThrowError(
          expect.objectContaining({
            actual: "failed",
            expected: "passed",
            message: expect.stringContaining(path.join(testRoot, fixtureTests[0][0])),
          }),
        );
      } else {
        expectFixtureResults(report, testRoot, failRun);
      }
    } finally {
      sibling.close();
    }
  },
);

it.each([
  { args: ["run", "--config", "test/vitest/vitest.unit-fast.config.ts"], expected: "hermetic" },
  {
    args: ["run", "--config=test/vitest/vitest.full-core-unit-fast.config.ts"],
    expected: "hermetic",
  },
  { args: ["run", "--project=unit-fast", "--project=unit-fast-isolated"], expected: "hermetic" },
  { args: ["run", "--project=unit"], expected: "live-aware" },
  { args: ["run", "--config", "test/vitest/vitest.live.config.ts"], expected: "live-aware" },
  {
    args: ["run", "--config", "test/vitest/vitest.full-core-runtime.config.ts", "--project=*"],
    expected: "live-aware",
  },
  { args: ["run", "--project=unit", "--project=unit-fast"], expected: "mixed" },
  ...["--silent", "--update", "-u", "--coverage.enabled"].map((option) => ({
    args: ["run", "--project=unit", option, "--project=unit-fast"],
    expected: "mixed",
  })),
  {
    args: ["run", "--silent", "--config", "test/vitest/vitest.live.config.ts"],
    expected: "live-aware",
  },
  {
    args: ["run", "--c=test/vitest/vitest.unit-fast.config.ts"],
    defaultConfig: "test/vitest/vitest.unit.config.ts",
    expected: "hermetic",
  },
  {
    args: ["run", "--r=custom-root"],
    defaultConfig: "test/vitest/vitest.unit.config.ts",
    expected: "unknown",
  },
  ...[
    ["-uc", "test/vitest/vitest.unit-fast.config.ts"],
    ["---c=test/vitest/vitest.unit-fast.config.ts"],
    ["--config=test/vitest/vitest.unit.config.ts", "--c=test/vitest/vitest.unit-fast.config.ts"],
    ["--project=unit", "--no-project"],
    ["--project=unit", "--project.1=unit-fast"],
    ["--project=unit", "--project.length=0"],
    ["--config=test/vitest/vitest.unit.config.ts", "--c.root=custom-root"],
  ].map((args) => ({
    args: ["run", ...args],
    defaultConfig: "test/vitest/vitest.unit.config.ts",
    expected: "unknown",
  })),
  { args: ["run"], expected: "mixed" },
  { args: ["run", "--config", "test/vitest/vitest.full-agentic.config.ts"], expected: "mixed" },
  { args: ["run", "--project=unit*"], expected: "unknown" },
  { args: ["run", "--config", "custom.config.ts"], expected: "unknown" },
  {
    args: [
      "run",
      "--root",
      "custom-root",
      "--config",
      path.join(repoRoot, "test/vitest/vitest.ui-e2e.config.ts"),
    ],
    expected: "unknown",
  },
  {
    args: [
      "run",
      "--root",
      "custom-root",
      "--config",
      path.join(repoRoot, "vitest.config.ts"),
      "--project=unit-fast",
    ],
    expected: "unknown",
  },
])(
  "enforces $expected selection before admitting an explicit real-home child: $args",
  async ({ args, expected, defaultConfig }) => {
    const root = tempDirs.make("oc-vt-home-selection-");
    const home = path.join(root, "caller-home");
    const tmp = path.join(root, "tmp");
    fs.mkdirSync(home);
    fs.mkdirSync(tmp);
    const marker = path.join(root, "child-started");
    // Resolving a config must never evaluate its contents in the caller process.
    fs.writeFileSync(
      path.join(root, "custom.config.ts"),
      `throw new Error("config evaluated before admission");`,
    );
    const env = {
      HOME: home,
      USERPROFILE: home,
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      LIVE: "1",
      OPENCLAW_LIVE_TEST: "1",
      OPENCLAW_LIVE_GATEWAY: "1",
      OPENCLAW_LIVE_USE_REAL_HOME: "yes",
    };
    const selectionArgs = args.map((arg) =>
      arg === "custom.config.ts" ? path.join(root, arg) : arg,
    );
    const homeMode = resolveVitestHomeSelection(selectionArgs, {
      cwd: repoRoot,
      env,
      ...(defaultConfig ? { defaultConfig } : {}),
    });
    expect(homeMode).toBe(expected);
    const spec = {
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        `
import fs from "node:fs";
import os, { homedir } from "node:os";
import { Worker } from "node:worker_threads";
fs.writeFileSync(${JSON.stringify(marker)}, "started");
const captured = homedir;
const worker = new Worker('const {parentPort} = require("node:worker_threads"); parentPort.postMessage(require("node:os").homedir());', {
  eval: true, execArgv: [], env: { ...process.env, HOME: "worker-only-home", USERPROFILE: "worker-only-home" },
});
const workerHome = await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
await worker.terminate();
console.log(JSON.stringify({ namespace: os.tmpdir(), homes: [os.homedir(), homedir(), captured(), workerHome], live: process.env.LIVE }));
`,
      ],
      homeMode,
      options: { env, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] },
    };
    if (expected === "mixed" || expected === "unknown") {
      expect(() => spawnOwnedVitestProcess(spec)).toThrow("known wholly live-aware selection");
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.readdirSync(tmp)).toEqual([]);
      return;
    }
    const { child, completion } = spawnOwnedVitestProcess(spec);
    let output = "";
    child.stdout!.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr!.resume();
    expect((await completion).code).toBe(0);
    const observed = JSON.parse(output);
    expect(observed.homes).toEqual(
      Array(4).fill(expected === "hermetic" ? path.join(observed.namespace, "home") : home),
    );
    expect(observed.live).toBe(expected === "hermetic" ? undefined : "1");
    expect(fs.existsSync(home)).toBe(true);
    expect(fs.existsSync(observed.namespace)).toBe(process.platform === "win32");
  },
);

it("retains native home after child and pipes close when descendants cannot be verified", async () => {
  const root = tempDirs.make("oc-vt-home-retained-");
  const parent = createVitestResourceOwner(root);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { child, completion } = spawnOwnedVitestProcess({
    command: process.execPath,
    args: [
      "--input-type=module",
      "-e",
      'import os from "node:os"; console.log(JSON.stringify({ home: os.homedir(), namespace: os.tmpdir() }));',
    ],
    homeMode: "hermetic",
    options: { detached: false, env: { TMPDIR: root }, stdio: ["ignore", "pipe", "pipe"] },
  });
  let output = "";
  child.stdout!.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr!.resume();
  try {
    expect((await completion).code).toBe(0);
    const observed = JSON.parse(output);
    expect(observed.home).toBe(path.join(observed.namespace, "home"));
    expect(path.dirname(observed.namespace)).toBe(root);
    expect(fs.existsSync(observed.home)).toBe(true);
    expect(() => parent.assertReleased()).toThrow("Unreleased Vitest resource claim");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(`retained temporary namespace ${observed.namespace}`),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("descendant completion is unverified"),
    );
  } finally {
    log.mockRestore();
  }
});

posixIt.for([
  { pool: "threads", mode: "failure" },
  { pool: "forks", mode: "failure" },
  { pool: "threads", mode: "swallowed" },
  { pool: "threads", mode: "crash" },
  { pool: "forks", mode: "crash" },
] as const)(
  "preserves nested managed-child retention after outer $pool completion ($mode)",
  { timeout: 80_000 },
  async ({ pool, mode }, { signal }) =>
    nestedLifetime.run(async () => {
      const evidence = path.join(repoRoot, ".artifacts/nested-retention");
      fs.mkdirSync(evidence, { recursive: true });
      const root = fs.mkdtempSync(path.join(evidence, `${pool}-${mode}-`));
      prepareVitestFixture(root);
      await proveNestedRetention(root, pool, signal, mode);
      expect(fs.existsSync(root), "successful joined fixture must be removed").toBe(false);
    }),
);

it("removes only its namespace when spawning fails before acquiring a PID", async () => {
  const root = tempDirs.make("oc-vt-spawn-");
  const sentinel = path.join(root, "caller");
  fs.writeFileSync(sentinel, "keep");
  const options = { env: { TMPDIR: root }, stdio: "ignore" as const };
  expect(() => spawnOwnedVitestProcess({ command: "", args: [], options })).toThrow();
  const { child, completion } = spawnOwnedVitestProcess({
    command: process.execPath,
    args: [],
    options: { ...options, cwd: path.join(root, "missing") },
  });
  await expect(completion).rejects.toMatchObject({ code: "ENOENT" });
  expect(child.pid).toBeUndefined();
  expect(fs.readdirSync(root)).toEqual(["caller"]);
  expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
});

posixIt.each([
  "released",
  "pending",
  "missing receipt",
  "corrupt receipt",
  "unreadable receipt",
  "missing owner",
  "missing registry",
  "missing parent registry",
])("requires positive nested release evidence: %s", async (mode) => {
  const root = tempDirs.make("oc-vt-receipt-");
  const parent = createVitestResourceOwner(root);
  const receipt = path.join(root, "namespace");
  const { completion } = spawnOwnedVitestProcess({
    command: process.execPath,
    args: [
      "--input-type=module",
      "-e",
      `
      import fs from 'node:fs';
      import path from 'node:path';
      import os from 'node:os';
      import { findVitestResourceOwner } from ${JSON.stringify(path.join(repoRoot, "scripts/lib/vitest-resource-ownership.mts"))};
      const root = os.tmpdir(), mode = ${JSON.stringify(mode)};
      fs.writeFileSync(${JSON.stringify(receipt)}, root);
      const release = findVitestResourceOwner().claim();
      const metadata = path.join(root, '.vitest-resource-owner');
      const claims = path.join(metadata, 'claims');
      const released = path.join(claims, fs.readdirSync(claims)[0], 'released');
      if (mode !== 'pending') release();
      if (mode === 'missing receipt' || mode === 'unreadable receipt') fs.unlinkSync(released);
      if (mode === 'unreadable receipt') fs.mkdirSync(released);
      if (mode === 'corrupt receipt') fs.writeFileSync(released, 'not a completion receipt');
      if (mode === 'missing owner') fs.unlinkSync(path.join(metadata, 'owner'));
      if (mode === 'missing registry') fs.rmSync(claims, { recursive: true });
      if (mode === 'missing parent registry') fs.rmSync(path.join(path.dirname(root), '.vitest-resource-owner', 'claims'), { recursive: true });
    `,
    ],
    options: { env: { TMPDIR: root }, stdio: "ignore" },
  });
  if (mode === "released") {
    await expect(completion).resolves.toMatchObject({ code: 0 });
    expect(() => parent.assertReleased()).not.toThrow();
  } else {
    await expect(completion).rejects.toThrow("retained temporary namespace");
    if (mode === "missing parent registry") {
      await expect(completion).rejects.toThrow(`retained temporary namespace ${root};`);
      expect(() => parent.assertReleased()).toThrow(/ENOENT/);
    } else {
      expect(() => parent.assertReleased()).toThrow("Unreleased Vitest resource claim");
    }
  }
  const namespace = fs.readFileSync(receipt, "utf8");
  expect(fs.existsSync(namespace)).toBe(!["released", "missing parent registry"].includes(mode));
});

posixIt("rejects resource registration before allocating inputs or launching work", async () => {
  const root = tempDirs.make("oc-vt-admission-");
  createVitestResourceOwner(root);
  const claims = path.join(root, ".vitest-resource-owner", "claims");
  fs.rmdirSync(claims);
  fs.writeFileSync(claims, "registry unavailable");
  const launched = path.join(root, "launched");
  const args = ["-e", `require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'launched')`];
  const env = { TMPDIR: root, TMP: root, TEMP: root };
  expect(() =>
    spawnOwnedVitestProcess({ command: process.execPath, args, options: { env } }),
  ).toThrow();
  await expect(runManagedCommand({ bin: process.execPath, args, env })).rejects.toThrow();
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  try {
    const lifetime = createFixtureLifetime();
    const body = vi.fn(async () => {});
    expect(() => lifetime.run(body)).toThrow();
    expect(() => lifetime.createTempDir("unadmitted-")).toThrow();
    await Promise.resolve();
    expect(body).not.toHaveBeenCalled();
    expect(fs.existsSync(launched)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([".vitest-resource-owner"]);
  } finally {
    vi.unstubAllEnvs();
  }
});

posixIt(
  "retains the exact namespace with recovery guidance when group verification fails",
  async () => {
    const root = tempDirs.make("oc-vt-unverified-");
    createVitestResourceOwner(root);
    const receipt = path.join(root, "namespace");
    const { child, completion } = spawnOwnedVitestProcess({
      command: process.execPath,
      args: [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(receipt)}, require("node:os").tmpdir())`,
      ],
      options: { env: { TMPDIR: root }, stdio: "ignore" },
    });
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    const nativeKill = process.kill.bind(process);
    const failure = Object.assign(new Error("injected group probe failure"), { code: "EIO" });
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -child.pid! && signal === 0) {
        throw failure;
      }
      return nativeKill(pid, signal);
    });
    try {
      await expect(completion).rejects.toMatchObject({
        message: expect.stringContaining(
          "Stop the remaining writers before removing this exact directory",
        ),
        cause: failure,
      });
      await closed;
      const namespace = fs.readFileSync(receipt, "utf8");
      expect(path.dirname(namespace)).toBe(root);
      expect(fs.existsSync(namespace)).toBe(true);
    } finally {
      kill.mockRestore();
      await closed;
    }
  },
);
