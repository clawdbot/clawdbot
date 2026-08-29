import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isProcessAlive,
  waitForChildClose,
  waitForDead,
  waitForPidFile,
} from "../helpers/process-wait.js";
import { createDeferred, withTestTimeout } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const posixDescribe = process.platform === "win32" ? describe.skip : describe;

posixDescribe("bounded Vitest process ownership", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(["success", "runtime-failure", "ai-failure", "prebuilt", "skip", "custom", "cancel"])(
    "prepares the direct E2E reader generation once: %s",
    { timeout: 60_000 },
    async (outcome) => {
      const root = tempDirs.make("oc-vt-preparation-");
      const receiptsPath = path.join(root, "events.jsonl");
      const pidPath = path.join(root, "builder.pid");
      const executable = path.join(root, "command.mjs");
      const preload = path.join(root, "preload.mjs");
      fs.writeFileSync(
        executable,
        `import fs from "node:fs";
const kind = process.argv[2];
const record = (event) => fs.appendFileSync(${JSON.stringify(receiptsPath)}, JSON.stringify({
  kind, event, pid: process.pid, shard: process.argv[3],
  prebuilt: process.env.OPENCLAW_E2E_USE_PREBUILT_DIST ?? "",
  skip: process.env.OPENCLAW_E2E_SKIP_BUILD ?? "",
}) + "\\n");
record("start");
if (kind === "runtime" && ${JSON.stringify(outcome)} === "cancel") {
  fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  record("end");
  process.exit(${JSON.stringify(outcome)} === kind + "-failure" ? 7 : 0);
}
`,
      );
      // Preserve the real CLI and managed process owners; replace only the
      // expensive executables so build/read admission remains observable.
      fs.writeFileSync(
        preload,
        `import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const spawn = cp.spawn;
cp.spawn = (bin, args, options) => {
  const kind = args.includes("scripts/run-node.mjs") ? "runtime"
    : args.includes("scripts/tsdown-build.mts") ? "ai"
    : args.some(arg => arg === "vitest" || arg.endsWith("/vitest.mjs")) ? "reader" : null;
  return kind ? spawn(process.execPath, [${JSON.stringify(executable)}, kind,
    args.find(arg => arg.startsWith("--shard=")) ?? "direct"], options) : spawn(bin, args, options);
};
syncBuiltinESMExports();
`,
      );
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith("VITEST") || key.startsWith("OPENCLAW_")) delete env[key];
      }
      if (outcome === "prebuilt") env.OPENCLAW_E2E_USE_PREBUILT_DIST = "1";
      if (outcome === "skip") env.OPENCLAW_E2E_SKIP_BUILD = "1";
      const child = spawn(
        process.execPath,
        [
          "--import",
          preload,
          path.join(repoRoot, "scripts/run-vitest.mts"),
          "run",
          "--config",
          outcome === "custom"
            ? path.join(root, "custom.config.ts")
            : "test/vitest/vitest.e2e.config.ts",
        ],
        { cwd: repoRoot, env: { ...env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const closed = waitForChildClose(child, 15_000).catch((error: unknown) => error);
      const stopped = createDeferred();
      child.once("close", () => stopped.resolve());
      let builderPid: number | undefined;
      try {
        if (outcome === "cancel") {
          builderPid = await waitForPidFile(pidPath, 5_000);
          child.kill("SIGTERM");
        }
        const failed = outcome.endsWith("-failure") || outcome === "cancel";
        expect(await closed, output).toEqual({ code: failed ? 1 : 0, signal: null });
        const events = fs
          .readFileSync(receiptsPath, "utf8")
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                kind: string;
                event: string;
                pid: number;
                shard: string;
                prebuilt: string;
                skip: string;
              },
          );
        const readers = events.filter(({ kind, event }) => kind === "reader" && event === "start");
        const builds = events.filter(({ kind, event }) => kind !== "reader" && event === "start");
        expect(builds.map(({ kind }) => kind)).toEqual(
          ["prebuilt", "skip", "custom"].includes(outcome)
            ? []
            : ["runtime-failure", "cancel"].includes(outcome)
              ? ["runtime"]
              : ["runtime", "ai"],
        );
        expect(readers).toHaveLength(failed ? 0 : outcome === "custom" ? 1 : 4);
        if (outcome === "success") {
          expect(events.slice(0, 4).map(({ kind, event }) => `${kind}:${event}`)).toEqual([
            "runtime:start",
            "runtime:end",
            "ai:start",
            "ai:end",
          ]);
        }
        for (const reader of readers) {
          expect(reader.prebuilt).toBe(["success", "prebuilt"].includes(outcome) ? "1" : "");
          expect(reader.skip).toBe(outcome === "skip" ? "1" : "");
        }
        for (const pid of new Set(events.map(({ pid }) => pid))) await waitForDead(pid, 5_000);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await withTestTimeout(stopped.promise, 5_000, "E2E preparation CLI cleanup");
        if (builderPid) await waitForDead(builderPid, 5_000);
      }
    },
  );

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
