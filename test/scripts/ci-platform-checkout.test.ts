import { fork, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { waitForChildClose, waitForFile } from "../helpers/process-wait.js";

type ProcessRecord = { pid: number; role: string; attempt: number };
type Boundary = { name: string; alive: ProcessRecord[]; sentinelAlive: boolean };
type Report = {
  code: number | null;
  error?: string;
  boundaries: Boundary[];
  readyAttempts: number[];
  cleanupRemaining: ProcessRecord[];
  ownedProcesses: ProcessRecord[];
  commands: { cwd: string; args: string[] }[];
  output: string;
};

const fixture = fileURLToPath(new URL("./fixtures/ci-platform-checkout.mjs", import.meta.url));

function readCheckoutRun(linux: boolean): string {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
    jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
  };
  const run = workflow.jobs[linux ? "checks-fast-core" : "checks-windows"]?.steps.find(
    (step) => step.name === "Checkout",
  )?.run;
  expect(run).toBeTypeOf("string");
  if (!run) {
    throw new Error("Missing shared platform checkout shell");
  }
  return run;
}

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
    const run = readCheckoutRun(linux);

    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ci platform checkout ")));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace);
    const startGate = path.join(root, "tree-start-gate-1");
    if (scenario === "git-exit-124") {
      writeFileSync(startGate, "held\n");
    }
    if (scenario.startsWith("cancel-")) {
      // Inject slow startup before fetch, beyond the former cancellation readiness deadline.
      writeFileSync(path.join(root, "fixture-config.json"), JSON.stringify({ initDelayMs: 4_100 }));
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
    const accelerated = run
      .replace(/fetch_timeout_seconds = [^\n]+/u, "fetch_timeout_seconds = 2")
      .replace(
        "def run_git(",
        `def fetch_clock():
    return 2 * sum(name.startswith("fetch-tick-") and name.endswith(".json")
                   for name in os.listdir(os.environ["TMPDIR"]))


def run_git(`,
      )
      .replace("deadline = time.monotonic() + timeout", "deadline = fetch_clock() + timeout")
      .replace(
        "deadline is not None and time.monotonic() >= deadline",
        "deadline is not None and fetch_clock() >= deadline",
      )
      .replace("kill_at = deadline - cleanup_seconds / 2", "kill_at = time.monotonic()")
      .replace(/retry_at = time\.monotonic\(\) \+ [^\n]+/u, "retry_at = time.monotonic() + 0.05");
    expect(accelerated).not.toBe(run);
    // A broken preflight must never let these negative fixture tests run real Git.
    writeFileSync(
      path.join(root, "checkout.sh"),
      setupFailure ? "printf 'unexpected workflow invocation\\n' >&2\nexit 99\n" : accelerated,
    );

    const supervisor = fork(fixture, ["supervise", root, `${linux ? "linux:" : ""}${scenario}`], {
      detached: true,
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    supervisor.stderr?.on("data", (data) => (stderr += String(data)));
    const closed = waitForChildClose(supervisor, 50_000);
    try {
      if (scenario === "git-exit-124") {
        await waitForFile(path.join(root, "tree-start-waiting-1.json"), 45_000);
        // Hold the real child before it can launch the grandchild. Startup past
        // the former readiness deadline must not replace Git's injected exit 124.
        await delay(4_100);
        rmSync(startGate);
      }
      const result = await closed;
      const report = JSON.parse(readFileSync(path.join(root, "report.json"), "utf8")) as Report;
      // Emit evidence before assertions; it remains available even for this deliberately red test.
      console.log(`${scenario}: ${JSON.stringify(report)}`);
      expect(report.cleanupRemaining, "fixture cleanup left owned processes").toEqual([]);
      if (setupFailure) {
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
      const leaks = report.boundaries
        .filter((entry) => entry.alive.length > 0)
        .map(({ name, alive }) => ({ boundary: name, survivors: alive }));
      expect(
        leaks,
        "Git descendants must be dead BEFORE workspace deletion, reuse or exit",
      ).toEqual([]);
      expect(report.code).toBe(code);
      if (scenario === "git-exit-124") {
        expect(report.output).toBe("");
      }
      expect(report.readyAttempts).toEqual(Array.from({ length: attempts }, (_, i) => i + 1));
      expect(report.boundaries.filter((entry) => entry.name.startsWith("fetch:"))).toHaveLength(
        attempts,
      );
      expect(report.boundaries.some((entry) => entry.name === "checkout")).toBe(checkout);
      expect(report.boundaries.filter((entry) => entry.name === "delete")).toHaveLength(deletions);
      expect(report.boundaries.at(-1)?.name).toBe("exit");
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
              ({ args }) => args.join(" ") === `config --global --add safe.directory ${workspace}`,
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
        expect(fetches.at(-1)?.args).toContain(`+${"b".repeat(40)}:refs/remotes/origin/ci-harness`);
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
      expect(
        report.boundaries.every((entry) => entry.sentinelAlive),
        "unrelated sentinel killed",
      ).toBe(true);
    } finally {
      // IPC loss also triggers cleanup if Vitest is canceled or its worker is killed.
      if (supervisor.connected) {
        supervisor.disconnect();
      }
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  },
  55_000,
);

it.skipIf(process.platform === "win32")(
  "recognizes terminated POSIX groups without accepting live signal denials",
  () => {
    const owner = expectDefined(
      readCheckoutRun(false).split("<<'PYTHON'\n")[1]?.split("\nPYTHON")[0],
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
            (root / "pids" / f"{pid}.json").write_text(json.dumps(dict(pid=pid, role=role, attempt=attempt)))
        subprocess.run([sys.argv[1], sys.argv[2], "git", directory, "early-leader-exit",
                        "-C", str(root / "workspace"), "checkout"], check=True)
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
        fixture,
      ],
      { input: owner, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("group contract passed");
  },
);
