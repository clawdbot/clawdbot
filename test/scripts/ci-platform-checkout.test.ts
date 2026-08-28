import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { waitForChildClose } from "../helpers/process-wait.js";

type ProcessRecord = { pid: number; role: string; attempt: number };
type Boundary = { name: string; alive: ProcessRecord[]; sentinelAlive: boolean };
type Report = {
  code: number | null;
  error?: string;
  boundaries: Boundary[];
  readyAttempts: number[];
  cleanupRemaining: ProcessRecord[];
  commands: { cwd: string; args: string[] }[];
  output: string;
};

const fixture = fileURLToPath(new URL("./fixtures/ci-platform-checkout.mjs", import.meta.url));

// Execute the workflow owner: string guards previously approved a leader-only kill
// that left TERM-resistant Git descendants alive through all three retries.
it.each([
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
])(
  "joins the entire platform checkout process tree before reuse and exit ($scenario)",
  async ({ scenario, attempts, code, checkout }) => {
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
      jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
    };
    const run = workflow.jobs["checks-windows"]?.steps.find(
      (step) => step.name === "Checkout",
    )?.run;
    expect(run).toBeTypeOf("string");
    if (!run) throw new Error("Missing shared platform checkout shell");

    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ci platform checkout ")));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace);
    // Advance the test clock, not the real OS teardown budget: a subsecond
    // cleanup deadline races process scheduling instead of testing ownership.
    const accelerated = run
      .replace(/\bfetch_timeout_seconds = 90\b/u, "fetch_timeout_seconds = 2")
      .replace("kill_at = deadline - cleanup_seconds / 2", "kill_at = time.monotonic()")
      .replace("retry_at = time.monotonic() + 5", "retry_at = time.monotonic() + 0.05");
    expect(accelerated).not.toBe(run);
    writeFileSync(path.join(root, "checkout.sh"), accelerated);

    const supervisor = fork(fixture, ["supervise", root, scenario], {
      detached: true,
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    supervisor.stderr?.on("data", (data) => (stderr += String(data)));
    const closed = waitForChildClose(supervisor, 25_000);
    try {
      const result = await closed;
      expect(result, stderr).toEqual({ code: 0, signal: null });
      const report = JSON.parse(readFileSync(path.join(root, "report.json"), "utf8")) as Report;
      // Emit evidence before assertions; it remains available even for this deliberately red test.
      console.log(`${scenario}: ${JSON.stringify(report)}`);
      expect(report.error, stderr).toBeUndefined();
      expect(report.cleanupRemaining, "fixture cleanup left owned processes").toEqual([]);
      expect(report.code).toBe(code);
      expect(report.readyAttempts).toEqual(Array.from({ length: attempts }, (_, i) => i + 1));
      expect(report.boundaries.filter((entry) => entry.name.startsWith("fetch:"))).toHaveLength(
        attempts,
      );
      expect(report.boundaries.some((entry) => entry.name === "checkout")).toBe(checkout);
      expect(report.boundaries.at(-1)?.name).toBe("exit");
      expect(report.output.includes("refusing reuse or retry")).toBe(
        scenario === "cleanup-failure",
      );
      if (code === 0) {
        const fetches = report.commands.filter(({ args }) => args.includes("fetch"));
        const candidateFetch = expectDefined(fetches[0], "candidate fetch");
        expect(candidateFetch.args).toContain(`+${"a".repeat(40)}:refs/remotes/origin/checkout`);
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
      const leaks = report.boundaries
        .filter((entry) => entry.alive.length > 0)
        .map(({ name, alive }) => ({ boundary: name, survivors: alive }));
      expect(leaks, "fetch descendants must be dead before checkout reuse or final exit").toEqual(
        [],
      );
    } finally {
      // IPC loss also triggers cleanup if Vitest is canceled or its worker is killed.
      if (supervisor.connected) supervisor.disconnect();
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
