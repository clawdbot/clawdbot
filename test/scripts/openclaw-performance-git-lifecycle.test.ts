import { beforeAll, expect, it, vi } from "vitest";
import { runCiGitStep } from "./ci-git-owner.test-support.js";
import type { PerformanceFixtureOptions } from "./openclaw-performance-workflow.test-support.js";

// Each case owns its checkout and process trees. Overlap their real timeout and
// drain waits while keeping subprocess pressure bounded.
beforeAll(() => {
  vi.setConfig({ maxConcurrency: 2 });
  return () => vi.resetConfig();
});

// Performance jobs run on Ubuntu. Exercise their POSIX bodies here; the shared
// ci-platform-checkout suite owns native Windows Job Object proof.
const posixIt = it.skipIf(process.platform === "win32").concurrent;

const steps = {
  target: ["resolve_target", "Resolve OpenClaw target ref"],
  record: ["source_performance", "Record source performance revision"],
  tested: ["kova", "Record tested revision"],
  kova: ["kova", "Install OCM and Kova"],
  baseline: ["source_performance", "Fetch previous source performance baseline"],
  prepare: ["publish", "Prepare clawgrit report commit"],
  publish: ["publish", "Publish to clawgrit reports"],
} as const;

function performanceRun(
  mode: PerformanceFixtureOptions["mode"],
  options: Partial<Parameters<typeof runCiGitStep>[0]> = {},
) {
  const [job, step] = steps[mode];
  return runCiGitStep({
    workflow: { file: ".github/workflows/openclaw-performance.yml", job, step },
    fetchResults: [],
    performance: { mode },
    ...options,
  });
}

// The previous semantic tests used short-lived stubs or replayed Git by hand.
// These actual workflow bodies must drain real parent/child/grandchild writers
// before every command, output, consumer and exit, while a sentinel stays alive.
posixIt.each(Object.keys(steps) as PerformanceFixtureOptions["mode"][])(
  "Performance %s drains Git trees before every continuation",
  async (mode) => {
    const report = await performanceRun(mode);
    expect(report.code, report.output).toBe(0);
    expect(report.readyAttempts.length).toBeGreaterThan(0);
    if (mode === "prepare") {
      expect(report.githubOutput).toContain("ready=true\n");
    }
    if (mode === "publish") {
      expect(report.pushes).toHaveLength(1);
      expect(report.fetches).toHaveLength(0);
      expect(report.githubSummary).toContain("### Clawgrit report published");
    }
  },
  55_000,
);

posixIt.each([23, 124, 125, 143])(
  "baseline ordinary fetch %s is advisory after extinction",
  async (code) => {
    const report = await performanceRun("baseline", { fetchResults: [code, code, code] });
    expect(report.code, report.output).toBe(0);
    expect(report.githubSummary).toBe(
      "No previous source performance baseline could be fetched.\n",
    );
    expect(report.githubEnv).toBe("");
    expect(report.commands.at(-1)?.args[0]).toBe("fetch");
  },
  55_000,
);

posixIt.each(["absent", "invalid", "trailing-newline"] as const)(
  "baseline %s pointer preserves advisory result",
  async (baseline) => {
    const report = await performanceRun("baseline", {
      performance: { mode: "baseline", baseline },
    });
    expect(report.code, report.output).toBe(0);
    expect(report.githubSummary).toContain(
      baseline === "absent"
        ? "No previous source performance baseline exists"
        : "Previous source performance baseline pointer is invalid.",
    );
    expect(report.githubEnv).toBe("");
    expect(report.checkouts).toHaveLength(0);
  },
  55_000,
);

posixIt.each(["ls-tree", "show"])(
  "baseline %s failure never becomes absence or invalid JSON",
  async (operation) => {
    const report = await performanceRun("baseline", {
      gitFault: { match: `^${operation} `, code: 128 },
    });
    expect(report.code, report.output).toBe(128);
    expect(report.githubSummary).toBe("");
    expect(report.githubEnv).toBe("");
    expect(report.commands.at(-1)?.args[0]).toBe(operation);
  },
  55_000,
);

const terminalCases = [
  ...["rev-parse"].map((operation) => ({ mode: "target" as const, operation })),
  { mode: "record" as const, operation: "rev-parse" },
  { mode: "tested" as const, operation: "rev-parse" },
  ...["fetch", "checkout"].map((operation) => ({ mode: "kova" as const, operation })),
  ...["fetch", "ls-tree", "show", "sparse-checkout init", "sparse-checkout set", "checkout"].map(
    (operation) => ({ mode: "baseline" as const, operation }),
  ),
  ...["fetch", "ls-tree", "diff"].map((operation) => ({ mode: "prepare" as const, operation })),
  ...[
    "config",
    "push",
    "fetch",
    "ls-tree",
    "checkout",
    "cherry-pick -X",
    "cherry-pick --abort",
    "rev-parse",
  ].map((operation) => ({ mode: "publish" as const, operation })),
];
// Every injected lifecycle failure must stop at its command, before later policy actions.
posixIt.each(
  terminalCases.flatMap((entry) =>
    (["cleanup-failure", "cancel"] as const).map((code) => ({
      mode: entry.mode,
      operation: entry.operation,
      code,
    })),
  ),
)(
  "$mode $operation $code fences every later action",
  async ({ mode, operation, code }) => {
    const report = await performanceRun(mode, {
      gitFault: { match: `^${operation}(?: |$)`, code },
      ...(mode === "publish" && operation !== "config" && operation !== "push"
        ? { pushResults: [23] }
        : {}),
      ...(operation === "cherry-pick --abort"
        ? { gitFaults: [{ match: "^cherry-pick -X ", code: 23 }] }
        : {}),
    });
    expect(report.code, report.output).toBe(code === "cancel" ? 143 : 125);
    expect(report.commands.at(-1)?.args.join(" ")).toMatch(new RegExp(`^${operation}(?: |$)`));
    expect(report.githubSummary).toBe("");
    expect(report.githubOutput).not.toMatch(/ready=true|already_published=|report_url=/u);
    expect(report.githubEnv).not.toContain("SOURCE_PERF_BASELINE_DIR=");
    expect(report.output).not.toMatch(
      /Unable to replay|Unable to refresh|No previous|Published report:/u,
    );
    const failedPush = mode === "publish" && operation === "push";
    if (failedPush) {
      expect(report.fetches).toHaveLength(0);
      expect(report.output).not.toContain("fixture backoff:");
    }
  },
  55_000,
);

posixIt.each(["hang", 23, 124, 125, 143] as const)(
  "prepare initial fetch %s cannot reach checkout, commit or token readiness",
  async (failure) => {
    const report = await performanceRun("prepare", { fetchResults: [failure, failure, failure] });
    expect(report.code, report.output).toBe(1);
    expect(report.fetches).toHaveLength(3);
    expect(report.fetches.every(({ args }) => args.includes("--depth=1"))).toBe(true);
    expect(report.checkouts).toHaveLength(0);
    expect(report.commands.at(-1)?.args[0]).toBe("fetch");
    expect(report.githubOutput).toBe("ready=false\n");
    expect(report.githubSummary).toBe("");
  },
  55_000,
);

posixIt(
  "initial duplicate is verified before token or push",
  async () => {
    const report = await performanceRun("prepare", {
      performance: { mode: "prepare", duplicate: true },
    });
    expect(report.code, report.output).toBe(0);
    expect(report.githubOutput).toContain("already_published=true\n");
    expect(report.githubOutput).toContain("ready=true\n");
    expect(report.githubOutput).not.toContain("report_commit=");
    expect(report.githubSummary).toContain("### Clawgrit report already published");
    expect(report.pushes).toHaveLength(0);
    expect(report.commands.some(({ args }) => args[0] === "commit")).toBe(false);
    expect(
      report.commands.every(
        ({ envProbe, args }) =>
          !JSON.parse(envProbe!).token && JSON.parse(envProbe!).auth === (args[0] === "fetch"),
      ),
    ).toBe(true);
  },
  55_000,
);

posixIt.each([128, 124, 125, 143])(
  "prepare duplicate inspection %s is terminal",
  async (code) => {
    const report = await performanceRun("prepare", { gitFault: { match: "^ls-tree ", code } });
    expect(report.code, report.output).toBe(code);
    expect(report.githubOutput).toBe("ready=false\n");
    expect(report.commands.at(-1)?.args[0]).toBe("ls-tree");
  },
  55_000,
);

posixIt.each([0, 1, 2, 124, 125, 143])(
  "cached diff status %s commits only for ordinary 1",
  async (code) => {
    const report = await performanceRun("prepare", {
      gitFault: { match: "^diff --cached --quiet$", code, output: "" },
    });
    expect(report.code, report.output).toBe(code > 1 ? code : 0);
    expect(report.commands.filter(({ args }) => args[0] === "commit")).toHaveLength(
      code === 1 ? 1 : 0,
    );
    expect(report.githubOutput.includes("ready=true\n")).toBe(code <= 1);
  },
  55_000,
);

posixIt.each([124, 125, 143, "hang"] as const)(
  "ambiguous push %s reconciles only after extinction",
  async (code) => {
    const report = await performanceRun("publish", { pushResults: [code] });
    expect(report.code, report.output).toBe(0);
    expect(report.pushes).toHaveLength(2);
    expect(report.fetches).toHaveLength(1);
    expect(report.checkouts).toHaveLength(1);
    expect(report.output.match(/fixture backoff: \d+/gu)).toEqual(["fixture backoff: 2"]);
    expect(report.githubSummary).toContain("### Clawgrit report published");
    expect(report.performance?.config).not.toContain("AUTHORIZATION");
    for (const command of report.commands) {
      const scope = JSON.parse(command.envProbe!);
      expect(scope.token).toBe(false);
      const authenticated = [
        "push",
        "fetch",
        "ls-tree",
        "checkout",
        "cherry-pick",
        "rev-parse",
      ].includes(command.args[0]!);
      expect(scope.auth).toBe(authenticated);
      if (scope.auth) {
        expect(scope).toMatchObject({ count: "3", prompt: "0" });
      }
      if (command.args[0] === "push") {
        expect(command.configuration).toContain("core.hooksPath=/dev/null");
      }
    }
    expect(JSON.stringify(report)).not.toContain("fixture-performance-token");
    expect(JSON.stringify(report)).not.toContain(
      Buffer.from("x-access-token:fixture-performance-token").toString("base64"),
    );
  },
  55_000,
);

posixIt.each([false, true])(
  "five failed pushes always get five fetches (fetch fails=%s)",
  async (fetchFails) => {
    const report = await performanceRun("publish", {
      pushResults: [23, 23, 23, 23, 23],
      fetchResults: fetchFails ? [23, 23, 23, 23, 23] : [],
    });
    expect(report.code, report.output).toBe(1);
    expect(report.pushes).toHaveLength(5);
    expect(report.boundaries.filter(({ name }) => name === "backoff")).toHaveLength(5);
    expect(report.fetches.map(({ args }) => args)).toEqual(
      Array.from({ length: 5 }, () => ["fetch", "--depth=1", "origin", "main"]),
    );
    expect(report.output.match(/fixture backoff: \d+/gu)).toEqual(
      [2, 4, 6, 8, 10].map((seconds) => `fixture backoff: ${seconds}`),
    );
    expect(report.checkouts).toHaveLength(fetchFails ? 0 : 4);
    expect(report.commands.filter(({ args }) => args[0] === "cherry-pick")).toHaveLength(
      fetchFails ? 0 : 4,
    );
    expect(report.output.match(/::warning::Unable to refresh/gu) ?? []).toHaveLength(
      fetchFails ? 4 : 0,
    );
    expect(report.githubSummary).toContain("failed after 5 attempts.");
    expect(report.githubSummary).not.toContain("Published report:");
  },
  55_000,
);

posixIt.each([1, 2, 3, 4, 5])(
  "remote duplicate after ambiguous attempt %s succeeds without replay",
  async (attempt) => {
    const report = await performanceRun("publish", {
      performance: { mode: "publish", remoteDuplicateAttempt: attempt },
      pushResults: Array.from({ length: attempt }, () => 124),
    });
    expect(report.code, report.output).toBe(0);
    expect(report.pushes).toHaveLength(attempt);
    expect(report.fetches).toHaveLength(attempt);
    expect(report.checkouts).toHaveLength(attempt - 1);
    expect(report.githubSummary).toContain("### Clawgrit report published");
  },
  55_000,
);

posixIt.each([23, 124, 125, 143])(
  "ordinary cherry-pick and abort %s failures remain visible publish failure",
  async (code) => {
    const report = await performanceRun("publish", {
      pushResults: [23],
      gitFaults: [
        { match: "^cherry-pick -X ", code: 23 },
        { match: "^cherry-pick --abort$", code },
      ],
    });
    expect(report.code, report.output).toBe(1);
    expect(report.commands.at(-1)?.args).toEqual(["cherry-pick", "--abort"]);
    expect(report.pushes).toHaveLength(1);
    expect(report.output).toContain(
      "::error::Unable to replay the clawgrit report after a concurrent publish.",
    );
    expect(report.githubSummary).toBe("");
  },
  55_000,
);

posixIt.each(["owner", "python", "git"] as const)(
  "prepare setup failure %s cannot publish readiness",
  async (setupFailure) => {
    const report = await performanceRun("prepare", { setupFailure });
    expect(report.code, report.output).not.toBe(0);
    expect(report.pushes).toHaveLength(0);
    expect(report.githubOutput).not.toContain("ready=true");
  },
  55_000,
);

posixIt.each([124, 125, 143, "hang"] as const)(
  "reconciliation fetch %s warns once and retries without replay",
  async (code) => {
    const report = await performanceRun("publish", { pushResults: [23], fetchResults: [code] });
    expect(report.code, report.output).toBe(0);
    expect(report.pushes).toHaveLength(2);
    expect(report.fetches).toHaveLength(1);
    expect(report.checkouts).toHaveLength(0);
    expect(report.output.match(/::warning::Unable to refresh/gu)).toHaveLength(1);
  },
  55_000,
);

posixIt.each([124, 125, 143, 128])(
  "remote duplicate read %s is terminal, never absence",
  async (code) => {
    const report = await performanceRun("publish", {
      pushResults: [23],
      gitFault: { match: "^ls-tree ", code },
    });
    expect(report.code, report.output).toBe(code);
    expect(report.commands.at(-1)?.args[0]).toBe("ls-tree");
    expect(report.githubSummary).toBe("");
    expect(report.checkouts).toHaveLength(0);
  },
  55_000,
);

posixIt.each(["prepare", "publish"] as const)(
  "%s cancellation during real TERM-resistant cleanup prevents continuation",
  async (mode) => {
    const report = await performanceRun(mode, {
      cancelDuringCleanup: true,
      cleanupCancelMatch: mode === "prepare" ? "^fetch " : "^push ",
      ...(mode === "prepare" ? { fetchResults: ["hang"] } : { pushResults: ["hang"] }),
    });
    expect(report.cancelledDuringCleanup).toBe(true);
    expect(report.code, report.output).toBe(143);
    expect(report.commands.at(-1)?.args[0]).toBe(mode === "prepare" ? "fetch" : "push");
    expect(report.githubOutput).not.toContain("ready=true");
    expect(report.githubSummary).toBe("");
    expect(report.output).not.toContain("fixture backoff:");
  },
  55_000,
);

posixIt(
  "cancellation during owned backoff prevents reconciliation fetch",
  async () => {
    const report = await performanceRun("publish", {
      pushResults: [23],
      realClock: true,
      cooperativeTrees: true,
      cancelDuringBackoff: true,
    });
    expect(report.code, report.output).toBe(143);
    expect(report.pushes).toHaveLength(1);
    expect(report.fetches).toHaveLength(0);
    expect(report.githubSummary).toBe("");
    expect(report.boundaries.some(({ name }) => name === "backoff-cancel")).toBe(true);
  },
  55_000,
);
