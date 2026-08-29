import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  accelerateCiCheckoutFetchClock,
  expectCiCheckoutCleanup,
  readCiCheckoutStep,
  withCiCheckoutFixture,
} from "./ci-checkout.test-support.js";

type FetchResult = number | "hang" | "cleanup-failure";

const candidate = "a".repeat(40);
const harness = "b".repeat(40);
const base = "c".repeat(40);
const moved = "d".repeat(40);
const merge = "e".repeat(40);
const linuxIt = it.skipIf(process.platform !== "linux");
const defaults: Record<string, string> = {
  CHECKOUT_REPO: "fixture/checkout",
  CHECKOUT_REF: candidate,
  CHECKOUT_SHA: candidate,
  CHECKOUT_FALLBACK_REF: candidate,
  CHECKOUT_EVENT_REF: "refs/heads/main",
  WORKFLOW_SHA: harness,
  GITHUB_EVENT_NAME: "push",
  GITHUB_REPOSITORY: "fixture/checkout",
  DEFAULT_BRANCH: "main",
  EVENT_BASE_SHA: base,
  GH_TOKEN: "",
  PULL_REQUEST_NUMBER: "17",
  PR_COMMIT_COUNT: "5",
  PR_MERGE_SHA: merge,
  TARGET_SHA: candidate,
  RELEASE_GATE: "false",
  FROZEN_TARGET: "false",
  HISTORICAL_TARGET: "false",
  FORMAT_CHECK: "false",
  RUN_CONTROL_UI_I18N: "false",
  RUN_UI_TESTS: "false",
  HOSTED_RUNNER_STRIPES: "false",
  RUNNER_PROFILE: "github",
  PR_BASE_SHA: base,
  DIFF_BASE_SHA: base,
  PROTOCOL_SINCE_BASE_SHA: base,
  RATCHET_PR_HEAD_SHA: candidate,
};

function stepEnvironment(
  step: ReturnType<typeof readCiCheckoutStep>,
  supplied: Record<string, string>,
) {
  const resolved = { ...defaults, ...supplied };
  for (const [key, value] of Object.entries(step.env ?? {})) {
    if (String(value).startsWith("${{")) {
      if (resolved[key] === undefined) {
        throw new Error(`Unresolved fixture workflow environment: ${key}`);
      }
    } else {
      resolved[key] = String(value);
    }
  }
  return resolved;
}

function accelerate(run: string, timeoutReadyFile?: string) {
  // For cancellation, advance this copy's timeout only after full tree readiness
  // and retain the real TERM grace so the signal reaches drain, not startup.
  const timeoutCheck = "if deadline is not None and time.monotonic() >= deadline:";
  const accelerated = timeoutReadyFile
    ? run.replace(
        timeoutCheck,
        `if deadline is not None and os.path.isfile(${JSON.stringify(timeoutReadyFile)}):`,
      )
    : accelerateCiCheckoutFetchClock(run);
  const killAt = timeoutReadyFile
    ? "kill_at = deadline - cleanup_seconds / 2"
    : "kill_at = time.monotonic()";
  return (
    accelerated
      .replace(/fetch_timeout_seconds = [^\n]+/u, "fetch_timeout_seconds = 2")
      .replace("kill_at = deadline - cleanup_seconds / 2", killAt)
      .replace(/retry_at = time\.monotonic\(\) \+ [^\n]+/u, "retry_at = time.monotonic() + 0.05")
      .replaceAll("--git 120", "--git 2")
      // Keep pre-fix standalone shell bodies executable for red/green proof.
      .replaceAll("120s git", "2s git")
      .replaceAll("sleep $((attempt * 5))", "sleep 0.05")
      .replaceAll("sleep 5", "sleep 0.05")
  );
}

async function runStep(options: {
  job: string;
  step?: string;
  env?: Record<string, string>;
  fetchResults: FetchResult[];
  checkoutResults?: number[];
  mergeSnapshots?: { sha: string; head: string }[];
  prepare?: boolean;
  cancelDuringCleanup?: boolean;
  revisions?: Record<string, string>;
  poisonPython?: boolean;
}) {
  const step = readCiCheckoutStep(options.job, options.step ?? "Checkout");
  const env = stepEnvironment(step, options.env ?? {});
  return withCiCheckoutFixture(
    "linux:configured",
    (root) => {
      const workspace = path.join(root, "workspace");
      const protectedFile = path.join(
        env.CHECKOUT_KIND === "clawhub" ? workspace : root,
        "protected",
      );
      writeFileSync(protectedFile, "not checkout-owned\n");
      if (["android", "clawhub"].includes(env.CHECKOUT_KIND ?? "")) {
        const checkout =
          env.CHECKOUT_KIND === "clawhub" ? path.join(workspace, "clawhub-source") : workspace;
        mkdirSync(checkout, { recursive: true });
        writeFileSync(path.join(checkout, ".previous-checkout"), "stale\n");
      }
      if (options.poisonPython) {
        env.PYTHONPATH = workspace;
        const poison = `from pathlib import Path\nPath(${JSON.stringify(path.join(root, "python-injected"))}).write_text("injected")\nraise RuntimeError("candidate Python startup executed")\n`;
        for (const name of ["sitecustomize.py", "subprocess.py"]) {
          writeFileSync(path.join(workspace, name), poison);
        }
      }
      const revisions = {
        HEAD: candidate,
        "refs/heads/main": moved,
        "refs/pull/17/merge": merge,
        "refs/remotes/origin/release-gate-merge^1": base,
        "refs/remotes/origin/release-gate-merge^2": candidate,
        ...options.revisions,
      };
      writeFileSync(
        path.join(root, "fixture-options.json"),
        JSON.stringify({
          env,
          revisions,
          fetchResults: options.fetchResults,
          checkoutResults: options.checkoutResults,
          mergeSnapshots: options.mergeSnapshots,
          consumers: options.prepare ?? false,
          cancelDuringCleanup: options.cancelDuringCleanup,
        }),
      );
      const readyFile = options.cancelDuringCleanup ? path.join(root, "ready-1.json") : undefined;
      let run = accelerate(step.run, readyFile);
      if (options.prepare) {
        const prepare = readCiCheckoutStep("security-fast", "Prepare Git owner");
        const prepareEnv = stepEnvironment(prepare, {});
        writeFileSync(path.join(root, "prepare.sh"), accelerate(prepare.run, readyFile));
        // Run the actual prepare body in its own shell: its exec must not replace the caller.
        run = `CHECKOUT_KIND=${prepareEnv.CHECKOUT_KIND} bash --noprofile --norc -eo pipefail "$TMPDIR/prepare.sh"\n${run}`;
      }
      writeFileSync(path.join(root, "checkout.sh"), run);
    },
    (report, result, stderr, root) => {
      const workspace = path.join(root, "workspace");
      const protectedFile = path.join(
        env.CHECKOUT_KIND === "clawhub" ? workspace : root,
        "protected",
      );
      console.log(`${options.job}/${options.step ?? "Checkout"}: ${JSON.stringify(report)}`);
      expect(result, stderr).toEqual({ code: 0, signal: null });
      expect(report.error, stderr).toBeUndefined();
      expectCiCheckoutCleanup(report);
      expect(readFileSync(protectedFile, "utf8")).toBe("not checkout-owned\n");
      expect(
        existsSync(path.join(root, "python-injected")),
        "candidate Python startup executed",
      ).toBe(false);
      const readOutput = (name: string) =>
        existsSync(path.join(root, name)) ? readFileSync(path.join(root, name), "utf8") : "";
      return {
        ...report,
        workspace,
        githubOutput: readOutput("github-output"),
        githubEnv: readOutput("github-env"),
        fetches: report.commands.filter(({ tool, args }) => tool === "git" && args[0] === "fetch"),
        checkouts: report.commands.filter(
          ({ tool, args }) => tool === "git" && args[0] === "checkout",
        ),
      };
    },
  );
}

const resetProfiles = [
  {
    job: "android",
    step: "Checkout",
    target: `+${candidate}:refs/remotes/origin/ci-target`,
    remote: "fixture/checkout",
  },
  {
    job: "check-docs",
    step: "Checkout ClawHub docs source",
    target: "+refs/heads/main:refs/remotes/origin/checkout",
    remote: "openclaw/clawhub",
  },
];
const resetCases: { label: string; fetchResults: FetchResult[]; code: number; attempts: number }[] =
  [
    { label: "leader exit", fetchResults: [0], code: 0, attempts: 1 },
    { label: "timeout recovery", fetchResults: ["hang", 0], code: 0, attempts: 2 },
    { label: "timeouts exhausted", fetchResults: Array(5).fill("hang"), code: 1, attempts: 5 },
    { label: "unverified cleanup", fetchResults: ["cleanup-failure"], code: 125, attempts: 1 },
  ];
linuxIt.each(resetProfiles.flatMap((profile) => resetCases.map((entry) => ({ profile, entry }))))(
  "$profile.job drains descendants before reset/reuse ($entry.label)",
  async ({ profile: { job, step, target, remote }, entry: { fetchResults, code, attempts } }) => {
    const report = await runStep({ job, step, fetchResults });
    expect(report.code).toBe(code);
    expect(report.readyAttempts).toHaveLength(attempts);
    expect(report.fetches).toHaveLength(attempts);
    expect(report.boundaries.filter(({ name }) => name === "delete")).toHaveLength(attempts);
    expect(report.checkouts).toHaveLength(code === 0 ? 1 : 0);
    for (const fetch of report.fetches) {
      expect(fetch.args).toEqual(
        expect.arrayContaining([target, "--depth=1", "--no-tags", "--no-recurse-submodules"]),
      );
      expect(fetch.cwd).toBe(
        job === "android" ? report.workspace : path.join(report.workspace, "clawhub-source"),
      );
    }
    expect(
      report.commands
        .filter(({ args }) => args[0] === "remote")
        .every(({ args }) => args.at(-1) === `https://github.com/${remote}.git`),
    ).toBe(true);
  },
  55_000,
);

linuxIt.each([
  { label: "timeout recovery", fetchResults: ["hang", 0], code: 0, attempts: 2 },
  { label: "timeouts exhausted", fetchResults: ["hang", "hang", "hang"], code: 124, attempts: 3 },
  { label: "ordinary Git failure", fetchResults: [23], code: 23, attempts: 1 },
] satisfies { label: string; fetchResults: FetchResult[]; code: number; attempts: number }[])(
  "skills preserves exact-SHA retries without a fallback ($label)",
  async ({ fetchResults, code, attempts }) => {
    const report = await runStep({ job: "skills-python", fetchResults });
    expect(report.code).toBe(code);
    expect(report.fetches).toHaveLength(attempts);
    expect(
      report.fetches.every(
        ({ args }) =>
          args.includes(`+${candidate}:refs/remotes/origin/checkout`) && args.includes("--depth=1"),
      ),
    ).toBe(true);
    expect(report.checkouts).toHaveLength(code === 0 ? 1 : 0);
    expect(report.boundaries.some(({ name }) => name === "delete")).toBe(false);
  },
  55_000,
);

linuxIt.each([
  { phase: "fetch", fetchResults: [23, 0], checkoutResults: [], firstCheckout: false },
  { phase: "checkout", fetchResults: [0, 0], checkoutResults: [23, 0], firstCheckout: true },
])(
  "Android resets only after safely joined $phase failure",
  async ({ fetchResults, checkoutResults, firstCheckout }) => {
    const report = await runStep({ job: "android", fetchResults, checkoutResults });
    expect(report.code).toBe(0);
    expect(report.readyAttempts).toEqual([1, 2]);
    expect(report.fetches.map(({ args }) => args.at(-1))).toEqual([
      `+${candidate}:refs/remotes/origin/ci-target`,
      `+${candidate}:refs/remotes/origin/ci-target`,
    ]);
    expect(
      report.boundaries
        .filter(({ name }) => name === "delete" || name === "checkout" || name.startsWith("fetch:"))
        .map(({ name }) => name),
    ).toEqual([
      "delete",
      "fetch:1",
      ...(firstCheckout ? ["checkout"] : []),
      "delete",
      "fetch:2",
      "checkout",
    ]);
  },
  55_000,
);

const manualProfiles = [
  { job: "preflight", step: "Checkout", depth: 1 },
  { job: "security-fast", step: "Checkout manual target", depth: 2 },
];
linuxIt.each(
  manualProfiles.flatMap((profile) => [
    { ...profile, label: "missing branch", fetchResults: [128, 0] as FetchResult[], code: 0 },
    {
      ...profile,
      label: "timeout is not missing",
      fetchResults: ["hang", "hang", "hang"] as FetchResult[],
      code: 124,
    },
    {
      ...profile,
      label: "cleanup is not missing",
      fetchResults: ["cleanup-failure"] as FetchResult[],
      code: 125,
    },
  ]),
)(
  "$job only falls back after a safely joined unavailable target ($label)",
  async ({ job, step, depth, fetchResults, code }) => {
    const report = await runStep({
      job,
      step,
      fetchResults,
      env: { GITHUB_EVENT_NAME: "workflow_dispatch", CHECKOUT_REF: "refs/heads/missing" },
    });
    expect(report.code).toBe(code);
    const targetFetches = report.fetches.filter(({ args }) =>
      args.some((arg) => arg.endsWith(":refs/remotes/origin/checkout")),
    );
    expect(targetFetches.map(({ args }) => args.at(-1))).toEqual(
      code === 0
        ? [
            "+refs/heads/missing:refs/remotes/origin/checkout",
            `+${candidate}:refs/remotes/origin/checkout`,
          ]
        : fetchResults.map(() => "+refs/heads/missing:refs/remotes/origin/checkout"),
    );
    expect(targetFetches.every(({ args }) => args.includes(`--depth=${depth}`))).toBe(true);
    expect(report.fetches).toHaveLength(
      targetFetches.length + (job === "preflight" && code === 0 ? 1 : 0),
    );
    expect(report.checkouts).toHaveLength(code === 0 ? 1 : 0);
  },
  55_000,
);

linuxIt(
  "preflight pins a moved exact SHA and retries only its parent metadata",
  async () => {
    const report = await runStep({
      job: "preflight",
      fetchResults: [0, 0, 23, 0],
      env: { GITHUB_EVENT_NAME: "workflow_dispatch" },
      poisonPython: true,
    });
    expect(report.code).toBe(0);
    expect(report.fetches.map(({ args }) => args.at(-1))).toEqual([
      "+refs/heads/main:refs/remotes/origin/checkout",
      `+${candidate}:refs/remotes/origin/checkout`,
      candidate,
      candidate,
    ]);
    for (const fetch of report.fetches.slice(2)) {
      expect(fetch.args).toEqual(expect.arrayContaining(["--depth=2", "--filter=blob:none"]));
    }
    expect(report.checkouts.map(({ args }) => args)).toEqual([
      ["checkout", "--detach", "refs/remotes/origin/checkout"],
    ]);
  },
  55_000,
);

linuxIt(
  "manual security never refetches an unavailable equal fallback",
  async () => {
    const report = await runStep({
      job: "security-fast",
      step: "Checkout manual target",
      env: { GITHUB_EVENT_NAME: "workflow_dispatch" },
      fetchResults: [128],
    });
    expect(report.code).toBe(128);
    expect(report.fetches.map(({ args }) => args.at(-1))).toEqual([
      `+${candidate}:refs/remotes/origin/checkout`,
    ]);
    expect(report.checkouts).toEqual([]);
  },
  55_000,
);

linuxIt(
  "preflight rejects a fallback that cannot satisfy the requested exact SHA",
  async () => {
    const report = await runStep({
      job: "preflight",
      env: { GITHUB_EVENT_NAME: "workflow_dispatch", CHECKOUT_REF: moved },
      fetchResults: [128, 0],
    });
    expect(report.code).toBe(1);
    expect(report.fetches.map(({ args }) => args.at(-1))).toEqual([
      `+${moved}:refs/remotes/origin/checkout`,
      `+${candidate}:refs/remotes/origin/checkout`,
    ]);
    expect(report.checkouts).toEqual([]);
  },
  55_000,
);

const preflightCases: {
  label: string;
  env: Record<string, string>;
  fetchResults: FetchResult[];
  code: number;
}[] = [
  {
    label: "push never substitutes another ref",
    env: { GITHUB_EVENT_NAME: "push", CHECKOUT_REF: "refs/heads/missing" },
    fetchResults: [128],
    code: 128,
  },
  {
    label: "unavailable fallback does not recurse",
    env: { GITHUB_EVENT_NAME: "workflow_dispatch" },
    fetchResults: [128],
    code: 128,
  },
  {
    label: "parent metadata failure prevents checkout",
    env: {},
    fetchResults: [0, 23, 23, 23],
    code: 1,
  },
];
linuxIt.each(preflightCases)(
  "preflight fails closed: $label",
  async ({ env, fetchResults, code }) => {
    const report = await runStep({ job: "preflight", env, fetchResults });
    expect(report.code).toBe(code);
    expect(report.fetches).toHaveLength(fetchResults.length);
    expect(report.checkouts).toEqual([]);
  },
  55_000,
);

const historyProfiles: {
  job: string;
  step: string;
  env: Record<string, string>;
  target: string;
  depth: number;
  consumer: string;
}[] = [
  {
    job: "preflight",
    step: "Resolve exact diff base",
    env: { GITHUB_EVENT_NAME: "workflow_dispatch", RELEASE_GATE: "true" },
    target: "+refs/pull/17/merge:refs/remotes/origin/release-gate-merge",
    depth: 2,
    consumer: "",
  },
  {
    job: "security-fast",
    step: "Fetch pull request scan history",
    env: {},
    target: merge,
    depth: 7,
    consumer: "",
  },
  {
    job: "checks-fast-core",
    step: "Prepare release-gate ratchet merge tree",
    env: {},
    target: "+refs/pull/17/merge:refs/remotes/origin/ci-ratchet-merge",
    depth: 2,
    consumer: "",
  },
  {
    job: "checks-fast-core",
    step: "Run ${{ matrix.task }} (${{ matrix.runtime }})",
    env: { TASK: "bundled-protocol" },
    target: `+${base}:refs/remotes/origin/protocol-since-base`,
    depth: 1,
    consumer: "protocol:check",
  },
  {
    job: "check-shard",
    step: "Run check shard",
    env: { TASK: "guards" },
    target: `+${base}:refs/remotes/origin/ci-base`,
    depth: 1,
    consumer: "scripts/report-test-temp-creations.mjs",
  },
  {
    job: "check-shard",
    step: "Run check shard",
    env: { TASK: "npm-lock" },
    target: `+${base}:refs/remotes/origin/npm-lock-base`,
    depth: 1,
    consumer: "deps:npm-lock:check:changed",
  },
];

linuxIt.each(
  historyProfiles.flatMap((profile) => [
    { ...profile, label: "successful leader exit", fetchResults: [0] as FetchResult[], code: 0 },
    {
      ...profile,
      label: "unverified cleanup",
      fetchResults: ["cleanup-failure"] as FetchResult[],
      code: 125,
    },
  ]),
)(
  "$job/$step joins supplemental history before consumption ($label, $target)",
  async ({ job, step, env, target, depth, consumer, fetchResults, code }) => {
    const report = await runStep({
      job,
      step,
      env,
      fetchResults,
      prepare: true,
      poisonPython: true,
    });
    expect(report.code).toBe(code);
    expect(report.fetches).toHaveLength(1);
    expect(report.fetches[0]?.args).toEqual(expect.arrayContaining([target, `--depth=${depth}`]));
    if (consumer) {
      expect(report.commands.some(({ tool, args }) => tool !== "git" && args[0] === consumer)).toBe(
        code === 0,
      );
    }
    if (env.TASK === "npm-lock") {
      expect(report.commands.some(({ args }) => args[0] === "deps:npm-lock:check")).toBe(false);
    }
    if (step === "Resolve exact diff base") {
      expect(report.githubOutput).toBe(code === 0 ? `sha=${base}\nhead_sha=${merge}\n` : "");
    }
    if (step === "Prepare release-gate ratchet merge tree") {
      expect(report.githubEnv).toBe(code === 0 ? `RATCHET_BASE_REF=${base}\n` : "");
      expect(report.checkouts.map(({ args }) => args.at(-1))).toEqual(code === 0 ? [merge] : []);
    }
  },
  55_000,
);

linuxIt(
  "ratchet retries a stale merge parent before checkout and base publication",
  async () => {
    const report = await runStep({
      job: "checks-fast-core",
      step: "Prepare release-gate ratchet merge tree",
      fetchResults: [0, 0],
      mergeSnapshots: [
        { sha: "f".repeat(40), head: moved },
        { sha: merge, head: candidate },
      ],
      prepare: true,
    });
    expect(report.code).toBe(0);
    expect(report.fetches.map(({ args }) => args.at(-1))).toEqual([
      "+refs/pull/17/merge:refs/remotes/origin/ci-ratchet-merge",
      "+refs/pull/17/merge:refs/remotes/origin/ci-ratchet-merge",
    ]);
    expect(
      report.boundaries
        .filter(
          ({ name }) => name.startsWith("fetch:") || name === "show-parents" || name === "checkout",
        )
        .map(({ name }) => name),
    ).toEqual(["fetch:1", "show-parents", "fetch:2", "show-parents", "checkout"]);
    expect(report.checkouts.map(({ args }) => args.at(-1))).toEqual([merge]);
    expect(report.githubEnv).toBe(`RATCHET_BASE_REF=${base}\n`);
  },
  55_000,
);

linuxIt(
  "cancellation during raw Git timeout cleanup prevents npm-lock fallback",
  async () => {
    const report = await runStep({
      job: "check-shard",
      step: "Run check shard",
      env: { TASK: "npm-lock" },
      fetchResults: ["hang"],
      prepare: true,
      cancelDuringCleanup: true,
    });
    expect(report.cancelledDuringCleanup).toBe(true);
    expect(report.code).toBe(143);
    expect(report.fetches).toHaveLength(1);
    expect(report.commands.filter(({ tool }) => tool === "pnpm")).toEqual([]);
  },
  55_000,
);

linuxIt.each([23, "hang"] satisfies FetchResult[])(
  "npm-lock safely falls back to a full sweep after joined fetch failure (%s)",
  async (failure) => {
    const report = await runStep({
      job: "check-shard",
      step: "Run check shard",
      env: { TASK: "npm-lock" },
      fetchResults: [failure],
      prepare: true,
    });
    expect(report.code).toBe(0);
    expect(report.fetches).toHaveLength(1);
    expect(report.commands.filter(({ tool }) => tool === "pnpm").map(({ args }) => args)).toEqual([
      ["deps:npm-lock:check"],
    ]);
  },
  55_000,
);

linuxIt(
  "security rejects malformed scan depth before starting Git",
  async () => {
    const report = await runStep({
      job: "security-fast",
      step: "Fetch pull request scan history",
      env: { PR_COMMIT_COUNT: "invalid" },
      fetchResults: [],
      prepare: true,
    });
    expect(report.code).toBe(2);
    expect(report.fetches).toEqual([]);
    expect(report.readyAttempts).toEqual([]);
  },
  55_000,
);
