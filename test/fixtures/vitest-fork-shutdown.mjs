import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnOwnedVitestProcess } from "../../scripts/lib/vitest-process.mts";
import { installVitestProcessGroupCleanup } from "../../scripts/vitest-process-group.mts";

const [root, rawOptions] = process.argv.slice(2);
const { scenario, setup, fail } = JSON.parse(rawOptions);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const events = path.join(root, "events.jsonl");
const ready = path.join(root, "ready");
const receipt = path.join(root, "receipt.json");
const profiles = path.join(root, "profiles");
const preload = path.join(root, "preload.mjs");
for (const dir of ["home", "tmp", "profiles", "test/vitest"]) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}
const { packageManager } = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
fs.writeFileSync(
  path.join(root, "package.json"),
  JSON.stringify({ private: true, type: "module", packageManager }),
);
fs.symlinkSync(path.join(repo, "node_modules"), path.join(root, "node_modules"), "junction");
fs.writeFileSync(path.join(root, "home", "caller"), "keep");
const env = {
  PATH: process.env.PATH,
  npm_execpath: process.env.npm_execpath,
  HOME: path.join(root, "home"),
  USERPROFILE: path.join(root, "home"),
  TMPDIR: path.join(root, "tmp"),
  TMP: path.join(root, "tmp"),
  TEMP: path.join(root, "tmp"),
  CI: "1",
  LIVE: "0",
  OPENCLAW_LIVE_TEST: "0",
  OPENCLAW_LIVE_GATEWAY: "0",
  PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
  pnpm_config_verify_deps_before_run: "false",
  NODE_OPTIONS: `--import=${JSON.stringify(pathToFileURL(preload).href)}`,
};

fs.writeFileSync(
  preload,
  `
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const scenario = ${JSON.stringify(scenario)};
const ready = ${JSON.stringify(ready)};
const record = (event) => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify(event) + "\\n");
const fork = childProcess.fork;
childProcess.fork = (...args) => {
  const child = fork(...args);
  const kill = child.kill;
  child.kill = function(signal) {
    record({ event: "terminate", signal: signal ?? "SIGTERM" });
    return kill.call(this, signal);
  };
  if (scenario === "natural-exit") {
    const emit = child.emit;
    let release;
    child.emit = function(event, ...args) {
      if (event === "message" && args[0]?.type === "stopped") {
        release = () => {
          clearInterval(timer);
          release = undefined;
          emit.call(this, event, ...args);
        };
        const timer = setInterval(() => { if (fs.existsSync(ready)) release?.(); }, 1);
        return true;
      }
      if (event === "exit") release?.();
      return emit.call(this, event, ...args);
    };
  }
  if (scenario === "custom") {
    const emit = child.emit;
    child.emit = function(event, ...args) {
      const result = emit.call(this, event, ...args);
      if (event === "message" && args[0]?.type === "stopped") {
        record({ event: "stopped-consumed" });
        fs.writeFileSync(ready, "stopped");
      }
      return result;
    };
  }
  return child;
};
syncBuiltinESMExports();
if (scenario === "slow-exit") {
  const remove = fs.rmSync;
  fs.rmSync = function(target, ...args) {
    const home = path.basename(String(target)).startsWith("openclaw-test-home-");
    if (home) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
    const result = remove.call(fs, target, ...args);
    if (home) record({ event: "home-removed" });
    return result;
  };
}
if (scenario === "natural-exit") {
  // Hold the parent's stopped-response delivery until natural exit or actual exit.
  // Widen Node's real signal-watcher retirement window without changing the worker protocol.
  if (process.send) process.once("beforeExit", () => {
    process.removeAllListeners("SIGTERM");
    fs.writeFileSync(ready, "natural-exit");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
  });

}
if (scenario.startsWith("hung-") || scenario === "custom") {
  // A process-local test clock advances only the existing 60 s stop deadline,
  // after the actual worker reaches the hung cleanup/exit boundary. Start timers
  // have already been cleared; the native 500 ms forced-kill timer stays real.
  const schedule = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  const deadlines = new Map();
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = schedule(callback, delay, ...args);
    if (delay === 60000) deadlines.set(timer, () => callback(...args));
    return timer;
  };
  globalThis.clearTimeout = (timer) => { deadlines.delete(timer); return cancel(timer); };
  const poll = setInterval(() => {
    if (!fs.existsSync(ready)) return;
    clearInterval(poll);
    for (const [timer, callback] of deadlines) {
      cancel(timer);
      record({ event: "deadline", delay: 60000 });
      callback();
    }
    deadlines.clear();
  }, 5);
  poll.unref();
}
`,
);

if (scenario === "forced") {
  // Exercise the exported force-stop owner with a real installed Vitest fork.
  // Its preloader ignores TERM so the unchanged KILL escalation must finish it.
  fs.appendFileSync(
    preload,
    `
if (process.send) {
  process.on("SIGTERM", () => {});
  fs.writeFileSync(${JSON.stringify(ready)}, "ready");
}
`,
  );
  const { ForksPoolWorker, distDir } = await import("vitest/node");
  const worker = new ForksPoolWorker({
    distPath: distDir,
    execArgv: ["--import", pathToFileURL(preload).href],
    env,
    project: {
      vitest: { logger: { outputStream: new PassThrough(), errorStream: new PassThrough() } },
    },
  });
  await worker.start();
  const exited = new Promise((resolve) => {
    worker.on("exit", (code, signal) => resolve({ code, signal }));
  });
  try {
    while (!fs.existsSync(ready)) {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
  } finally {
    await worker.stop();
  }
  console.log(JSON.stringify({ ...(await exited), stopped: true }));
} else {
  const setupFiles =
    setup === "raw"
      ? []
      : [path.join(repo, setup === "env" ? "test/setup.env.ts" : "test/setup.ts")];
  let runner = path.join(repo, "test/non-isolated-runner.ts");
  if (scenario === "hung-cleanup") {
    runner = path.join(root, "runner.ts");
    fs.writeFileSync(
      runner,
      `
import fs from "node:fs";
import Runner from ${JSON.stringify(pathToFileURL(path.join(repo, "test/non-isolated-runner.ts")).href)};
export default class extends Runner {
  constructor(config) {
    super(config);
    this.onCleanupWorkerContext(() => {
      fs.writeFileSync(${JSON.stringify(ready)}, "cleanup");
      return new Promise(() => {});
    });
  }
}
`,
    );
  }
  const custom = scenario.startsWith("custom");
  const entrypoint = path.join(root, "custom-worker.mjs");
  if (custom) {
    fs.writeFileSync(
      entrypoint,
      `
import { init, runBaseTests, setupEnvironment } from "vitest/worker";
const exit = process.exit.bind(process);
init({
  post: (message) => {
    if (message.__vitest_worker_response__ && message.type === "stopped") {
      ${scenario === "custom-opt-in" ? "process.send({ ...message, willExit: true }, () => exit());" : "process.send(message);"}
    } else process.send(message);
  },
  on: (callback) => process.on("message", callback),
  off: (callback) => process.off("message", callback),
  runTests: (state, traces) => runBaseTests("run", state, traces),
  collectTests: (state, traces) => runBaseTests("collect", state, traces),
  setup: setupEnvironment,
});
`,
    );
  }
  const config = path.join(root, "test/vitest/vitest.unit.config.ts");
  fs.writeFileSync(
    config,
    `
import { sharedVitestConfig } from ${JSON.stringify(pathToFileURL(path.join(repo, "test/vitest/vitest.shared.config.ts")).href)};
import { ForksPoolWorker } from "vitest/node";
${
  custom
    ? `class CustomFork extends ForksPoolWorker {
  name = "custom-fork";
  entrypoint = ${JSON.stringify(entrypoint)};
  async stop() {
    const fs = await import("node:fs");
    fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({ event: "parent-stop" }) + "\\n");
    await super.stop();
  }
}`
    : ""
}
export default {
  resolve: sharedVitestConfig.resolve, plugins: sharedVitestConfig.plugins,
  test: { include: ["fixture.test.ts"], pool: ${custom ? '{ name: "custom-fork", createPoolWorker: (options) => new CustomFork(options) }' : JSON.stringify(["threads", "vmForks"].includes(scenario) ? scenario : "forks")},
    isolate: false, maxWorkers: 1, fileParallelism: false,
    setupFiles: ${JSON.stringify(setupFiles)},
    ${setup === "shared" ? `runner: ${JSON.stringify(runner)},` : ""}
  }
};
`,
  );
  fs.writeFileSync(
    path.join(root, "fixture.test.ts"),
    `
import fs from "node:fs";
import { it, expect } from "vitest";
import { threadId } from "node:worker_threads";
${scenario === "hung-exit" ? `process.once("exit", () => { fs.writeFileSync(${JSON.stringify(ready)}, "exit"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });` : ""}
${scenario === "bad-exit" ? 'process.once("exit", () => { process.exitCode = 23; });' : ""}
it("completes the test before worker shutdown", () => {
  fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ pid: process.pid, threadId, home: process.env.HOME }));
  ${fail ? 'expect.fail("intentional fixture failure");' : "expect(true).toBe(true);"}
});
`,
  );
  const args = [
    path.join(repo, "scripts/run-vitest.mjs"),
    "run",
    "--config",
    config,
    "--root",
    root,
    "--configLoader",
    "native",
  ];
  if (scenario !== "plain" && scenario !== "custom") {
    // This shutdown contract covers Node's exit-time writes, not the Inspector
    // profiler's awaited cleanup. Pass native flags only to the actual worker.
    args.push(
      "--execArgv=--cpu-prof",
      `--execArgv=--cpu-prof-dir=${profiles}`,
      "--execArgv=--heap-prof",
      `--execArgv=--heap-prof-dir=${profiles}`,
    );
  }
  const { child, completion } = spawnOwnedVitestProcess({
    command: process.execPath,
    args,
    options: { cwd: root, env, stdio: "pipe" },
  });
  const detachCleanup = installVitestProcessGroupCleanup({ child, forceSignal: "SIGKILL" });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const { code } = await completion.finally(detachCleanup);
  assert.ok(
    fs.existsSync(receipt),
    `Vitest exited before the fixture test (code ${code}):\n${output}`,
  );
  const state = JSON.parse(fs.readFileSync(receipt, "utf8"));
  let workerStopped = false;
  try {
    process.kill(state.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") {
      workerStopped = true;
    } else {
      throw error;
    }
  }
  const counts = { cpu: 0, heap: 0 };
  for (const file of fs.readdirSync(profiles)) {
    // Native profile names contain PID/thread ID. A launcher profile cannot
    // establish that the worker's exit-time writes completed.
    const [, , , pid, workerThreadId] = file.split(".");
    if (pid !== String(state.pid) || workerThreadId !== String(state.threadId)) {
      continue;
    }
    const profile = JSON.parse(fs.readFileSync(path.join(profiles, file), "utf8"));
    if (file.endsWith(".cpuprofile") && profile.nodes?.length) {
      counts.cpu++;
    }
    if (file.endsWith(".heapprofile") && profile.head) {
      counts.heap++;
    }
  }
  console.log(
    JSON.stringify({
      code,
      output,
      worker: { pid: state.pid, threadId: state.threadId },
      workerStopped,
      profiles: counts,
      homeRemoved: !fs.existsSync(state.home),
      callerPreserved: fs.readFileSync(path.join(root, "home", "caller"), "utf8") === "keep",
      events: fs.existsSync(events)
        ? fs.readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
        : [],
    }),
  );
}
