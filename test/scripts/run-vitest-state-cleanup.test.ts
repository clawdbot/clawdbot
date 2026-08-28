import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const posixIt = process.platform === "win32" ? it.skip : it;

posixIt.each([
  { pool: "threads", failRun: false },
  { pool: "threads", failRun: true },
  { pool: "forks", failRun: false },
  { pool: "forks", failRun: true },
])(
  "cleans fallback SQLite after $pool completion (failed run: $failRun)",
  async ({ pool, failRun }) => {
    const root = tempDirs.make("oc-vt-state-");
    const tmp = path.join(root, "tmp");
    const home = path.join(root, "home");
    fs.mkdirSync(tmp);
    fs.mkdirSync(home);
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
    fs.writeFileSync(
      path.join(root, "01-open.test.ts"),
      `import fs from "node:fs";
import { expect, it } from "vitest";
import { openOpenClawStateDatabase, closeOpenClawStateDatabaseForTest } from ${databaseModule};
it("opens actual fallback SQLite and retains it until the worker finishes", () => {
  const first = openOpenClawStateDatabase();
  expect(first.db.prepare("SELECT count(*) AS count FROM sqlite_schema").get().count).toBeGreaterThan(0);
  closeOpenClawStateDatabaseForTest();
  expect(first.db.isOpen).toBe(false);
  const reopened = openOpenClawStateDatabase();
  const explicit = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: ${JSON.stringify(path.dirname(path.dirname(explicitPath)))} } });
  globalThis[Symbol.for("openclaw.stateLeakFixture")] = { reopened, explicit, pid: process.pid };
  fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ path: reopened.path }));
});
`,
    );
    fs.writeFileSync(
      path.join(root, "02-reset.test.ts"),
      `import fs from "node:fs";
import { expect, it, vi } from "vitest";
it("keeps the same worker namespace alive across files and module resets", async () => {
  const previous = globalThis[Symbol.for("openclaw.stateLeakFixture")];
  expect(process.pid).toBe(previous.pid);
  expect(previous.reopened.db.isOpen).toBe(true);
  expect(previous.explicit.db.isOpen).toBe(true);
  vi.resetModules();
  const { openOpenClawStateDatabase } = await import(${databaseModule});
  const current = openOpenClawStateDatabase();
  expect(current.path).toBe(previous.reopened.path);
  expect(current.db.prepare("SELECT count(*) AS count FROM sqlite_schema").get().count).toBeGreaterThan(0);
  expect(fs.existsSync(current.path)).toBe(true);
  fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ path: current.path, resetVerified: true }));
  ${failRun ? 'expect.fail("intentional failure after SQLite allocation");' : ""}
});
`,
    );
    const configPath = path.join(root, "vitest.config.ts");
    fs.writeFileSync(
      configPath,
      `import { sharedVitestConfig } from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.shared.config.ts"))};
import { BaseSequencer } from "vitest/node";
class AlphabeticalSequencer extends BaseSequencer {
  async sort(files) { return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId)); }
}
export default {
  resolve: sharedVitestConfig.resolve,
  cacheDir: ${JSON.stringify(path.join(root, ".vite"))},
  test: {
    pool: ${JSON.stringify(pool)}, isolate: false, fileParallelism: false, maxWorkers: 1,
    sequence: { sequencer: AlphabeticalSequencer },
    runner: ${JSON.stringify(path.join(repoRoot, "test/non-isolated-runner.ts"))},
    setupFiles: [${JSON.stringify(setupModule)}],
  },
};
`,
    );
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("VITEST") || key.startsWith("OPENCLAW_") || key === "LIVE") {
        delete env[key];
      }
    }
    Object.assign(env, { HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp });
    try {
      const result = await execFileAsync(
        process.execPath,
        [
          path.join(repoRoot, "scripts/run-vitest.mjs"),
          "run",
          "--root",
          root,
          "--config",
          configPath,
        ],
        { cwd: repoRoot, env },
      ).then(
        ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
        (error: { code: number; stdout: string; stderr: string }) => ({
          code: error.code,
          output: error.stdout + error.stderr,
        }),
      );
      expect(result.code, result.output).toBe(failRun ? 1 : 0);
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as {
        path: string;
        resetVerified: boolean;
      };
      expect(receipt.resetVerified).toBe(true);
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
