import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { runCiGitStep } from "./ci-git-owner.test-support.js";

const linuxIt = it.skipIf(process.platform !== "linux");
const base = "c".repeat(40);
const head = "a".repeat(40);
const policyImport =
  "from ci_git_owner import run_git, git_output, GitFailure, FetchTimeout\nimport os, subprocess\n";

// Protect the one-source distribution contract independently of the generator's formatter.
it("keeps exactly one byte-identical generated CI owner", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const source = readFileSync(".github/actions/git-owner/owner.py", "utf8");
  const bodies = [...workflow.matchAll(/run_owner <<'PYTHON'\n([\s\S]*?) {10}PYTHON\n/gu)];
  expect(bodies).toHaveLength(1);
  const body = bodies[0]?.[1]
    ?.split("\n")
    .slice(1)
    .map((line) => line.slice(10))
    .join("\n");
  expect(body).toBe(source);
});

it.each([false, true])("preserves linked Git metadata (reclaim locks=%s)", async (reclaimLocks) => {
  const invocation = reclaimLocks
    ? 'run_git(os.getcwd(), "fetch", "origin", "fixture", reclaim_locks=True)'
    : 'print(git_output(os.getcwd(), "rev-parse", "HEAD"), end="")';
  const report = await runCiGitStep({
    fetchResults: [],
    policy:
      policyImport +
      `from pathlib import Path
shared = Path.cwd().parent / "shared-git"
shared.mkdir()
lock = shared / "shallow.lock"
lock.write_text("not invocation-owned\\n")
metadata = Path(".git")
metadata.write_text("gitdir: ../shared-git\\n")
try:
    ${invocation}
finally:
    assert metadata.read_text() == "gitdir: ../shared-git\\n"
    assert lock.read_text() == "not invocation-owned\\n"
`,
  });
  expect(report.code, report.output).toBe(reclaimLocks ? 125 : 0);
  expect(report.commands.map(({ args }) => args)).toEqual(
    reclaimLocks ? [] : [["rev-parse", "HEAD"]],
  );
  if (!reclaimLocks) {
    expect(report.output).toBe(`${head}\n`);
  }
});

it("reclaims failed supplemental-fetch locks before the next attempt", async () => {
  const report = await runCiGitStep({
    job: "checks-fast-core",
    step: "Prepare release-gate ratchet merge tree",
    fetchResults: ["hang", 0],
    prepare: true,
  });
  expect(report.code, report.output).toBe(0);
  expect(report.fetches).toHaveLength(2);
  expect(report.readyAttempts).toEqual([1, 2]);
});

linuxIt(
  "bootstraps only action-owned bytes outside the candidate with isolated Python",
  async () => {
    const report = await runCiGitStep({
      action: "git-owner",
      fetchResults: [],
      poisonPython: true,
    });
    expect(report.code, report.output).toBe(0);
    expect(report.commands).toEqual([]);
    expect(report.githubEnv).toContain("CI_GIT_OWNER=");
  },
);

linuxIt(
  "drains a timed-out exact fetch before deepening for the base",
  async () => {
    const report = await runCiGitStep({
      action: "ensure-base-commit",
      baseAvailableAfter: 2,
      fetchResults: ["hang", 0],
    });
    expect(report.code, report.output).toBe(0);
    expect(report.fetches.map(({ args }) => args)).toEqual([
      ["fetch", "--no-tags", "--depth=1", "origin", base],
      ["fetch", "--no-tags", "--deepen=25", "origin", "--", "fixture-base"],
    ]);
  },
  55_000,
);

linuxIt.each([
  { label: "empty", sha: "", code: 0, commands: 0 },
  { label: "all-zero", sha: "00000", code: 0, commands: 0 },
  { label: "invalid SHA", sha: "--help", code: 2, commands: 0 },
  { label: "short SHA rejected", sha: "a".repeat(6), code: 2, commands: 0 },
  { label: "long SHA rejected", sha: "a".repeat(41), code: 2, commands: 0 },
  { label: "short uppercase SHA accepted", sha: "ABCDEF1", code: 0, commands: 2 },
  { label: "invalid ref", sha: base, invalidRef: true, code: 2, commands: 1 },
  { label: "already available", sha: base, code: 0, commands: 2 },
])(
  "base policy preserves $label validation and skip behavior",
  async ({ sha, code, commands, invalidRef }) => {
    const report = await runCiGitStep({
      action: "ensure-base-commit",
      env: { BASE_SHA: sha },
      invalidRef,
      baseAvailableAfter: 0,
      fetchResults: [],
    });
    expect(report.code, report.output).toBe(code);
    expect(report.commands).toHaveLength(commands);
    expect(report.fetches).toEqual([]);
  },
);

linuxIt.each([1, 2, 3, 4, 5, undefined])(
  "base policy preserves exact/deepen/plain-ref order (available after %s)",
  async (baseAvailableAfter) => {
    const report = await runCiGitStep({
      action: "ensure-base-commit",
      baseAvailableAfter,
      fetchResults: [0, 23, 0, 23, 0],
      poisonPython: true,
    });
    expect(report.code, report.output).toBe(baseAvailableAfter ? 0 : 1);
    const expected = [
      ["fetch", "--no-tags", "--depth=1", "origin", base],
      ...[25, 100, 300].map((depth) => [
        "fetch",
        "--no-tags",
        `--deepen=${depth}`,
        "origin",
        "--",
        "fixture-base",
      ]),
      ["fetch", "--no-tags", "origin", "--", "fixture-base"],
    ].slice(0, baseAvailableAfter ?? 5);
    expect(report.fetches.map(({ args }) => args)).toEqual(expected);
    expect(
      report.fetches.every(
        ({ configuration }) => configuration?.join(" ") === "protocol.version=2",
      ),
    ).toBe(true);
    expect(report.commands.filter(({ args }) => args[0] === "rev-parse")).toHaveLength(
      expected.length + 1,
    );
    if (!baseAvailableAfter) {
      expect(report.output).toContain("::error title=ensure-base-commit missing base::");
    }
  },
  55_000,
);

linuxIt.each([23, 125, 143, "hang"] as const)(
  "base remains available after safely drained ordinary outcome %s",
  async (failure) => {
    const report = await runCiGitStep({
      action: "ensure-base-commit",
      baseAvailableAfter: 1,
      fetchResults: [failure],
    });
    expect(report.code, report.output).toBe(0);
    expect(report.fetches).toHaveLength(1);
    expect(report.output).toContain("exact fetch failed");
    expect(report.output).toContain("Resolved base commit after exact fetch");
  },
  55_000,
);

linuxIt.each([
  { label: "inspection failure", result: "cleanup-failure", code: 125 },
  { label: "cancellation", result: "hang", scenario: "cancel-SIGTERM", code: 143 },
  {
    label: "cancellation during timeout drain",
    result: "hang",
    cancelDuringCleanup: true,
    code: 143,
  },
] as const)(
  "base policy stops before availability/retry on $label",
  async ({ result, code, ...entry }) => {
    const report = await runCiGitStep({
      action: "ensure-base-commit",
      baseAvailableAfter: 1,
      fetchResults: [result],
      realClock: true,
      realDrain: true,
      scenario: "scenario" in entry ? entry.scenario : undefined,
      cancelDuringCleanup: "cancelDuringCleanup" in entry,
    });
    expect(report.code, report.output).toBe(code);
    expect(report.fetches).toHaveLength(1);
    expect(report.commands.filter(({ args }) => args[0] === "rev-parse")).toHaveLength(1);
    expect(report.output).not.toContain("Resolved base commit");
    expect(report.cancelledDuringCleanup).toBe("cancelDuringCleanup" in entry);
  },
  55_000,
);

linuxIt(
  "keeps the base action's real 30-second timeout and drains before recovery",
  async () => {
    const report = await runCiGitStep({
      action: "ensure-base-commit",
      baseAvailableAfter: 1,
      fetchResults: ["hang"],
      realClock: true,
    });
    expect(report.code, report.output).toBe(0);
    expect(report.output).toContain("exact fetch failed");
    expect(report.readyAttempts).toEqual([1]);
  },
  55_000,
);

linuxIt(
  "fences later calls even if a trusted policy accidentally catches an ownership failure",
  async () => {
    const report = await runCiGitStep({
      fetchResults: ["cleanup-failure"],
      policy:
        policyImport +
        `try:
    run_git(os.getcwd(), "fetch", "origin", "fixture")
except Exception:
    try:
        run_git(os.getcwd(), "rev-parse", "HEAD")
    except RuntimeError:
        print("closed owner rejected reuse")
    else:
        raise AssertionError("closed owner spawned Git")
`,
    });
    expect(report.code, report.output).toBe(125);
    expect(report.commands).toHaveLength(1);
    expect(report.output).toContain("closed owner rejected reuse");
  },
);

linuxIt.each(
  [false, true].flatMap((inlinePolicy) =>
    ([125, "cleanup-failure"] as const).map((failure) => ({ inlinePolicy, failure })),
  ),
)(
  "preserves generic output and typed recovery (stdin=$inlinePolicy, outcome=$failure)",
  async ({ inlinePolicy, failure }) => {
    const output = " \tpath\0another path\r\n\n\n";
    const report = await runCiGitStep({
      fetchResults: [failure],
      inlinePolicy,
      revisions: { HEAD: output.slice(0, -1) },
      policy:
        policyImport +
        `import sys
assert "RUNNER_OS" not in os.environ
assert "GITHUB_WORKSPACE" not in os.environ
try:
    run_git(os.getcwd(), "fetch", "origin", "fixture", env={"CI_OWNER_PROBE": "child-only"})
except GitFailure as error:
    assert error.code == 125
assert "CI_OWNER_PROBE" not in os.environ
sys.stdout.write(git_output(os.getcwd(), "rev-parse", "HEAD", env={"CI_OWNER_PROBE": "output-only"}))
`,
      poisonPython: true,
    });
    if (failure === "cleanup-failure") {
      expect(report.code, report.output).toBe(125);
      expect(report.commands).toHaveLength(1);
      expect(report.output).toContain("Git ownership/setup failed");
      expect(report.output).not.toContain("path");
    } else {
      expect(report.code, report.output).toBe(0);
      expect(report.output).toBe(output);
      expect(report.commands).toHaveLength(2);
      expect(report.commands.map(({ envProbe }) => envProbe)).toEqual([
        "child-only",
        "output-only",
      ]);
    }
  },
  55_000,
);

const lookups: { step: string; env: Record<string, string>; output: string }[] = [
  {
    step: "Resolve exact diff base",
    env: { RELEASE_GATE: "false" },
    output: `sha=${base}\nhead_sha=${head}\n`,
  },
  {
    step: "Validate historical release target",
    env: { HISTORICAL_TARGET_TAG: "v2026.8.1", EXPECTED_SHA: head },
    output: "eligible=true\n",
  },
  {
    step: "Validate release candidate target",
    env: { RELEASE_CANDIDATE_REF: "release/2026.8.1", EXPECTED_SHA: head },
    output: "eligible=true\n",
  },
  {
    step: "Validate target context",
    env: { TARGET_CONTEXT_REF: "release/2026.8.1", TARGET_REF: head },
    output: "eligible=true\n",
  },
  {
    step: "Classify candidate cache trust",
    env: {
      CHECKOUT_REVISION: head,
      WORKFLOW_REVISION: head,
      RELEASE_CANDIDATE_TARGET: "false",
      TARGET_CONTEXT_TARGET: "false",
      TARGET_REF: "",
    },
    output: "trust=main\ncache_mode=restore\ncache_write_allowed=true\n",
  },
];

linuxIt.each(
  lookups.flatMap((lookup) =>
    ([0, 23, "cleanup-failure"] as const).map((code) => Object.assign({}, lookup, { code })),
  ),
)(
  "$step drains lookup output before consumption ($code)",
  async ({ step, env, output, code }) => {
    const report = await runCiGitStep({
      job: "preflight",
      step,
      env: { GITHUB_EVENT_NAME: "workflow_dispatch", ...env },
      prepare: true,
      fetchResults: [],
      lsRemoteResults: [{ code, output: `${head}\trefs/heads/main\n` }],
    });
    expect(report.code, report.output).toBe(code === "cleanup-failure" ? 125 : code);
    expect(report.githubOutput).toBe(code === 0 ? output : "");
    expect(report.commands.filter(({ args }) => args[0] === "ls-remote")).toHaveLength(1);
    if (code !== 0) {
      expect(report.commands.some(({ tool }) => tool === "gh")).toBe(false);
    }
  },
  55_000,
);

linuxIt.each([0, 23, "cleanup-failure"] as const)(
  "historical tag fallback follows only successful empty peeled lookup (%s)",
  async (code) => {
    const report = await runCiGitStep({
      job: "preflight",
      step: "Validate historical release target",
      env: { HISTORICAL_TARGET_TAG: "v2026.8.1", EXPECTED_SHA: head },
      prepare: true,
      fetchResults: [],
      lsRemoteResults: [
        { code, output: "" },
        { code: 0, output: `${head}\trefs/tags/v2026.8.1\n` },
      ],
    });
    expect(report.code, report.output).toBe(code === "cleanup-failure" ? 125 : code);
    expect(
      report.commands.filter(({ args }) => args[0] === "ls-remote").map(({ args }) => args.at(-1)),
    ).toEqual(
      code === 0 ? ["refs/tags/v2026.8.1^{}", "refs/tags/v2026.8.1"] : ["refs/tags/v2026.8.1^{}"],
    );
    expect(report.githubOutput).toBe(code === 0 ? "eligible=true\n" : "");
  },
  55_000,
);

it("preserves no per-operation deadline on all six CI remote lookups", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
    jobs: { preflight: { steps: { run?: string }[] } };
  };
  const calls = workflow.jobs.preflight.steps.flatMap(({ run }) =>
    Array.from((run ?? "").matchAll(/--git (\S+) ls-remote/gu)),
  );
  expect(calls.map((call) => call[1])).toEqual(Array(6).fill("0"));
});
