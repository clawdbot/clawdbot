import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isProcessAlive } from "../helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const posixDescribe = process.platform === "win32" ? describe.skip : describe;

posixDescribe("bounded Vitest process ownership", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(["test-failure", "cancel"])(
    "joins fresh children and preserves %s",
    { timeout: 60_000 },
    (outcome) => {
      const root = tempDirs.make("oc-vt-bounded-");
      fs.symlinkSync(
        path.join(repoRoot, "node_modules"),
        path.join(root, "node_modules"),
        "junction",
      );
      const configPath = path.join(root, "test/vitest/vitest.e2e.config.ts");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const receiptPath = path.join(root, "executed.jsonl");
      fs.writeFileSync(
        configPath,
        `export default {
  root: ${JSON.stringify(root)},
  test: {
    include: ["case-*.test.ts"], pool: "threads", isolate: false, maxWorkers: 1,
    env: { FIXTURE_SHARD: process.argv.find(arg => arg.startsWith("--shard=")) ?? "unsharded" },
  },
};`,
      );
      for (let index = 0; index < 4; index++) {
        fs.writeFileSync(
          path.join(root, `case-${index}.test.ts`),
          `import fs from "node:fs";
import { expect, it } from "vitest";
it("case ${index}", () => {
  fs.appendFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ index: ${index}, pid: process.pid }) + "\\n");
  ${outcome === "cancel" ? 'process.kill(process.pid, "SIGTERM");' : 'expect(process.env.FIXTURE_SHARD).not.toBe("--shard=1/4");'}
});`,
        );
      }
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith("VITEST") || key.startsWith("OPENCLAW_")) {
          delete env[key];
        }
      }
      const result = spawnSync(
        process.execPath,
        [path.join(repoRoot, "scripts/run-vitest.mjs"), "run", "--config", configPath],
        {
          cwd: repoRoot,
          env: { ...env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
          encoding: "utf8",
          timeout: 45_000,
        },
      );
      expect(result.error, result.stderr).toBeUndefined();
      const receipts = fs
        .readFileSync(receiptPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { index: number; pid: number });
      if (outcome === "cancel") {
        expect(result.signal === "SIGTERM" || result.status === 143, result.stderr).toBe(true);
        expect(receipts).toHaveLength(1);
      } else {
        // The first shard fails, later shards pass: success must not erase that failure.
        expect(result.status, result.stderr).toBe(1);
        expect(receipts.map(({ index }) => index).sort()).toEqual([0, 1, 2, 3]);
        expect(new Set(receipts.map(({ pid }) => pid)).size).toBe(4);
      }
      for (const { pid } of receipts) {
        expect(isProcessAlive(pid)).toBe(false);
      }
    },
  );
});
