import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { spawnOwnedVitestProcess } from "../../scripts/lib/vitest-process.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const posixIt = process.platform === "win32" ? it.skip : it;

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
].map((testCase) => ({ ...testCase, pauseAfterAck: false }));
cleanupCases.push({ route: "profile-runner", pool: "forks", failRun: true, pauseAfterAck: true });

posixIt.each(cleanupCases)(
  "$route cleans its namespace after $pool completion (failed run: $failRun, paused after acknowledgement: $pauseAfterAck)",
  async ({ route, pool, failRun, pauseAfterAck }) => {
    const root = tempDirs.make("oc-vt-state-");
    const tmp = path.join(root, "tmp");
    const home = path.join(root, "home");
    fs.mkdirSync(tmp);
    fs.mkdirSync(home);
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ private: true, type: "module", packageManager: packageJson.packageManager }),
    );
    fs.symlinkSync(
      path.join(repoRoot, "node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );

    // These namespaces belong to callers, not the child invocation. Keep an open
    // SQLite reader in a sibling PID namespace throughout the real Vitest run.
    const siblingRoot = path.join(tmp, "openclaw-test-state", `${process.pid}-7`);
    fs.mkdirSync(siblingRoot, { recursive: true });
    const sibling = new DatabaseSync(path.join(siblingRoot, "sentinel.sqlite"));
    const explicitPath = path.join(home, "live-state", "state", "openclaw.sqlite");
    const receiptPath = path.join(root, "receipt.json");
    const databaseModule = JSON.stringify(path.join(repoRoot, "src/state/openclaw-state-db.ts"));
    const setupModule = path.join(repoRoot, "test/setup.ts");
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
import { createJiti } from "jiti";
import { expect } from "vitest";
import { withTempHomeCore } from ${JSON.stringify(path.join(repoRoot, "src/plugin-sdk/test-helpers/temp-home.ts"))};
import { createTempHomeEnv } from ${JSON.stringify(path.join(repoRoot, "src/test-utils/temp-home.ts"))};
export async function allocateResources() {
  const home = process.env.HOME;
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
      path.join(testRoot, "tui-pty-harness.e2e.test.ts"),
      `import fs from "node:fs";
import { expect, it } from "vitest";
import { openOpenClawStateDatabase, closeOpenClawStateDatabaseForTest } from ${databaseModule};
import { allocateResources } from "../../resources.ts";
const resources = await allocateResources();
it("opens actual fallback SQLite and retains it until the worker finishes", () => {
  const first = openOpenClawStateDatabase();
  expect(first.db.prepare("SELECT count(*) AS count FROM sqlite_schema").get().count).toBeGreaterThan(0);
  closeOpenClawStateDatabaseForTest();
  expect(first.db.isOpen).toBe(false);
  const reopened = openOpenClawStateDatabase();
  const explicit = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: ${JSON.stringify(path.dirname(path.dirname(explicitPath)))} } });
  globalThis[Symbol.for("openclaw.stateLeakFixture")] = { reopened, explicit, resources, pid: process.pid };
  fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ path: reopened.path }));
});
`,
    );
    fs.writeFileSync(
      path.join(testRoot, "tui-pty-local.e2e.test.ts"),
      `import fs from "node:fs";
import { expect, it, vi } from "vitest";
const previous = globalThis[Symbol.for("openclaw.stateLeakFixture")];
vi.resetModules();
const { openOpenClawStateDatabase } = await import(${databaseModule});
const { allocateResources } = await import("../../resources.ts");
const resources = await allocateResources();
it("keeps the same worker namespace alive across files and module resets", () => {
  expect(process.pid).toBe(previous.pid);
  expect(previous.reopened.db.isOpen).toBe(true);
  expect(previous.explicit.db.isOpen).toBe(true);
  const current = openOpenClawStateDatabase();
  expect(current.path).toBe(previous.reopened.path);
  expect(current.db.prepare("SELECT count(*) AS count FROM sqlite_schema").get().count).toBeGreaterThan(0);
  expect(fs.existsSync(current.path)).toBe(true);
  expect(resources.home).toBe(previous.resources.home);
  expect(resources.roots).not.toEqual(previous.resources.roots);
  fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ path: current.path, resetVerified: true, resources: [previous.resources, resources] }));
  if (process.env.OPENCLAW_TUI_PTY_MIRROR_PATH) fs.appendFileSync(process.env.OPENCLAW_TUI_PTY_MIRROR_PATH, "namespace fixture frame\\n");
  ${failRun ? 'expect.fail("intentional failure after SQLite allocation");' : ""}
});
`,
    );
    const configName = route === "live" ? "live" : route === "pty" ? "tui-pty" : "unit";
    const configPath = path.join(configRoot, `vitest.${configName}.config.ts`);
    fs.writeFileSync(
      configPath,
      `import { sharedVitestConfig } from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.shared.config.ts"))};
import { BaseSequencer } from "vitest/node";
class AlphabeticalSequencer extends BaseSequencer {
  async sort(files) { return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId)); }
}
export default {
  resolve: sharedVitestConfig.resolve,
  plugins: sharedVitestConfig.plugins,
  cacheDir: ${JSON.stringify(path.join(root, ".vite"))},
  test: {
    include: ["src/tui/*.e2e.test.ts"],
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
subscribe("child_process", ({ process: child }) => {
  let selected = false;
  let paused = false;
  child.once("spawn", () => {
    selected = child.spawnargs.some(arg => arg.replaceAll("\\\\", "/").endsWith("/vitest/dist/workers/forks.js"));
  });
  child.on("message", message => {
    if (!selected || paused || message?.__vitest_worker_response__ !== true || message.type !== "stopped") return;
    // No I/O before the signal: even logging can let native exit profiling finish.
    paused = child.kill("SIGSTOP");
  });
  child.once("exit", (code, signal) => {
    if (selected) fs.writeFileSync(${JSON.stringify(pauseReceipt)}, JSON.stringify({ paused, code, signal }));
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
    const args =
      route === "main"
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
      const result = await execFileAsync(process.execPath, args, { cwd: root, env }).then(
        ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
        (error: { code: number; stdout: string; stderr: string }) => ({
          code: error.code,
          output: error.stdout + error.stderr,
        }),
      );
      expect(result.code, result.output).toBe(failRun ? 1 : 0);
      if (failRun) expect(result.output).toContain("intentional failure after SQLite allocation");
      if (pauseAfterAck) {
        expect(JSON.parse(fs.readFileSync(pauseReceipt, "utf8"))).toEqual({
          paused: true,
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
      for (const resource of receipt.resources) {
        for (const owned of [resource.home, resource.cache, ...resource.roots]) {
          expect(fs.existsSync(owned), owned).toBe(false);
        }
      }
      if (route.startsWith("profile-")) {
        const artifacts = fs.readdirSync(profileDir);
        const profileEvidence = `${result.output}\nProfile artifacts: ${JSON.stringify(artifacts)}`;
        expect(
          artifacts.some((file) => file.endsWith(".cpuprofile")),
          profileEvidence,
        ).toBe(true);
        if (route === "profile-runner")
          expect(
            artifacts.some((file) => file.endsWith(".heapprofile")),
            profileEvidence,
          ).toBe(true);
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
      if (route === "pty")
        expect(fs.readFileSync(mirrorPath, "utf8")).toContain("namespace fixture frame");
      expect(fs.existsSync(path.dirname(path.dirname(receipt.path)))).toBe(false);
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
    } finally {
      sibling.close();
    }
  },
);

posixIt("removes only its namespace when spawning fails before acquiring a PID", async () => {
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

posixIt(
  "retains the exact namespace with recovery guidance when group verification fails",
  async () => {
    const root = tempDirs.make("oc-vt-unverified-");
    const receipt = path.join(root, "namespace");
    const { child, completion } = spawnOwnedVitestProcess({
      command: process.execPath,
      args: [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(receipt)}, require("node:os").tmpdir())`,
      ],
      options: { env: { TMPDIR: root }, stdio: "ignore" },
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const nativeKill = process.kill.bind(process);
    const failure = Object.assign(new Error("injected group probe failure"), { code: "EIO" });
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -child.pid! && signal === 0) throw failure;
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
