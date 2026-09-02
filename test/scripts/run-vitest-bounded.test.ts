import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  isProcessAlive,
  waitForChildClose,
  waitForDead,
  waitForPidFile,
} from "../helpers/process-wait.js";
import { createDeferred, withTestTimeout } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const posixDescribe = process.platform === "win32" ? describe.skip : describe;

const entrypoints = [
  { script: "run-vitest.mjs", direct: true, tool: "test" },
  { script: "run-vitest.mjs", direct: false, tool: "test" },
  { script: "run-vitest.mts", direct: true, tool: "vitest" },
  { script: "run-vitest.mts", direct: false, tool: "vitest" },
  ...["test-projects", "test-projects-serial", "test-projects-max", "test-projects-imports"].map(
    (name) => ({ script: `${name}.mts`, direct: false, tool: "test" }),
  ),
];

describe("Vitest CLI final outcome ownership", () => {
  it.for(
    entrypoints.flatMap((entry) =>
      [
        "failure",
        "startup",
        "success",
        "help",
        ...(process.platform === "win32" ? [] : ["signal"]),
      ].map((outcome) => ({ ...entry, outcome })),
    ),
  )(
    "$script (direct=$direct) reports $outcome after its owners settle",
    async ({ script, direct, tool, outcome }, { signal, onTestFinished }) => {
      const lifetime = createFixtureLifetime();
      onTestFinished(() => lifetime.cleanup());
      await lifetime.run(async () => {
        const root = lifetime.createTempDir("oc-vt-trailer-");
        const target = "test/scripts/run-vitest.test.ts";
        const receipt = path.join(root, "receipt.json");
        fs.mkdirSync(path.join(root, "test/scripts"), { recursive: true });
        fs.mkdirSync(path.join(root, "test/vitest"));
        fs.symlinkSync(
          path.join(repoRoot, "node_modules"),
          path.join(root, "node_modules"),
          "junction",
        );
        fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
        fs.writeFileSync(
          path.join(root, target),
          `import { afterAll, expect, it } from "vitest";
afterAll(() => process.stderr.write("fixture cleanup finished\\n"));
it("trailer fixture", async () => {
  ${outcome === "failure" ? 'expect.fail("intentional trailer fixture failure");' : outcome === "signal" ? 'process.stderr.write("fixture signal ready\\n"); await new Promise(() => {});' : "expect(1).toBe(1);"}
});`,
        );
        // The router classifies pure tests separately from process-owning tooling.
        // Both fixture configs use the same real Vitest test and cleanup boundary.
        const config = `import fs from "node:fs";
import os from "node:os";
import { getVitestWorkerDescriptor } from ${JSON.stringify(path.join(repoRoot, "scripts/lib/vitest-worker-bootstrap.mts"))};
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({
  pid: process.pid, namespace: os.tmpdir(), generation: getVitestWorkerDescriptor()?.directory,
}));
export default { test: { include: [${JSON.stringify(target)}], maxWorkers: 1 } };`;
        for (const owner of ["tooling", "unit-fast"]) {
          fs.writeFileSync(path.join(root, `test/vitest/vitest.${owner}.config.ts`), config);
        }
        const args =
          outcome === "help"
            ? ["--help"]
            : direct
              ? ["run", "--config", "test/vitest/vitest.tooling.config.ts", target]
              : [target];
        if (outcome !== "help") {
          args.push(...(direct ? [] : ["--"]), "--configLoader=native");
          if (outcome === "startup") args.push("--openclaw-trailer-repro");
        }
        const env = { ...process.env };
        for (const key of Object.keys(env)) {
          if (key.startsWith("VITEST") || key.startsWith("OPENCLAW_")) delete env[key];
        }
        Object.assign(env, {
          CI: "1",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json"),
        });
        let output = "";
        let signaled = false;
        const preload = script.endsWith(".mts")
          ? ["--import", path.join(repoRoot, "scripts/tsx.mjs")]
          : [];
        const result = await lifetime.track(
          runNodeScript(
            [...preload, path.join(repoRoot, "scripts", script), ...args],
            env,
            45_000,
            {
              cwd: root,
              signal,
              requireProcessTreeExit: process.platform !== "win32",
              onReady(child) {
                child.stdout!.on("data", (chunk) => {
                  output += String(chunk);
                });
                child.stderr!.on("data", (chunk) => {
                  output += String(chunk);
                  if (
                    outcome === "signal" &&
                    !signaled &&
                    output.includes("fixture signal ready")
                  ) {
                    signaled = true;
                    child.kill("SIGTERM");
                  }
                });
              },
            },
          ),
        );
        expect(result.error, output).toBeUndefined();
        const code =
          outcome === "signal" ? 143 : outcome === "failure" || outcome === "startup" ? 1 : 0;
        const failed = code !== 0;
        expect(result.status, output).toBe(code);
        const trailer = `[${tool}] FAILED (exit ${code})`;
        expect(output.match(/^\[.*\] FAILED \(exit \d+\)$/gmu) ?? [], output).toEqual(
          failed ? [trailer] : [],
        );
        if (failed) expect(output.trim().split("\n").at(-1)).toBe(trailer);
        if (outcome === "startup") expect(output).toContain("Unknown option");
        if (outcome === "help") expect(output).toMatch(/Usage:|vitest\//);
        if (["failure", "success", "signal"].includes(outcome)) {
          if (outcome === "signal") expect(signaled).toBe(true);
          else expect(output).toContain("fixture cleanup finished");
          if (outcome === "failure")
            expect(output).toContain("intentional trailer fixture failure");
          if (!direct && outcome !== "signal")
            expect(output).toMatch(/\[test\] (?:failed|passed) 1 Vitest shard/);
          const owned = JSON.parse(fs.readFileSync(receipt, "utf8"));
          expect(isProcessAlive(owned.pid)).toBe(false);
          expect(owned.generation).toEqual(expect.any(String));
          expect(fs.existsSync(owned.generation)).toBe(false);
          if (process.platform !== "win32") expect(fs.existsSync(owned.namespace)).toBe(false);
        }
      });
    },
  );
});

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
      const trailer = `[test] FAILED (exit ${outcome === "cancel" ? 143 : 1})`;
      expect(result.stderr.match(/^\[.*\] FAILED \(exit \d+\)$/gmu)).toEqual([trailer]);
      expect(result.stderr.trim().split("\n").at(-1)).toBe(trailer);
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
