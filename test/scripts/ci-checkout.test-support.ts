import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import {
  inspectManagedProcessGroup,
  terminateManagedChild,
} from "../../scripts/lib/managed-child-process.mts";

type Step = { name?: string; run?: string; env?: Record<string, string | number> };
const processRecord = z.object({
  pid: z.number().int().positive(),
  role: z.string(),
  attempt: z.number().int().nonnegative(),
  instance: z.string(),
  creationTime: z.string().regex(/^\d+$/u).optional(),
});
const reportSchema = z.object({
  code: z.number().nullable(),
  cancelledDuringCleanup: z.boolean(),
  error: z.string().optional(),
  boundaries: z.array(
    z.object({ name: z.string(), alive: z.array(processRecord), sentinelAlive: z.boolean() }),
  ),
  readyAttempts: z.array(z.number()),
  cleanupRemaining: z.array(processRecord).length(0),
  ownedProcesses: z.array(processRecord),
  commands: z.array(
    z.object({
      tool: z.string(),
      cwd: z.string(),
      args: z.array(z.string()),
      configuration: z.array(z.string()).optional(),
      envProbe: z.string().optional(),
    }),
  ),
  output: z.string(),
});
type Report = z.infer<typeof reportSchema>;
type CloseResult = { code: number | null; signal: NodeJS.Signals | null };

export const ciCheckoutFixture = fileURLToPath(
  new URL("./fixtures/ci-platform-checkout.mjs", import.meta.url),
);
const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
  jobs: Record<string, { steps: Step[] }>;
};

export function readCiCheckoutStep(job: string, name = "Checkout"): Step & { run: string } {
  const step = workflow.jobs[job]?.steps.find((entry) => entry.name === name);
  if (!step?.run) {
    throw new Error(`Missing executable workflow step ${job}/${name}`);
  }
  return { ...step, run: step.run };
}

export function renderGitTestClock(
  source: string,
  options: { realClock?: boolean; realDrain?: boolean } = {},
): string {
  // Change Python before shell quoting, so injected clock literals cannot alter
  // the generated argument or reintroduce a pipe-backed source transport.
  const embedded = /^(run_owner ')([\s\S]*?)('\n# End generated CI Git owner\.)$/mu;
  if (embedded.test(source)) {
    return source.replace(embedded, (_match, prefix: string, body: string, suffix: string) => {
      const adjusted = renderGitTestClock(body.replaceAll("'\\''", "'"), options);
      return prefix + adjusted.replaceAll("'", "'\\''") + suffix;
    });
  }
  // Command deadlines and TERM grace are independent. Real-clock callers keep
  // real grace unless they explicitly opt into the fixture's immediate escalation.
  const clockSource =
    (options.realDrain ?? options.realClock)
      ? source
      : source.replace("kill_at = deadline - cleanup_seconds / 2", "kill_at = time.monotonic()");
  if (options.realClock) {
    return clockSource;
  }
  // Only a ready, deliberately stalled tree advances the fetch clock. Real
  // process startup and teardown retain their independent wall-clock watchdogs.
  return (
    clockSource
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
      .replace(/\btimeout=(?:30|60|120)(?=[,)])/gu, "timeout=2")
      .replace(
        /retry_at = time\.monotonic\(\) \+ [^\n]+/u,
        'print(f"fixture backoff: {seconds}", flush=True)\n    retry_at = time.monotonic() + 0.05',
      )
      .replace(/--((?:checkout-)?git) 120\b/gu, "--$1 2")
      // Keep pre-fix standalone shell bodies executable for red/green proof.
      .replaceAll("120s git", "2s git")
      .replaceAll("sleep $((attempt * 2))", 'echo "fixture backoff: $((attempt * 2))"')
      .replaceAll("sleep $((attempt * 5))", "sleep 0.05")
      .replaceAll("sleep 5", "sleep 0.05")
  );
}

export function expectCiCheckoutCleanup(report: Report) {
  assert.deepEqual(report.cleanupRemaining, [], "fixture cleanup left owned processes");
  assert.equal(report.boundaries.at(-1)?.name, "exit");
  assert(
    report.boundaries.every((entry) => entry.sentinelAlive),
    "unrelated process killed",
  );
  assert.deepEqual(
    report.boundaries.filter((entry) => entry.alive.length > 0),
    [],
    "Git descendants survived BEFORE deletion, reuse, consumption, or exit",
  );
}

export async function withCiCheckoutFixture<T>(
  scenario: string,
  prepare: (root: string) => NodeJS.ProcessEnv | void,
  inspect: (report: Report, result: CloseResult, stderr: string, root: string) => T | Promise<T>,
): Promise<T> {
  // Detached writers can outlive Vitest's oc-vt TMPDIR. Retained diagnostics must
  // start outside that recursively deleted namespace, including on setup failure.
  const artifacts = fileURLToPath(new URL("../../.artifacts/ci-checkout/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = realpathSync(mkdtempSync(path.join(artifacts, "checkout ")));
  let supervisor: ChildProcess;
  try {
    mkdirSync(path.join(root, "workspace"));
    const env = { ...process.env, ...prepare(root) };
    supervisor = fork(ciCheckoutFixture, ["supervise", root, scenario], {
      detached: true,
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env,
    });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  let stderr = "";
  // An error can precede close, including failed spawn. Never reject this join.
  const closed = new Promise<CloseResult>((resolve) => {
    supervisor.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  supervisor.stderr?.on("data", (data) => (stderr += String(data)));
  supervisor.on("error", (error) => (stderr += `${error}\n`));
  let timer: NodeJS.Timeout | undefined;
  let report: Report | undefined;
  try {
    const completed = await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Checkout supervisor did not close within 50000ms")),
          50_000,
        );
      }),
    ]);
    clearTimeout(timer);
    report = reportSchema.parse(JSON.parse(readFileSync(path.join(root, "report.json"), "utf8")));
    return await inspect(report, completed, stderr, root);
  } finally {
    clearTimeout(timer);
    if (report) {
      // A consumer assertion failure does not revoke the producer's release receipt.
      rmSync(root, { recursive: true, force: true });
    } else {
      const deadline = Date.now() + 4_000;
      // Keep IPC attached through termination: explicit disconnect can suppress Node's close.
      // Let lease-bound Git descendants stop even if the supervisor cannot run cleanup.
      rmSync(path.join(root, "lease"), { force: true });
      const termination = terminateManagedChild(supervisor, "SIGKILL", {
        taskkillTimeoutMs: 2_000,
        processGroupFallback: "never",
      });
      const groupDead = () =>
        !supervisor.pid ||
        (process.platform === "win32"
          ? termination?.processTreeState === "terminated"
          : inspectManagedProcessGroup(supervisor, { errorPolicy: "indeterminate" }) === "dead");
      // Join actual close before checking extinction, sharing the original cleanup budget.
      const didClose = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
        }),
      ]);
      clearTimeout(timer);
      while (!groupDead()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          break;
        }
        await delay(Math.min(10, remaining));
      }
      console.error(
        `Checkout fixture retained at ${root}; no completed report. ` +
          `Supervisor close: ${didClose}; group extinction: ${groupDead()}. ` +
          `Inspect workflow.log and stop remaining owned writers before removing this exact directory.\n${stderr}`,
      );
    }
  }
}
