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
// Raw owner lifecycle checks use the shared POSIX census on Linux and macOS.
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

type QaGitCase = {
  label: string;
  job: string;
  step: string;
  env?: Record<string, string>;
  fetches: string[][];
  readbacks: string[];
  checkout?: string;
  selected?: boolean;
  reason?: string;
};
const qaMainFetch = ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"];
const qaBootstrapFetch = ["fetch", "--no-tags", "--no-recurse-submodules", "--depth=1", "origin"];
const qaGitCases: QaGitCase[] = [
  {
    label: "main validation",
    job: "validate_selected_ref",
    step: "Validate selected ref",
    fetches: [qaMainFetch],
    readbacks: ["HEAD", `${candidate}^1`],
    reason: "main-ancestor",
  },
  {
    label: "release tag validation",
    job: "validate_selected_ref",
    step: "Validate selected ref",
    env: { INPUT_REF: "refs/tags/v2026.8.1" },
    fetches: [
      qaMainFetch,
      ["fetch", "--no-tags", "origin", "+refs/tags/v2026.8.1:refs/tags/v2026.8.1"],
    ],
    readbacks: ["HEAD", "refs/tags/v2026.8.1^{commit}"],
    reason: "release-tag",
  },
  {
    label: "release branch validation",
    job: "validate_selected_ref",
    step: "Validate selected ref",
    env: { INPUT_REF: "refs/heads/release/2026.8.1" },
    fetches: [
      qaMainFetch,
      [
        "fetch",
        "--no-tags",
        "origin",
        "+refs/heads/release/2026.8.1:refs/remotes/origin/release/2026.8.1",
      ],
    ],
    readbacks: ["HEAD", "refs/remotes/origin/release/2026.8.1"],
    reason: "release-branch-head",
  },
  {
    label: "trusted harness restore",
    job: "plan_qa_profile",
    step: "Restore trusted QA harness revision",
    fetches: [[...qaBootstrapFetch, harness]],
    readbacks: ["HEAD"],
    checkout: harness,
  },
  {
    label: "selected checkout",
    job: "plan_qa_profile",
    step: "Checkout selected ref",
    fetches: [[...qaBootstrapFetch, candidate]],
    readbacks: ["HEAD"],
    checkout: "FETCH_HEAD",
    selected: true,
  },
  {
    label: "protocol comparison base",
    job: "run_qa_profile_shard",
    step: "Fetch protocol comparison base",
    fetches: [[...qaBootstrapFetch, `+${base}:refs/remotes/origin/qa-protocol-base`]],
    readbacks: ["refs/remotes/origin/qa-protocol-base^{commit}"],
    selected: true,
  },
];

function runQaGitCase(profile: QaGitCase, fetchResults: FetchResult[]) {
  return runCiGitStep({
    workflow: {
      file: ".github/workflows/qa-profile-evidence.yml",
      job: profile.job,
      step: profile.step,
    },
    fetchResults,
    // Preserve real 120-second/no-deadline calls and real cleanup; readiness,
    // not a sleep, ensures every successful Git leader leaves two live writers.
    realClock: true,
    poisonPython: true,
    env: {
      EXPECTED_SHA: candidate,
      EXPECTED_WORKFLOW_SHA: harness,
      INPUT_REF: "main",
      GITHUB_SERVER_URL: "https://github.com",
      ...profile.env,
    },
    revisions: {
      [`${candidate}^1`]: base,
      "refs/tags/v2026.8.1": candidate,
      "refs/tags/v2026.8.1^{commit}": candidate,
      "refs/heads/release/2026.8.1": candidate,
      "refs/remotes/origin/qa-protocol-base^{commit}": base,
    },
    mergeBase: { ancestor: true, revision: base },
    baseAvailableAfter: 0,
  });
}

posixIt.each(qaGitCases)(
  "QA Git owner drains descendants before the next boundary: $label",
  async (profile) => {
    const report = await runQaGitCase(
      profile,
      profile.fetches.map(() => 0),
    );
    expect(report.code, report.output).toBe(0);
    expect(report.readyAttempts).toEqual(profile.fetches.map((_, index) => index + 1));
    expect(report.fetches.map(({ args }) => args)).toEqual(profile.fetches);
    const cwd = profile.selected ? path.join(report.workspace, "selected") : report.workspace;
    expect(
      report.fetches.every((fetch) => fetch.cwd === cwd && fetch.configuration?.length === 0),
    ).toBe(true);
    expect(
      report.commands
        .filter(({ args }) => args[0] === "rev-parse")
        .map(({ args, cwd }) => ({ args, cwd })),
    ).toEqual(profile.readbacks.map((ref) => ({ args: ["rev-parse", ref], cwd })));
    expect(report.checkouts.map(({ args, cwd }) => ({ args, cwd }))).toEqual(
      profile.checkout ? [{ args: ["checkout", "--detach", profile.checkout], cwd }] : [],
    );
    if (profile.step === "Checkout selected ref") {
      expect(report.commands.map(({ args }) => args[0])).toEqual([
        "init",
        "remote",
        "fetch",
        "checkout",
        "rev-parse",
      ]);
      expect(report.commands.slice(0, 2)).toMatchObject([
        { cwd: report.workspace, args: ["init", "selected"] },
        { cwd, args: ["remote", "add", "origin", "https://github.com/fixture/checkout"] },
      ]);
    }
    expect(report.githubOutput).toBe(
      profile.reason
        ? `protocol_base_revision=${base}\nselected_revision=${candidate}\ntrusted_reason=${profile.reason}\n`
        : "",
    );
    if (profile.reason) {
      expect(report.githubSummary).toContain(`Trust reason: \`${profile.reason}\``);
      expect(report.githubSummary).toContain(`Protocol base: \`${base}\``);
    }
    expect(report.githubEnv).toBe("");
    expect(report.githubPath).toBe("");
  },
  55_000,
);

posixIt.each(qaGitCases.filter(({ label, reason }) => !reason || label === "main validation"))(
  "QA Git owner stops without downstream work after cleanup failure: $label",
  async (profile) => {
    const report = await runQaGitCase(profile, ["cleanup-failure"]);
    expect(report.code, report.output).toBe(125);
    expect(report.readyAttempts).toEqual([1]);
    expect(report.fetches.map(({ args }) => args)).toEqual([profile.fetches[0]]);
    expect(report.commands.at(-1)?.args[0]).toBe("fetch");
    expect(report.checkouts).toEqual([]);
    expect(
      report.commands.filter(({ args }) => args[0] === "rev-parse").map(({ args }) => args),
    ).toEqual(profile.reason ? [["rev-parse", "HEAD"]] : []);
    expect(report.githubOutput).toBe("");
    expect(report.githubEnv).toBe("");
    expect(report.githubSummary).toBe("");
    expect(report.githubPath).toBe("");
    expect(report.output).toContain("Git ownership/setup failed");
  },
  55_000,
);

const mantisReleaseRef = "release/2026.8.1";
const mantisReleaseFetch = [
  "fetch",
  "--no-tags",
  "origin",
  `+refs/heads/${mantisReleaseRef}:refs/remotes/origin/${mantisReleaseRef}`,
];
const mantisCases = [
  { label: "candidate main ancestor", shared: true },
  { label: "baseline before candidate", shared: true, baseline: true },
  { label: "Discord main ancestor", shared: false },
  { label: "Discord exact release branch", shared: false, release: true },
  {
    label: "Discord release mismatch never consults PRs",
    shared: false,
    release: true,
    mismatch: true,
  },
] satisfies {
  label: string;
  shared: boolean;
  baseline?: boolean;
  release?: boolean;
  mismatch?: boolean;
}[];

posixIt.each([
  ...mantisCases.map((entry) => ({ ...entry, failure: 0 as FetchResult })),
  ...[true, false].flatMap((shared) =>
    (["cleanup-failure", 23] satisfies FetchResult[]).map((failure) => ({
      label: `${shared ? "shared action" : "Discord"} terminal ${failure}`,
      shared,
      failure,
    })),
  ),
])(
  "Mantis ref Git owner drains before trust probes and publication: $label",
  async (profile) => {
    const { shared, failure } = profile;
    const baseline = "baseline" in profile && profile.baseline;
    const release = "release" in profile && profile.release;
    const mismatch = "mismatch" in profile && profile.mismatch;
    const fetches = release ? [qaMainFetch, mantisReleaseFetch] : [qaMainFetch];
    const report = await runCiGitStep({
      ...(shared
        ? ({ action: "mantis-validate-trusted-ref", step: "Validate refs are trusted" } as const)
        : {
            workflow: {
              file: ".github/workflows/mantis-discord-smoke.yml",
              job: "validate_selected_ref",
              step: "Validate selected ref",
            },
          }),
      fetchResults: failure ? [failure] : fetches.map(() => 0),
      realClock: true,
      poisonPython: true,
      env: {
        BASELINE_REF: baseline ? "baseline" : "",
        CANDIDATE_REF: "candidate",
        INPUT_REF: release ? mantisReleaseRef : "main",
      },
      revisions: {
        "baseline^{commit}": base,
        "candidate^{commit}": candidate,
        [`refs/heads/${mantisReleaseRef}`]: mismatch ? moved : candidate,
      },
      mergeBase: { ancestor: !release, revision: base },
    });
    const code = failure === "cleanup-failure" ? 125 : failure || (mismatch ? 1 : 0);
    expect(report.code, report.output).toBe(code);
    expect(report.readyAttempts).toEqual(fetches.map((_, index) => index + 1));
    expect(report.fetches.map(({ args }) => args)).toEqual(fetches);
    expect(
      report.fetches.every(
        ({ cwd, configuration }) => cwd === report.workspace && configuration?.length === 0,
      ),
    ).toBe(true);
    expect(report.commands.filter(({ tool }) => tool === "gh")).toEqual([]);
    const probes = failure
      ? []
      : [
          ...(baseline
            ? [
                ["rev-parse", "baseline^{commit}"],
                ["merge-base", "--is-ancestor", base, "refs/remotes/origin/main"],
              ]
            : []),
          ...(shared ? [["rev-parse", "candidate^{commit}"]] : []),
          ["merge-base", "--is-ancestor", candidate, "refs/remotes/origin/main"],
          ...(release
            ? [
                ["tag", "--points-at", candidate],
                mantisReleaseFetch,
                ["rev-parse", `refs/remotes/origin/${mantisReleaseRef}`],
              ]
            : []),
        ];
    expect(report.commands.map(({ args }) => args)).toEqual([
      ...(!shared ? [["rev-parse", "HEAD"]] : []),
      qaMainFetch,
      ...probes,
    ]);
    const reason = release ? "release-branch-head" : "main-ancestor";
    expect(report.githubOutput).toBe(
      code !== 0
        ? ""
        : shared
          ? `${baseline ? `baseline_revision=${base}\n` : ""}candidate_revision=${candidate}\n`
          : `selected_revision=${candidate}\ntrusted_reason=${reason}\n`,
    );
    expect(report.githubSummary).toBe(
      code !== 0
        ? ""
        : shared
          ? `${baseline ? `baseline: \`baseline\`\nbaseline SHA: \`${base}\`\nbaseline trust reason: \`main-ancestor\`\n` : ""}candidate: \`candidate\`\ncandidate SHA: \`${candidate}\`\ncandidate trust reason: \`main-ancestor\`\n`
          : `Validated ref: \`${release ? mantisReleaseRef : "main"}\`\nResolved SHA: \`${candidate}\`\nTrust reason: \`${reason}\`\n`,
    );
    expect(report.githubEnv).toBe("");
    expect(report.githubPath).toBe("");
    if (failure === "cleanup-failure") {
      expect(report.output).toContain("Git ownership/setup failed");
    }
    if (mismatch) {
      expect(report.output).toContain("not trusted for this secret-bearing Mantis run");
    }
  },
  55_000,
);
