import { execFile, spawnSync, type ExecException } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import type { JsonTestResults } from "vitest/reporters";
import packageJson from "../../package.json" with { type: "json" };
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { resolveVitestHomeSelection } from "../../scripts/lib/vitest-home-selection.mts";
import {
  spawnOwnedVitestProcess,
  VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT,
  VITEST_OPENCLAW_RESOURCE_ROOT,
  VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN,
} from "../../scripts/lib/vitest-process.mts";
import {
  createVitestResourceOwner,
  findVitestResourceOwner,
} from "../../scripts/lib/vitest-resource-ownership.mts";
import { resolveStateDatabaseCoordinatorPath } from "../../src/infra/state-database-coordinator.js";
import {
  publishVitestResourceContext,
  resolveVitestLauncherResourceContext,
  resolveVitestResourceContext,
  VITEST_PAUSE_AFTER_ACK_RECEIPT,
  VITEST_RESOURCE_CONTEXT_NODE_OPTION,
} from "../../src/infra/vitest-resource-context.test-support.js";
import {
  applyVitestResourceContextToChildEnv,
  type VitestResourceContextDescriptor,
  VITEST_RESOURCE_CONTEXT_SYMBOL,
} from "../../src/infra/vitest-resource-ownership.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { installTestEnv } from "../test-env.js";
import { proveNestedRetention } from "./nested-retention.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const nestedLifetime = createFixtureLifetime();
afterEach(() => nestedLifetime.cleanup());
const repoRoot = path.resolve(import.meta.dirname, "../..");
const posixIt = process.platform === "win32" ? it.skip : it;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

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
    const realHome = homePolicy === "real-home";
    const root = tempDirs.make(
      "oc-vt-state-",
      realHome && process.platform !== "win32" ? fs.realpathSync("/tmp") : undefined,
    );
    const profileOnly = homePolicy === "profile-only" || homePolicy === "profile-only-parent-shell";
    const { tmp, home } = prepareVitestFixture(root, profileOnly ? "home-$source" : "home");
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
    const generatedGlobalCoordinatorPaths = realHome
      ? [resolveOpenClawStateSqlitePath({ HOME: home, USERPROFILE: home }), explicitPath].flatMap(
          (databasePath) => {
            const statePath = resolveStateDatabaseCoordinatorPath({
              databasePath,
              runtimeDirectory: "/tmp",
              uid: process.getuid?.(),
            });
            return [statePath, statePath.replace("state-lifecycle.", "gateway-lifecycle.")];
          },
        )
      : [];
    const receiptPath = path.join(root, "receipt.json");
    const databaseModule = JSON.stringify(path.join(repoRoot, "src/state/openclaw-state-db.ts"));
    const coordinatorModule = JSON.stringify(
      path.join(repoRoot, "src/infra/state-database-coordinator.ts"),
    );
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
import { resolveStateLifecycleRuntimeDirectory } from ${coordinatorModule};
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
  const databasePath = resolveOpenClawStateSqlitePath({});
  const lifecycleRuntimeDirectory = resolveStateLifecycleRuntimeDirectory(databasePath);
  expect(lifecycleRuntimeDirectory).toBe(${realHome ? "resolveStateLifecycleRuntimeDirectory()" : "namespace"});
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
  return { home, cache, roots, lifecycleRuntimeDirectory };
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
      env[VITEST_PAUSE_AFTER_ACK_RECEIPT] = pauseReceipt;
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
  nodeEntryIndex: 0,
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
        resources: Array<{
          home: string;
          cache: string;
          roots: string[];
          lifecycleRuntimeDirectory: string;
        }>;
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
        expect(resource.lifecycleRuntimeDirectory).toBe(
          realHome ? "/tmp" : configReceipt.namespace,
        );
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
      for (const coordinatorPath of generatedGlobalCoordinatorPaths) {
        fs.rmSync(coordinatorPath, { force: true });
      }
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
      nodeEntryIndex: 1,
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
console.log(JSON.stringify({ namespace: os.tmpdir(), homes: [os.homedir(), homedir(), captured(), workerHome], live: process.env.LIVE, productionLockRoot: process.env.${VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT} }));
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
    expect(observed.productionLockRoot).toBe(
      process.platform === "win32"
        ? path.join(home, "AppData", "Local", "OpenClaw", "locks")
        : "/tmp",
    );
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
    nodeEntryIndex: 1,
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

it("preserves safe caller NODE_OPTIONS after the lifecycle preload", async () => {
  const root = tempDirs.make("oc-vt-node-options-");
  const { child, completion } = spawnOwnedVitestProcess({
    command: process.execPath,
    nodeEntryIndex: 0,
    args: [
      "-e",
      'console.log(JSON.stringify({ heapLimit: require("node:v8").getHeapStatistics().heap_size_limit, nodeOptions: process.env.NODE_OPTIONS }))',
    ],
    homeMode: "tooling",
    options: {
      env: {
        TMPDIR: root,
        NODE_OPTIONS: "--max-old-space-size=777 --trace-warnings",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  });
  let output = "";
  let errors = "";
  child.stdout!.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr!.on("data", (chunk) => {
    errors += chunk;
  });
  expect((await completion).code, errors).toBe(0);
  const observed = JSON.parse(output) as { heapLimit: number; nodeOptions: string };
  expect(observed.nodeOptions.startsWith(`${VITEST_RESOURCE_CONTEXT_NODE_OPTION} `)).toBe(true);
  expect(observed.nodeOptions).toContain("--max-old-space-size=777");
  expect(observed.nodeOptions).toContain("--trace-warnings");
  expect(observed.heapLimit).toBeGreaterThan(700 * 1024 * 1024);
  expect(observed.heapLimit).toBeLessThan(1_000 * 1024 * 1024);
});

it("rejects unsafe caller NODE_OPTIONS before namespace allocation", () => {
  const root = tempDirs.make("oc-vt-unsafe-node-options-");
  const launched = path.join(root, "launched");
  expect(() =>
    spawnOwnedVitestProcess({
      command: process.execPath,
      nodeEntryIndex: 0,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(launched)}, "yes")`],
      homeMode: "tooling",
      options: {
        env: { TMPDIR: root, NODE_OPTIONS: "--require fixture.cjs" },
        stdio: "ignore",
      },
    }),
  ).toThrow("NODE_OPTIONS require hooks are unsafe");
  expect(fs.existsSync(launched)).toBe(false);
  expect(fs.readdirSync(root)).toEqual([]);
});

posixIt("preserves a production lock marker only with a valid inherited owner", async () => {
  const inherited = (globalThis as Record<PropertyKey, unknown>)[
    VITEST_RESOURCE_CONTEXT_SYMBOL
  ] as VitestResourceContextDescriptor;
  if (inherited.kind !== "owned") {
    throw new Error("expected owned Vitest resource context");
  }
  const root = tempDirs.make("oc-vt-production-marker-");
  const validRoot = path.join(root, "valid-owner");
  const invalidRoot = path.join(root, "invalid-owner");
  fs.mkdirSync(validRoot);
  fs.mkdirSync(invalidRoot);
  const owner = createVitestResourceOwner(validRoot);
  const preservedRoot = inherited.productionRuntimeDirectory;
  const spoofedRoot = path.join(root, "spoofed-production-locks");
  const probe = async (env: NodeJS.ProcessEnv) => {
    const { child, completion } = spawnOwnedVitestProcess({
      command: process.execPath,
      nodeEntryIndex: 0,
      args: ["-e", `console.log(process.env.${VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT})`],
      homeMode: "tooling",
      options: { env, stdio: ["ignore", "pipe", "pipe"] },
    });
    let output = "";
    child.stdout!.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr!.resume();
    expect((await completion).code).toBe(0);
    return output.trim();
  };

  await expect(
    probe({
      TMPDIR: validRoot,
      VITEST_OPENCLAW_RESOURCE_ROOT: validRoot,
      VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
        { root: validRoot, identity: owner.identity },
      ]),
      VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT: preservedRoot,
    }),
  ).resolves.toBe(preservedRoot);
  expect(() => owner.assertReleased()).not.toThrow();
  await expect(
    probe({
      TMPDIR: invalidRoot,
      VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT: spoofedRoot,
    }),
  ).rejects.toThrow("Conflicting inherited Vitest production lock root");

  const unmarkedEnv = { ...process.env };
  delete unmarkedEnv.NODE_OPTIONS;
  delete unmarkedEnv[VITEST_OPENCLAW_RESOURCE_ROOT];
  delete unmarkedEnv[VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN];
  delete unmarkedEnv[VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT];
  const launcherModule = path.join(repoRoot, "scripts/lib/vitest-process.mts");
  const source = `
    const { spawnOwnedVitestProcess } = await import(${JSON.stringify(launcherModule)});
    const { child, completion } = spawnOwnedVitestProcess({
      command: process.execPath,
      nodeEntryIndex: 0,
      args: ["-e", ${JSON.stringify(`console.log(process.env.${VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT})`)}],
      homeMode: "tooling",
      options: {
        env: {
          TMPDIR: ${JSON.stringify(invalidRoot)},
          ${VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT}: ${JSON.stringify(spoofedRoot)},
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    process.exitCode = (await completion).code ?? 1;
  `;
  const topLevel = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    { cwd: repoRoot, encoding: "utf8", env: unmarkedEnv },
  );
  expect(topLevel.stderr).toBe("");
  expect(topLevel.status).toBe(0);
  expect(topLevel.stdout.trim()).toBe("/tmp");
});

it("publishes one cloneable context for the process and execArgv-empty Workers", async () => {
  const descriptor = (globalThis as Record<PropertyKey, unknown>)[
    VITEST_RESOURCE_CONTEXT_SYMBOL
  ] as VitestResourceContextDescriptor;
  expect(descriptor.kind).toBe("owned");
  if (descriptor.kind !== "owned") {
    throw new Error("expected owned Vitest resource context");
  }
  expect(
    descriptor.owners.every(
      (owner) =>
        typeof owner.root === "string" && typeof owner.identity === "string" && !("claim" in owner),
    ),
  ).toBe(true);
  expect(descriptor.environment).toEqual({
    [VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT]: descriptor.productionRuntimeDirectory,
    [VITEST_OPENCLAW_RESOURCE_ROOT]: descriptor.owners[0]?.root,
    [VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN]: JSON.stringify(descriptor.owners),
  });
  expect(() =>
    publishVitestResourceContext(resolveVitestResourceContext(process.env)),
  ).not.toThrow();
  expect(() => publishVitestResourceContext({ kind: "absent" })).toThrow(
    "Conflicting Vitest resource context preload",
  );

  const ownershipModule = pathToFileURL(
    path.join(repoRoot, "src/infra/vitest-resource-ownership.ts"),
  ).href;
  const contextModule = pathToFileURL(
    path.join(repoRoot, "src/infra/vitest-resource-context.test-support.ts"),
  ).href;
  const worker = new Worker(
    `
      const { parentPort } = require("node:worker_threads");
      Promise.all([
        import(${JSON.stringify(ownershipModule)}),
        import(${JSON.stringify(contextModule)}),
      ]).then(([{ getVitestResourceContext }, { resolveVitestLauncherResourceContext }]) => {
        const context = getVitestResourceContext();
        const launcherContext = resolveVitestLauncherResourceContext({
          TMPDIR: "/changed-worker-tmp",
        });
        parentPort.postMessage({
          globalPublished: Boolean(globalThis[Symbol.for("openclaw.vitest-resource-context")]),
          kind: context?.kind,
          launcherOwners: launcherContext.owners.map(({ root, identity }) => ({ root, identity })),
          launcherProductionRuntimeDirectory: launcherContext.productionRuntimeDirectory,
          owners: context?.kind === "owned" ? context.owners.map(({ root, identity, claim }) => ({ root, identity, claimType: typeof claim })) : [],
          productionRuntimeDirectory: context?.kind === "owned" ? context.productionRuntimeDirectory : undefined,
        });
      }).catch((error) => { throw error; });
    `,
    { eval: true, execArgv: [] },
  );
  const observed = await new Promise<{
    globalPublished: boolean;
    kind: string;
    launcherOwners: Array<{ root: string; identity: string }>;
    launcherProductionRuntimeDirectory: string;
    owners: Array<{ root: string; identity: string; claimType: string }>;
    productionRuntimeDirectory: string;
  }>((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  expect(observed).toEqual({
    globalPublished: false,
    kind: "owned",
    launcherOwners: descriptor.owners,
    launcherProductionRuntimeDirectory: descriptor.productionRuntimeDirectory,
    owners: descriptor.owners.map(({ root, identity }) => ({
      root,
      identity,
      claimType: "function",
    })),
    productionRuntimeDirectory: descriptor.productionRuntimeDirectory,
  });
});

it("composes complete owned context into child env and rejects partial or conflicting tuples", () => {
  const inherited = (globalThis as Record<PropertyKey, unknown>)[
    VITEST_RESOURCE_CONTEXT_SYMBOL
  ] as VitestResourceContextDescriptor;
  if (inherited.kind !== "owned") {
    throw new Error("expected owned Vitest resource context");
  }
  const childEnv: NodeJS.ProcessEnv = {
    NODE_OPTIONS: "--import=data:text/javascript,globalThis.fixture%3Dtrue",
  };
  const requiredKeys = applyVitestResourceContextToChildEnv(childEnv);
  expect(requiredKeys).toEqual(
    expect.arrayContaining([
      "NODE_OPTIONS",
      VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT,
      VITEST_OPENCLAW_RESOURCE_ROOT,
      VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN,
    ]),
  );
  expect(childEnv).toMatchObject(inherited.environment);
  expect(childEnv.NODE_OPTIONS).toContain(VITEST_RESOURCE_CONTEXT_NODE_OPTION);
  expect(childEnv.NODE_OPTIONS).toContain("globalThis.fixture%3Dtrue");

  const quotedFixture = '--import="file:///tmp/fixture preload.mjs"';
  const duplicateEnv = {
    ...inherited.environment,
    NODE_OPTIONS: `${VITEST_RESOURCE_CONTEXT_NODE_OPTION} ${quotedFixture} ${VITEST_RESOURCE_CONTEXT_NODE_OPTION}`,
  };
  applyVitestResourceContextToChildEnv(duplicateEnv);
  expect(duplicateEnv.NODE_OPTIONS.split(VITEST_RESOURCE_CONTEXT_NODE_OPTION)).toHaveLength(2);
  expect(duplicateEnv.NODE_OPTIONS).toContain('"--import=file:///tmp/fixture preload.mjs"');

  for (const requireOption of [
    "--require fixture.cjs",
    "--require=fixture.cjs",
    "-r fixture.cjs",
    "-r=fixture.cjs",
    "-rfixture.cjs",
  ]) {
    expect(() => applyVitestResourceContextToChildEnv({ NODE_OPTIONS: requireOption })).toThrow(
      "NODE_OPTIONS require hooks are unsafe",
    );
  }
  for (const startupHook of [
    "--loader fixture.mjs",
    "--loader=fixture.mjs",
    "--experimental-loader fixture.mjs",
    "--experimental_loader=fixture.mjs",
    "--experimental-config-file fixture.json",
    "--experimental_config_file=fixture.json",
    "--experimental-default-config-file",
    "--experimental_default_config_file",
  ]) {
    expect(() => applyVitestResourceContextToChildEnv({ NODE_OPTIONS: startupHook })).toThrow(
      "NODE_OPTIONS loader/config hooks are unsafe",
    );
  }
  for (const snapshotHook of [
    "--snapshot-blob fixture.blob",
    "--snapshot-blob=fixture.blob",
    "--snapshot_blob=fixture.blob",
  ]) {
    expect(() => applyVitestResourceContextToChildEnv({ NODE_OPTIONS: snapshotHook })).toThrow(
      "NODE_OPTIONS snapshot hooks are unsafe",
    );
  }
  expect(() =>
    applyVitestResourceContextToChildEnv({ NODE_OPTIONS: '--import="unterminated' }),
  ).toThrow("Invalid NODE_OPTIONS");

  expect(() =>
    applyVitestResourceContextToChildEnv({
      [VITEST_OPENCLAW_RESOURCE_ROOT]: inherited.owners[0]?.root,
    }),
  ).toThrow("Incomplete Vitest resource context in child environment");
  expect(() =>
    applyVitestResourceContextToChildEnv({
      ...inherited.environment,
      [VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT]: `${inherited.productionRuntimeDirectory}-conflict`,
    }),
  ).toThrow("Conflicting Vitest resource context in child environment");
});

it("merges explicit nested ownership with the published identity lineage", () => {
  const inherited = (globalThis as Record<PropertyKey, unknown>)[
    VITEST_RESOURCE_CONTEXT_SYMBOL
  ] as VitestResourceContextDescriptor;
  if (inherited.kind !== "owned") {
    throw new Error("expected owned Vitest resource context");
  }
  const nestedRoot = tempDirs.make("oc-vt-explicit-nested-owner-");
  const nestedOwner = createVitestResourceOwner(nestedRoot);
  const context = resolveVitestLauncherResourceContext({
    VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT: inherited.productionRuntimeDirectory,
    VITEST_OPENCLAW_RESOURCE_ROOT: nestedRoot,
    VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
      { root: nestedRoot, identity: nestedOwner.identity },
    ]),
  });
  expect(context.kind).toBe("owned");
  expect(context.owners.map(({ root, identity }) => ({ root, identity }))).toEqual([
    { root: nestedRoot, identity: nestedOwner.identity },
    ...inherited.owners,
  ]);
  expect(context.productionRuntimeDirectory).toBe(inherited.productionRuntimeDirectory);
  expect(() => nestedOwner.assertReleased()).not.toThrow();
});

it("retains only the trusted lifecycle preload through test environment setup", () => {
  const originalNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--inspect=0 ${VITEST_RESOURCE_CONTEXT_NODE_OPTION} --trace-warnings`;
  try {
    const installed = installTestEnv({ mode: "hermetic" });
    try {
      expect(process.env.NODE_OPTIONS).toBe(VITEST_RESOURCE_CONTEXT_NODE_OPTION);
    } finally {
      installed.cleanup();
    }
  } finally {
    if (originalNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = originalNodeOptions;
    }
  }
});

it("keeps the test-only environment parser out of the production coordinator graph", () => {
  const coordinatorSource = fs.readFileSync(
    path.join(repoRoot, "src/infra/state-database-coordinator.ts"),
    "utf8",
  );
  const ownershipSource = fs.readFileSync(
    path.join(repoRoot, "src/infra/vitest-resource-ownership.ts"),
    "utf8",
  );
  for (const testSupportModule of [
    "vitest-resource-context.test-support",
    "vitest-resource-context-preload.test-support",
  ]) {
    expect(coordinatorSource).not.toContain(testSupportModule);
    expect(ownershipSource).not.toContain(testSupportModule);
  }
  for (const marker of [
    VITEST_OPENCLAW_RESOURCE_ROOT,
    VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN,
    VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT,
  ]) {
    expect(coordinatorSource).not.toContain(marker);
    expect(ownershipSource).not.toContain(marker);
  }
});

posixIt(
  "inherits published lineage through a partial-env nested launcher and uses the nearest owner",
  async () => {
    const inheritedContext = (globalThis as Record<PropertyKey, unknown>)[
      VITEST_RESOURCE_CONTEXT_SYMBOL
    ] as VitestResourceContextDescriptor;
    if (inheritedContext.kind !== "owned") {
      throw new Error("expected inherited owned Vitest context");
    }
    const inheritedRoot = inheritedContext.owners[0]?.root;
    if (!inheritedRoot) {
      throw new Error("expected inherited Vitest resource owner");
    }
    const root = tempDirs.make("oc-vt-parent-owned-database-");
    const parentRoot = path.join(root, "parent-owner");
    const nestedTmp = path.join(parentRoot, "nested-tmp");
    const databasePath = path.join(parentRoot, "fixture-home", "state", "openclaw.sqlite");
    fs.mkdirSync(nestedTmp, { recursive: true });
    const parentOwner = createVitestResourceOwner(parentRoot);
    const coordinatorModule = path.join(repoRoot, "src/infra/state-database-coordinator.ts");
    const source = `
    import fs from "node:fs";
    import path from "node:path";
    const coordinatorModule = await import(${JSON.stringify(coordinatorModule)});
    const parentClaims = path.join(${JSON.stringify(parentRoot)}, ".vitest-resource-owner", "claims");
    const runtimeDirectory = coordinatorModule.resolveStateLifecycleRuntimeDirectory(${JSON.stringify(databasePath)});
    const coordinator = coordinatorModule.acquireGatewayLifecycleCoordinator({
      databasePath: ${JSON.stringify(databasePath)},
      busyTimeoutMs: 0,
    });
    const pendingBeforeRelease = fs.readdirSync(parentClaims).filter((claim) =>
      !fs.existsSync(path.join(parentClaims, claim, "released"))
    ).length;
    coordinator.release();
    const releasedAfterRelease = fs.readdirSync(parentClaims).filter((claim) =>
      fs.existsSync(path.join(parentClaims, claim, "released"))
    ).length;
    console.log(JSON.stringify({
      chain: JSON.parse(process.env.${VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN}),
      namespace: process.env.${VITEST_OPENCLAW_RESOURCE_ROOT},
      productionRuntimeDirectory: process.env.${VITEST_OPENCLAW_PRODUCTION_LOCK_ROOT},
      runtimeDirectory,
      coordinatorPath: coordinator.path,
      pendingBeforeRelease,
      releasedAfterRelease,
    }));
  `;
    const { child, completion } = spawnOwnedVitestProcess({
      command: process.execPath,
      nodeEntryIndex: 3,
      args: ["--import", "tsx", "--input-type=module", "-e", source],
      homeMode: "tooling",
      options: {
        cwd: repoRoot,
        env: { TMPDIR: nestedTmp, TMP: nestedTmp, TEMP: nestedTmp },
        stdio: ["ignore", "pipe", "pipe"],
      },
    });
    let output = "";
    let errors = "";
    child.stdout!.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr!.on("data", (chunk) => {
      errors += chunk;
    });
    const result = await completion;
    expect(result.code, errors).toBe(0);
    const observed = JSON.parse(output) as {
      chain: Array<{ root: string; identity: string }>;
      namespace: string;
      productionRuntimeDirectory: string;
      runtimeDirectory: string;
      coordinatorPath: string;
      pendingBeforeRelease: number;
      releasedAfterRelease: number;
    };
    expect(observed.chain.map((entry) => entry.root)).toEqual([
      observed.namespace,
      fs.realpathSync(parentRoot),
      inheritedRoot,
    ]);
    expect(observed.productionRuntimeDirectory).toBe(inheritedContext.productionRuntimeDirectory);
    expect(observed.runtimeDirectory).toBe(fs.realpathSync(parentRoot));
    expect(observed.coordinatorPath.startsWith(`${fs.realpathSync(parentRoot)}${path.sep}`)).toBe(
      true,
    );
    expect(observed.coordinatorPath.startsWith(`${observed.namespace}${path.sep}`)).toBe(false);
    expect(observed.pendingBeforeRelease).toBe(2);
    expect(observed.releasedAfterRelease).toBe(1);
    expect(fs.existsSync(observed.namespace)).toBe(false);
    expect(() => parentOwner.assertReleased()).not.toThrow();
  },
);

it("rejects a lineage entry whose owner identity was replaced", () => {
  const root = tempDirs.make("oc-vt-replaced-lineage-");
  const staleOwner = createVitestResourceOwner(root);
  fs.rmSync(path.join(root, ".vitest-resource-owner"), { recursive: true });
  const currentOwner = createVitestResourceOwner(root);
  const launched = path.join(root, "launched");
  const env = {
    TMPDIR: root,
    VITEST_OPENCLAW_RESOURCE_ROOT: root,
    VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([{ root, identity: staleOwner.identity }]),
  };

  expect(() =>
    spawnOwnedVitestProcess({
      command: process.execPath,
      nodeEntryIndex: 0,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(launched)}, "yes")`],
      homeMode: "tooling",
      options: { env, stdio: "ignore" },
    }),
  ).toThrow(`Invalid inherited Vitest resource root: ${root}`);
  expect(fs.existsSync(launched)).toBe(false);
  expect(() => currentOwner.assertReleased()).not.toThrow();
});

it("rejects a stale explicit resource root instead of bootstrapping new lineage", () => {
  const root = tempDirs.make("oc-vt-stale-lineage-");
  const staleRoot = path.join(root, "missing-owner");
  const launched = path.join(root, "launched");

  expect(() =>
    spawnOwnedVitestProcess({
      command: process.execPath,
      nodeEntryIndex: 0,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(launched)}, "yes")`],
      homeMode: "tooling",
      options: {
        env: {
          TMPDIR: root,
          VITEST_OPENCLAW_RESOURCE_ROOT: staleRoot,
          VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
            { root: staleRoot, identity: "00000000-0000-0000-0000-000000000000" },
          ]),
        },
        stdio: "ignore",
      },
    }),
  ).toThrow(`Invalid inherited Vitest resource root: ${staleRoot}`);
  expect(fs.existsSync(launched)).toBe(false);
  expect(fs.readdirSync(root)).toEqual([]);
});

it("allows loader-shaped application arguments after a declared Node entry script", async () => {
  const root = tempDirs.make("oc-vt-node-application-args-");
  const launched = path.join(root, "launched");
  const entry = path.join(root, "entry.mjs");
  fs.writeFileSync(
    entry,
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(launched)}, JSON.stringify(process.argv.slice(2)));`,
  );

  const { completion } = spawnOwnedVitestProcess({
    command: process.execPath,
    nodeEntryIndex: 1,
    args: ["--no-warnings", entry, "--loader", "application-value"],
    homeMode: "tooling",
    options: { env: { TMPDIR: root }, stdio: "ignore" },
  });
  await expect(completion).resolves.toMatchObject({ code: 0 });
  expect(JSON.parse(fs.readFileSync(launched, "utf8"))).toEqual(["--loader", "application-value"]);
});

it("requires a valid explicit entry boundary for Node runtime options before allocating", () => {
  const root = tempDirs.make("oc-vt-missing-node-entry-");
  const entry = path.join(repoRoot, "scripts/run-vitest.mjs");
  const args = ["--no-warnings", entry, "--loader", "application-value"];

  for (const [nodeEntryIndex, message] of [
    [undefined, "requires an explicit entry boundary"],
    [args.length, "Invalid owned Vitest Node child entry boundary"],
  ] as const) {
    expect(() =>
      spawnOwnedVitestProcess({
        command: process.execPath,
        nodeEntryIndex,
        args,
        homeMode: "tooling",
        options: { env: { TMPDIR: root }, stdio: "ignore" },
      }),
    ).toThrow(message);
  }
  expect(fs.readdirSync(root)).toEqual([]);
});

it("rejects an explicit resource root without its identity-bearing chain", () => {
  const root = tempDirs.make("oc-vt-missing-lineage-chain-");
  const owner = createVitestResourceOwner(root);
  const launched = path.join(root, "launched");

  expect(() =>
    spawnOwnedVitestProcess({
      command: process.execPath,
      nodeEntryIndex: 0,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(launched)}, "yes")`],
      homeMode: "tooling",
      options: {
        env: { TMPDIR: root, VITEST_OPENCLAW_RESOURCE_ROOT: root },
        stdio: "ignore",
      },
    }),
  ).toThrow("Inherited Vitest resource root requires an identity-bearing chain");
  expect(fs.existsSync(launched)).toBe(false);
  expect(() => owner.assertReleased()).not.toThrow();
});

it("rejects an identity-bearing chain without its resource root marker", () => {
  const root = tempDirs.make("oc-vt-missing-lineage-root-");
  const owner = createVitestResourceOwner(root);
  const launched = path.join(root, "launched");

  expect(() =>
    spawnOwnedVitestProcess({
      command: process.execPath,
      nodeEntryIndex: 0,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(launched)}, "yes")`],
      homeMode: "tooling",
      options: {
        env: {
          TMPDIR: root,
          VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([{ root, identity: owner.identity }]),
        },
        stdio: "ignore",
      },
    }),
  ).toThrow("Inherited Vitest resource root chain requires its root marker");
  expect(fs.existsSync(launched)).toBe(false);
  expect(fs.readdirSync(root)).toEqual([".vitest-resource-owner"]);
  expect(() => owner.assertReleased()).not.toThrow();
});

it("rejects inherited resource lineage without its production lock root", () => {
  const root = tempDirs.make("oc-vt-missing-production-root-");
  const owner = createVitestResourceOwner(root);
  const launched = path.join(root, "launched");

  expect(() =>
    spawnOwnedVitestProcess({
      command: process.execPath,
      nodeEntryIndex: 0,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(launched)}, "yes")`],
      homeMode: "tooling",
      options: {
        env: {
          TMPDIR: root,
          VITEST_OPENCLAW_RESOURCE_ROOT: root,
          VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([{ root, identity: owner.identity }]),
        },
        stdio: "ignore",
      },
    }),
  ).toThrow("Inherited Vitest resource lineage requires a production lock root");
  expect(fs.existsSync(launched)).toBe(false);
  expect(fs.readdirSync(root)).toEqual([".vitest-resource-owner"]);
  expect(() => owner.assertReleased()).not.toThrow();
});

posixIt(
  "retains a namespace for an escaped lifecycle coordinator until explicit safe release",
  { timeout: 20_000 },
  async () => {
    const globalRoot = fs.realpathSync("/tmp");
    const root = tempDirs.make("oc-vt-escaped-coordinator-", globalRoot);
    const ready = path.join(root, "ready.json");
    const release = path.join(root, "release");
    const done = path.join(root, "done");
    const coordinatorModule = path.join(repoRoot, "src/infra/state-database-coordinator.ts");
    const escapedSource = `
      import fs from "node:fs";
      import path from "node:path";
      const { acquireGatewayLifecycleCoordinator } = await import(${JSON.stringify(coordinatorModule)});
      const namespace = process.env.${VITEST_OPENCLAW_RESOURCE_ROOT};
      const databasePath = path.join(namespace, "escaped-state", "state", "openclaw.sqlite");
      const coordinator = acquireGatewayLifecycleCoordinator({ databasePath, busyTimeoutMs: 0 });
      fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ namespace, pid: process.pid, coordinatorPath: coordinator.path }));
      while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
      coordinator.release();
      fs.writeFileSync(${JSON.stringify(done)}, "released");
    `;
    const leaderSource = `
      import { spawn } from "node:child_process";
      import fs from "node:fs";
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", ${JSON.stringify(escapedSource)}], {
        cwd: ${JSON.stringify(repoRoot)}, detached: true, env: process.env, stdio: "ignore",
      });
      child.unref();
      for (let attempt = 0; attempt < 500 && !fs.existsSync(${JSON.stringify(ready)}); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!fs.existsSync(${JSON.stringify(ready)})) throw new Error("escaped coordinator did not start");
    `;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TMPDIR: root,
      TMP: root,
      TEMP: root,
    };
    delete env[VITEST_OPENCLAW_RESOURCE_ROOT];
    delete env[VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN];
    const { completion } = spawnOwnedVitestProcess({
      command: process.execPath,
      nodeEntryIndex: 3,
      args: ["--import", "tsx", "--input-type=module", "-e", leaderSource],
      options: { cwd: repoRoot, env, stdio: "ignore" },
    });
    let escapedPid: number | undefined;
    let namespace: string | undefined;
    try {
      await expect(completion).rejects.toThrow("retained temporary namespace");
      const receipt = JSON.parse(fs.readFileSync(ready, "utf8")) as {
        namespace: string;
        pid: number;
        coordinatorPath: string;
      };
      escapedPid = receipt.pid;
      namespace = receipt.namespace;
      expect(receipt.coordinatorPath.startsWith(`${namespace}${path.sep}`)).toBe(true);
      const owner = findVitestResourceOwner(namespace);
      expect(() => owner?.assertReleased()).toThrow("Unreleased Vitest resource claim");

      fs.writeFileSync(release, "release");
      await vi.waitFor(() => expect(fs.existsSync(done)).toBe(true));
      await vi.waitFor(() => expect(isProcessAlive(receipt.pid)).toBe(false));
      expect(() => owner?.assertReleased()).not.toThrow();
      fs.rmSync(namespace, { recursive: true });
      namespace = undefined;
    } finally {
      if ((!escapedPid || !namespace) && fs.existsSync(ready)) {
        const receipt = JSON.parse(fs.readFileSync(ready, "utf8")) as {
          namespace: string;
          pid: number;
        };
        escapedPid ??= receipt.pid;
        namespace ??= receipt.namespace;
      }
      if (escapedPid && isProcessAlive(escapedPid)) {
        fs.writeFileSync(release, "release");
        await vi
          .waitFor(() => expect(isProcessAlive(escapedPid!)).toBe(false))
          .catch(() => {
            process.kill(escapedPid!, "SIGKILL");
          });
        await vi.waitFor(() => expect(isProcessAlive(escapedPid!)).toBe(false));
      }
      if (namespace && fs.existsSync(namespace)) {
        fs.rmSync(namespace, { recursive: true });
      }
    }
  },
);

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

it.each([
  ["loader separate", ["--loader", "fixture.mjs"]],
  ["loader equals", ["--loader=fixture.mjs"]],
  ["experimental loader underscore", ["--experimental_loader=fixture.mjs"]],
  ["config separate", ["--experimental-config-file", "fixture.json"]],
  ["config underscore", ["--experimental_config_file=fixture.json"]],
  ["default config underscore", ["--experimental_default_config_file"]],
  ["debug-port alias operand", ["--debug-port", "9229", "--loader=fixture.mjs"]],
  [
    "experimental test-isolation alias operand",
    ["--experimental-test-isolation", "none", "--loader=fixture.mjs"],
  ],
] as const)("rejects unsafe Node argv before namespace allocation: %s", (_name, unsafeArgs) => {
  const root = tempDirs.make("oc-vt-unsafe-node-argv-");
  const launched = path.join(root, "launched");

  expect(() =>
    spawnOwnedVitestProcess({
      command: process.execPath,
      nodeEntryIndex: unsafeArgs.length,
      args: [
        ...unsafeArgs,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'yes')`,
      ],
      homeMode: "tooling",
      options: { env: { TMPDIR: root }, stdio: "ignore" },
    }),
  ).toThrow("Node argv loader/config hooks are unsafe");
  expect(fs.existsSync(launched)).toBe(false);
  expect(fs.readdirSync(root)).toEqual([]);
});

it.each([
  ["snapshot separate", ["--snapshot-blob", "fixture.blob"]],
  ["snapshot equals", ["--snapshot-blob=fixture.blob"]],
  ["snapshot underscore", ["--snapshot_blob=fixture.blob"]],
] as const)("rejects unsafe Node snapshot argv before namespace allocation: %s", (_name, argv) => {
  const root = tempDirs.make("oc-vt-unsafe-node-snapshot-");
  const launched = path.join(root, "launched");

  expect(() =>
    spawnOwnedVitestProcess({
      command: process.execPath,
      args: [...argv, "-e", `require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'yes')`],
      nodeEntryIndex: argv.length,
      homeMode: "tooling",
      options: { env: { TMPDIR: root }, stdio: "ignore" },
    }),
  ).toThrow("Node argv snapshot hooks are unsafe");
  expect(fs.existsSync(launched)).toBe(false);
  expect(fs.readdirSync(root)).toEqual([]);
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
    nodeEntryIndex: 1,
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
    spawnOwnedVitestProcess({
      command: process.execPath,
      args,
      nodeEntryIndex: 0,
      options: { env },
    }),
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

it("atomically closes resource admission before namespace deletion", () => {
  const root = tempDirs.make("oc-vt-closed-admission-");
  const creator = createVitestResourceOwner(root);
  const claimant = findVitestResourceOwner(root)!;
  const release = claimant.claim();

  expect(() => creator.closeAndAssertReleased()).toThrow("Unreleased Vitest resource claim");
  expect(() => claimant.claim()).toThrow(/ENOENT/);
  release();
  expect(() => creator.assertReleased()).not.toThrow();
  expect(() => creator.closeAndAssertReleased()).not.toThrow();
  expect(fs.existsSync(path.join(root, ".vitest-resource-owner", "claims"))).toBe(false);
  expect(fs.existsSync(path.join(root, ".vitest-resource-owner", "claims.closed"))).toBe(true);
});

posixIt(
  "retains the exact namespace with recovery guidance when group verification fails",
  async () => {
    const root = tempDirs.make("oc-vt-unverified-");
    createVitestResourceOwner(root);
    const receipt = path.join(root, "namespace");
    const { child, completion } = spawnOwnedVitestProcess({
      command: process.execPath,
      nodeEntryIndex: 0,
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
