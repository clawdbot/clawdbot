import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { runCiGitStep, type FetchResult } from "./ci-git-owner.test-support.js";

const candidate = "a".repeat(40);
const harness = "b".repeat(40);
const base = "c".repeat(40);
const moved = "d".repeat(40);
const merge = "e".repeat(40);
const linuxIt = it.skipIf(process.platform !== "linux");
// Command-shape assertions need no process-group census, so they also run on macOS.
const posixIt = it.skipIf(process.platform === "win32");

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
    const report = await runCiGitStep({ job, step, fetchResults });
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
    const report = await runCiGitStep({ job: "skills-python", fetchResults });
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
    const report = await runCiGitStep({ job: "android", fetchResults, checkoutResults });
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
    const report = await runCiGitStep({
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
    const report = await runCiGitStep({
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
    const report = await runCiGitStep({
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
    const report = await runCiGitStep({
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
    const report = await runCiGitStep({ job: "preflight", env, fetchResults });
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
    const report = await runCiGitStep({
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
    const report = await runCiGitStep({
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
    const report = await runCiGitStep({
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
    const report = await runCiGitStep({
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
    const report = await runCiGitStep({
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

posixIt(
  "fetches the CI harness without a second full-repository snapshot",
  async () => {
    const report = await runCiGitStep({ job: "checks-fast-core", fetchResults: [0, 0] });
    expect(report.code).toBe(0);
    const harnessDirectory = path.join(report.workspace, ".ci-harness");
    const harnessCommands = report.commands.filter(
      ({ tool, cwd }) => tool === "git" && cwd === harnessDirectory,
    );
    // The harness supplies only .github/actions: narrowing must be in place before the
    // fetch runs, so it never downloads the blobs the sparse checkout discards.
    expect(harnessCommands.map(({ args }) => args[0])).toEqual([
      "init",
      "remote",
      "sparse-checkout",
      "fetch",
      "checkout",
    ]);
    const harnessFetch = expectDefined(
      harnessCommands.find(({ args }) => args[0] === "fetch"),
      "harness fetch",
    );
    expect(harnessFetch.args).toEqual(expect.arrayContaining(["--filter=blob:none"]));
    expect(harnessFetch.args.at(-1)).toBe(`+${harness}:refs/remotes/origin/ci-harness`);
    // The selected checkout still needs real file contents, so it must stay unfiltered.
    const workspaceFetch = expectDefined(
      report.fetches.find(({ cwd }) => cwd === report.workspace),
      "workspace fetch",
    );
    expect(workspaceFetch.args).not.toContain("--filter=blob:none");
  },
  55_000,
);
