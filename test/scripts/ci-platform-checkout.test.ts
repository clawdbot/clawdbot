import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { spawnOwnedVitestProcess } from "../../scripts/lib/vitest-process.mts";
import { isProcessAlive, waitForDead } from "../helpers/process-wait.js";
import {
  accelerateCiCheckoutFetchClock,
  ciCheckoutFixture,
  expectCiCheckoutCleanup,
  readCiCheckoutStep,
  withCiCheckoutFixture,
} from "./ci-checkout.test-support.js";

// Execute both workflow policies against the same owned tree fixture. A leader's
// exit must not authorize workspace deletion, Git reuse, or final success.
const platformCases = [
  { scenario: "timeouts-exhausted", attempts: 3, code: 124, checkout: false },
  { scenario: "recovery", attempts: 4, code: 0, checkout: true },
  { scenario: "early-leader-exit", attempts: 2, code: 0, checkout: true },
  { scenario: "harness-timeout", attempts: 2, code: 124, checkout: true },
  { scenario: "git-failure", attempts: 1, code: 23, checkout: false },
  { scenario: "git-exit-124", attempts: 1, code: 124, checkout: false },
  // Windows has no POSIX signals/ps boundary; native Job cancellation proof is separate.
  ...(process.platform === "win32" ? [] : ["SIGTERM", "SIGINT", "SIGHUP"]).map((signal, index) => ({
    scenario: `cancel-${signal}`,
    attempts: 1,
    code: [143, 130, 129][index],
    checkout: false,
  })),
  ...(process.platform === "win32"
    ? []
    : [{ scenario: "cleanup-failure", attempts: 1, code: 125, checkout: false }]),
];
const linuxCases =
  process.platform === "win32"
    ? []
    : [
        { scenario: "timeouts-exhausted", attempts: 5, code: 1, checkout: false, deletions: 5 },
        { scenario: "recovery", attempts: 4, code: 0, checkout: true, deletions: 3 },
        { scenario: "early-leader-exit", attempts: 2, code: 0, checkout: true, deletions: 1 },
        { scenario: "git-failure", attempts: 5, code: 1, checkout: false, deletions: 5 },
        { scenario: "checkout-failure", attempts: 5, code: 1, checkout: true, deletions: 5 },
        { scenario: "harness-recovery", attempts: 4, code: 0, checkout: true, deletions: 2 },
        { scenario: "cancel-SIGTERM", attempts: 1, code: 143, checkout: false, deletions: 1 },
        { scenario: "cleanup-failure", attempts: 1, code: 125, checkout: false, deletions: 1 },
        { scenario: "non-executable-git", attempts: 0, code: null, checkout: false, deletions: 0 },
        { scenario: "non-executable-find", attempts: 0, code: null, checkout: false, deletions: 0 },
      ];

it.each([
  ...platformCases.map((entry) => Object.assign(entry, { linux: false, deletions: 0 })),
  ...linuxCases.map((entry) => Object.assign(entry, { linux: true })),
])(
  "preserves checkout ownership and fixture isolation (Linux=$linux, $scenario)",
  async ({ scenario, attempts, code, checkout, linux, deletions }) => {
    const setupFailure = scenario.startsWith("non-executable-");
    const run = readCiCheckoutStep(linux ? "checks-fast-core" : "checks-windows").run;

    const policyScenario = `${linux ? "linux:" : ""}${scenario}`;
    await withCiCheckoutFixture(
      policyScenario,
      (root) => {
        const workspace = path.join(root, "workspace");
        if (scenario.startsWith("cancel-")) {
          // Inject slow startup before fetch, beyond the former cancellation readiness deadline.
          writeFileSync(
            path.join(root, "fixture-config.json"),
            JSON.stringify({ initDelayMs: 4_100 }),
          );
        }
        if (linux) {
          writeFileSync(path.join(workspace, ".previous-checkout"), "stale\n");
        }
        if (scenario === "recovery") {
          // Reproduce startup beyond the old wall-clock budget without delaying other consumers.
          writeFileSync(path.join(root, "tree-start-delay-3.json"), "2100");
        }
        for (const anchor of [
          "def run_git(",
          "deadline = time.monotonic() + timeout",
          "deadline is not None and time.monotonic() >= deadline",
        ]) {
          expect(run, `Missing fetch clock source anchor: ${anchor}`).toContain(anchor);
        }
        // Only a ready, deliberately stalled tree advances the fetch clock. Real
        // process startup and teardown retain their independent wall-clock watchdogs.
        const accelerated = accelerateCiCheckoutFetchClock(run)
          .replace(/fetch_timeout_seconds = [^\n]+/u, "fetch_timeout_seconds = 2")
          .replace("kill_at = deadline - cleanup_seconds / 2", "kill_at = time.monotonic()")
          .replace(
            /retry_at = time\.monotonic\(\) \+ [^\n]+/u,
            "retry_at = time.monotonic() + 0.05",
          );
        expect(accelerated).not.toBe(run);
        // A broken preflight must never let these negative fixture tests run real Git.
        writeFileSync(
          path.join(root, "checkout.sh"),
          setupFailure ? "printf 'unexpected workflow invocation\\n' >&2\nexit 99\n" : accelerated,
        );
      },
      (report, result, stderr, root) => {
        const workspace = path.join(root, "workspace");
        // Emit evidence before assertions; it remains available even for this deliberately red test.
        console.log(`${scenario}: ${JSON.stringify(report)}`);
        if (setupFailure) {
          expect(report.cleanupRemaining, "fixture cleanup left owned processes").toEqual([]);
          expect(report.error, report.output).toContain(
            "Fixture setup: mock command resolution failed",
          );
          expect(report.error).toContain(scenario.slice("non-executable-".length));
          expect(result, stderr).toEqual({ code: 1, signal: null });
          expect(report.code).toBeNull();
          expect(report.output).toBe("");
          expect(report.commands).toEqual([]);
          expect(report.boundaries).toEqual([]);
          return;
        }
        expect(result, stderr).toEqual({ code: 0, signal: null });
        expect(report.error, stderr).toBeUndefined();
        expectCiCheckoutCleanup(report);
        expect(report.code).toBe(code);
        expect(report.readyAttempts).toEqual(Array.from({ length: attempts }, (_, i) => i + 1));
        expect(report.boundaries.filter((entry) => entry.name.startsWith("fetch:"))).toHaveLength(
          attempts,
        );
        expect(report.boundaries.some((entry) => entry.name === "checkout")).toBe(checkout);
        expect(report.boundaries.filter((entry) => entry.name === "delete")).toHaveLength(
          deletions,
        );
        expect(report.output.includes("refusing reuse or retry")).toBe(
          scenario === "cleanup-failure",
        );
        if (scenario.startsWith("cancel-")) {
          const alive = report.ownedProcesses.filter((entry) => entry.attempt === 1);
          expect(alive.map((entry) => entry.role).toSorted()).toEqual([
            "child",
            "grandchild",
            "parent",
          ]);
          const owner = expectDefined(
            report.ownedProcesses.find((entry) => entry.role === "shell"),
            "workflow owner",
          );
          expect(owner.pid).toBeGreaterThan(1);
          const signal = scenario.slice("cancel-".length);
          expect(report.output).toContain(
            `cancellation: ${JSON.stringify({ signal, owner: owner.pid, alive })}\n`,
          );
        }
        if (code === 0) {
          const fetches = report.commands.filter(({ args }) => args.includes("fetch"));
          const candidateFetch = expectDefined(fetches[0], "candidate fetch");
          expect(candidateFetch.args).toContain(
            `+${"a".repeat(40)}:refs/remotes/origin/${linux ? "ci-target" : "checkout"}`,
          );
          expect(
            candidateFetch.args.includes(`+${"c".repeat(40)}:refs/remotes/origin/ci-ratchet-base`),
          ).toBe(linux && scenario === "early-leader-exit");
          if (linux) {
            expect(
              report.commands.filter(
                ({ args }) =>
                  args.join(" ") === `config --global --add safe.directory ${workspace}`,
              ),
            ).toHaveLength(deletions);
            expect(
              report.commands
                .filter(({ cwd, args }) => cwd === workspace && args[0] === "checkout")
                .every(
                  ({ args }) => args.join(" ") === `checkout --force --detach ${"a".repeat(40)}`,
                ),
            ).toBe(true);
          }
          expect(candidateFetch.cwd).toBe(workspace);
          expect(fetches.at(-1)?.cwd).toBe(path.join(workspace, ".ci-harness"));
          for (const { args } of fetches) {
            expect(args).toEqual(
              expect.arrayContaining(["--no-tags", "--no-recurse-submodules", "--depth=1"]),
            );
          }
          expect(fetches.at(-1)?.args).toContain(
            `+${"b".repeat(40)}:refs/remotes/origin/ci-harness`,
          );
          expect(
            report.commands.some(
              ({ args }) => args.join(" ") === "sparse-checkout set .github/actions",
            ),
          ).toBe(true);
          expect(report.commands.at(-1)?.args).toEqual([
            "checkout",
            "--force",
            "--detach",
            "b".repeat(40),
          ]);
        }
      },
    );
  },
  55_000,
);

it("joins an unregistered sentinel before supervisor close on disconnect", async () => {
  await withCiCheckoutFixture(
    "early-leader-exit",
    (root) => {
      writeFileSync(path.join(root, "checkout.sh"), "exit 99\n");
      const preload = path.join(root, "startup.mjs");
      // Fault only the asynchronous startup boundary; keep the real safe preflight.
      writeFileSync(
        preload,
        String.raw`
import assert from "node:assert/strict";
import cp from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
const [mode, root] = process.argv.slice(2);
if (mode === "sentinel") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (mode === "supervise") {
  const spawn = cp.spawn;
  cp.spawn = (...args) => {
    const child = spawn(...args);
    if (args[1]?.[1] === "sentinel") {
      assert(child.pid > 1, "sentinel spawn did not return an owned PID");
      // Record at the creator: proof must not depend on sentinel JS ever starting.
      writeFileSync(path.join(root, "spawned-pid"), String(child.pid));
      child.once("close", (code, signal) => {
        writeFileSync(path.join(root, "sentinel-close.json"), JSON.stringify({
          code, signal, reportExists: existsSync(path.join(root, "report.json")),
        }));
      });
      queueMicrotask(() => process.disconnect());
    }
    return child;
  };
  syncBuiltinESMExports();
}
`,
      );
      return { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
    },
    (report, result, stderr, root) => {
      const spawnedPid = path.join(root, "spawned-pid");
      const sentinelClose = path.join(root, "sentinel-close.json");
      expect(report.error, stderr).toBe("test parent disconnected");
      const pid = Number(readFileSync(spawnedPid, "utf8"));
      expect(isProcessAlive(pid), "supervisor closed with an unregistered writer alive").toBe(
        false,
      );
      expect(JSON.parse(readFileSync(sentinelClose, "utf8"))).toEqual({
        code: null,
        signal: "SIGKILL",
        reportExists: false,
      });
      expect(result, stderr).toEqual({ code: 1, signal: null });
      expect(report.ownedProcesses).toEqual([]);
      expect(report.cleanupRemaining).toEqual([]);
      expect(report.boundaries).toEqual([]);
      expect(report.commands).toEqual([]);
    },
  );
}, 55_000);

it.each(["prepare", "inspect"])(
  "removes checkout artifacts after %s assertion failure",
  async (phase) => {
    let root: string | undefined;
    await expect(
      withCiCheckoutFixture(
        "early-leader-exit",
        (directory) => {
          root = directory;
          expect(phase, "injected prepare assertion").not.toBe("prepare");
          writeFileSync(path.join(directory, "checkout.sh"), "exit 0\n");
        },
        (report, result, stderr) => {
          expect(result, stderr).toEqual({ code: 0, signal: null });
          expectCiCheckoutCleanup(report);
          expect(report.code, "injected inspect assertion").toBe(99);
        },
      ),
    ).rejects.toThrow(`injected ${phase} assertion`);
    expect(existsSync(expectDefined(root, "created checkout root"))).toBe(false);
  },
  55_000,
);

it.skipIf(process.platform === "win32").each(["census", "corrupt-report", "timeout"])(
  "retains checkout artifacts across failed outer-runner cleanup (%s)",
  async (fault) => {
    const preload = String.raw`
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
if (process.argv[2] === "sentinel" && fault === "timeout") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (process.argv[2] === "supervise") {
  const root = process.argv[3], children = [], pending = new Set();
  const spawn = cp.spawn, spawnSync = cp.spawnSync, renameSync = fs.renameSync;
  cp.spawn = (...args) => {
    const child = spawn(...args);
    children.push(child.pid);
    pending.add(child);
    fs.writeFileSync(path.join(root, "creator-pids.json"), JSON.stringify([process.pid, ...children]));
    child.once("close", () => pending.delete(child));
    if (fault === "timeout") {
      // Notify after spawn returns and the fixture installs direct-child tracking.
      // Flush IPC before stalling; sentinel registration is deliberately blocked.
      queueMicrotask(() => {
        process.send({ type: "ci-checkout:sentinel-created", pids: [process.pid, child.pid] }, error => {
          if (error) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        });
      });
    }
    return child;
  };
  cp.spawnSync = (...args) => {
    if (fault === "census" && args[0] === "/bin/ps" && children.length === 2 && pending.size === 0) {
      fs.writeFileSync(path.join(root, "closed-before-census.json"), JSON.stringify(children));
      throw new Error("injected final census failure after direct child close");
    }
    return spawnSync(...args);
  };
  fs.renameSync = (...args) => {
    const result = renameSync(...args);
    if (fault === "corrupt-report" && args[1] === path.join(root, "report.json")) {
      fs.writeFileSync(args[1], "null");
    }
    return result;
  };
  syncBuiltinESMExports();
}
`;
    // Use the actual outer namespace owner, including its cleanup on exit code 1.
    const { child, completion } = spawnOwnedVitestProcess({
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        String.raw`
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
const timeoutFault = process.argv[2] === "timeout";
let root, failure;
let supervisor, ready, onReady;
const fork = cp.fork;
if (timeoutFault) {
  ready = new Promise(resolve => {
    onReady = message => {
      if (message?.type === "ci-checkout:sentinel-created") resolve(message.pids);
    };
  });
  cp.fork = (...args) => {
    supervisor = fork(...args);
    supervisor.on("message", onReady);
    return supervisor;
  };
  syncBuiltinESMExports();
}
try {
  const { withCiCheckoutFixture } = await import(process.argv[1]);
  if (timeoutFault) mock.timers.enable({ apis: ["setTimeout"] });
  const completed = withCiCheckoutFixture("early-leader-exit", directory => {
    root = directory;
    fs.writeFileSync(path.join(root, "checkout.sh"), "exit 0\n");
    const preload = path.join(root, "fault.mjs");
    fs.writeFileSync(preload, "const fault = " + JSON.stringify(process.argv[2]) + ";\n" + process.argv[3]);
    return { NODE_OPTIONS: "--import=" + pathToFileURL(preload).href };
  }, (report, result, stderr) => {
    throw new Error("unexpected completed report: " + JSON.stringify({ report, result, stderr }));
  }).catch(error => {
    console.error(error);
    failure = String(error);
  });
  try {
    if (timeoutFault) {
      const pids = await Promise.race([ready, completed.then(() => {
        throw new Error("supervisor completed before the timeout probe was ready");
      })]);
      assert.equal(pids.length, 2);
      assert.equal(pids[0], supervisor.pid);
      assert.notEqual(pids[1], supervisor.pid);
      for (const pid of pids) {
        assert(Number.isInteger(pid) && pid > 1);
        process.kill(pid, 0);
      }
    }
  } finally {
    if (timeoutFault) {
      // Creation belongs to the supervisor, not a child's delayed self-registration.
      // Restore timers before the expired controller deadline starts real cleanup.
      mock.timers.tick(50_000);
      mock.timers.reset();
    }
    await completed;
  }
} catch (error) {
  console.error(error);
  failure = String(error);
} finally {
  if (timeoutFault) {
    mock.timers.reset();
    supervisor?.off("message", onReady);
    cp.fork = fork;
    syncBuiltinESMExports();
  }
}
console.log(JSON.stringify({ root, outerRoot: tmpdir(), failure,
  pids: JSON.parse(fs.readFileSync(path.join(root, "creator-pids.json"), "utf8")),
  closedBeforeCensus: fs.existsSync(path.join(root, "closed-before-census.json")),
}));
process.exitCode = 1;
`,
        new URL("./ci-checkout.test-support.ts", import.meta.url).href,
        fault,
        preload,
      ],
      options: { stdio: ["ignore", "pipe", "pipe"] },
    });
    let stdout = "",
      stderr = "";
    child.stdout?.on("data", (data) => (stdout += String(data)));
    child.stderr?.on("data", (data) => (stderr += String(data)));
    const result = await completion;
    expect(stdout, stderr).not.toBe("");
    const evidence = JSON.parse(stdout) as {
      root: string;
      outerRoot: string;
      failure: string;
      pids: number[];
      closedBeforeCensus: boolean;
    };
    try {
      console.log(`${fault}: ${JSON.stringify({ result, ...evidence, stderr })}`);
      expect(result, stderr).toEqual({ code: 1, signal: null });
      expect(existsSync(evidence.outerRoot), "outer runner did not remove its own namespace").toBe(
        false,
      );
      expect(path.dirname(evidence.root)).toBe(
        realpathSync(fileURLToPath(new URL("../../.artifacts/ci-checkout/", import.meta.url))),
      );
      expect(existsSync(evidence.root), stderr).toBe(true);
      expect(
        evidence.pids.every((pid) => !isProcessAlive(pid)),
        "fixture left owned processes alive",
      ).toBe(true);
      expect(stderr).toContain(
        `Checkout fixture retained at ${evidence.root}; no completed report.`,
      );
      expect(stderr).toContain("Supervisor close: true; group extinction: true.");
      if (fault === "census") {
        expect(evidence.closedBeforeCensus).toBe(true);
        expect(evidence.pids).toHaveLength(3);
        expect(stderr).toContain("injected final census failure after direct child close");
        expect(existsSync(path.join(evidence.root, "report.json"))).toBe(false);
      } else if (fault === "timeout") {
        expect(evidence.pids).toHaveLength(2);
        expect(evidence.failure).toContain("did not close within 50000ms");
        expect(existsSync(path.join(evidence.root, "report.json"))).toBe(false);
      } else {
        expect(evidence.failure).not.toContain("unexpected completed report");
        expect(readFileSync(path.join(evidence.root, "report.json"), "utf8")).toBe("null");
      }
    } finally {
      await Promise.all(evidence.pids.map((pid) => waitForDead(pid, 4_000)));
      rmSync(evidence.root, { recursive: true, force: true });
    }
  },
  55_000,
);

it("does not revive an observed-dead fixture instance when its PID is reused", () => {
  const result = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-I",
      "-S",
      "-c",
      String.raw`
import json, os, pathlib, subprocess, sys, tempfile

with tempfile.TemporaryDirectory(prefix="checkout-pid-reuse-") as directory:
    root = pathlib.Path(directory).resolve()
    workspace = root / "workspace"
    workspace.mkdir()
    records = root / "pids"
    records.mkdir()
    (root / "lease").write_text("owned")
    # Guard command scope while retaining the real OS liveness result.
    guard = root / "census.cjs"
    guard.write_text('''
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const spawnSync = cp.spawnSync;
const inspected = new Set();
cp.spawnSync = (command, args, options) => {
  if (command === "/bin/ps") {
    const index = args.indexOf("-p");
    assert(index >= 0 && args.filter(arg => arg === "-p").length === 1 && /^[1-9][0-9]*$/.test(args[index + 1]), "fixture census must query exactly one PID");
    assert(args.every(arg => !arg.startsWith("-") || ["-p", "-o"].includes(arg)), "fixture census must select owned PIDs only");
    const records = path.join(process.argv[3], "pids");
    const allowed = new Set(fs.readdirSync(records).filter(name => name.endsWith(".json")).map(name => JSON.parse(fs.readFileSync(path.join(records, name), "utf8"))).filter(record => !fs.existsSync(path.join(records, record.instance + ".dead"))).map(record => record.pid));
    const pid = Number(args[index + 1]);
    assert(allowed.has(pid) && !inspected.has(pid), "fixture census escaped deduplicated registered ownership");
    inspected.add(pid);
  }
  return spawnSync(command, args, options);
};
require("node:module").syncBuiltinESMExports();
''')
    with subprocess.Popen([sys.executable, "-I", "-S", "-c", "pass"]) as child:
        child.wait(timeout=10)
        retired = dict(pid=child.pid, role="grandchild", attempt=1, instance="retired")
        current = dict(pid=os.getpid(), role="grandchild", attempt=2, instance="current")
        (records / "retired.json").write_text(json.dumps(retired))
        (records / "current.json").write_text(json.dumps(current))

        def observe():
            subprocess.run([sys.argv[1], "--require", str(guard), sys.argv[2], "git", str(root), "early-leader-exit",
                            "-C", str(workspace), "checkout"], cwd=workspace, check=True)
            return json.loads((root / "events.jsonl").read_text().splitlines()[-1])["alive"]

        assert observe() == [current], "first boundary must observe real child termination"
        # Fault-inject PID reuse only after actual death was observed. The fresh
        # instance at that live PID must remain visible, never hidden by retirement.
        retired["pid"] = current["pid"]
        (records / "retired.json").write_text(json.dumps(retired))
        assert observe() == [current], "a retired instance was revived by a reused PID"
print("fixture lifetime contract passed")
`,
      process.execPath,
      ciCheckoutFixture,
    ],
    { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("fixture lifetime contract passed");
});

it.skipIf(process.platform === "win32")(
  "recognizes terminated POSIX groups without accepting live signal denials",
  () => {
    const owner = expectDefined(
      readCiCheckoutStep("checks-windows").run.split("<<'PYTHON'\n")[1]?.split("\nPYTHON")[0],
      "checkout Python owner",
    );
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-S",
        "-c",
        String.raw`
import ast, errno, json, os, pathlib, signal, subprocess, sys, tempfile, time

# Load only the actual boundary functions; never execute checkout or real Git.
functions = [node for node in ast.parse(sys.stdin.read()).body
             if isinstance(node, ast.FunctionDef) and node.name in ("group_alive", "group_signal")]
assert len(functions) == 2
exec(compile(ast.Module(body=functions, type_ignores=[]), "checkout-owner.py", "exec"))

# Retain the Popen handle without polling, so the owned zombie cannot be reaped or reused.
with subprocess.Popen([sys.executable, "-I", "-S", "-c", "pass"], start_new_session=True) as child:
    deadline = time.monotonic() + 10
    while True:
        state = subprocess.run(["ps", "-o", "stat=", "-p", str(child.pid)],
                               check=True, capture_output=True, text=True).stdout.strip()
        if state.startswith("Z"):
            break
        assert time.monotonic() < deadline, "owned child did not terminate"
        time.sleep(0.01)
    assert not group_alive(child.pid, deadline), "zombies are terminated, not checkout writers"
    group_signal(child.pid, signal.SIGTERM, deadline)
    group_signal(child.pid, signal.SIGKILL, deadline)
    with tempfile.TemporaryDirectory(prefix="checkout-zombie-") as directory:
        root = pathlib.Path(directory)
        (root / "workspace").mkdir()
        (root / "pids").mkdir()
        (root / "lease").write_text("owned")
        for pid, role, attempt in [(child.pid, "grandchild", 1), (os.getpid(), "sentinel", 0)]:
            (root / "pids" / f"{pid}.json").write_text(json.dumps(dict(pid=pid, role=role, attempt=attempt, instance=str(pid))))
        subprocess.run([sys.argv[1], sys.argv[2], "git", directory, "early-leader-exit",
                        "-C", str(root / "workspace"), "checkout"], cwd=root / "workspace", check=True)
        observed = json.loads((root / "events.jsonl").read_text())
        assert observed["alive"] == [], "fixture counted a terminated zombie as a live writer"
        assert observed["sentinelAlive"]

# A denied signal is safe to normalize only if the same census proves extinction.
with subprocess.Popen([sys.executable, "-I", "-S", "-c",
                       "import sys; print('ready', flush=True); sys.stdin.read()"],
                      start_new_session=True, stdin=subprocess.PIPE,
                      stdout=subprocess.PIPE, text=True) as child:
    assert child.stdout.readline().strip() == "ready"
    actual_killpg = os.killpg
    def denied(pgid, signum):
        assert pgid == child.pid and signum in (0, signal.SIGTERM)
        raise PermissionError(errno.EPERM, "test-owned signal denial")
    os.killpg = denied
    try:
        try:
            group_signal(child.pid, signal.SIGTERM, time.monotonic() + 10)
        except PermissionError:
            pass
        else:
            raise AssertionError("live denied group was accepted as terminated")
    finally:
        os.killpg = actual_killpg
print("group contract passed")
`,
        process.execPath,
        ciCheckoutFixture,
      ],
      { input: owner, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("group contract passed");
  },
);
