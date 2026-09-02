import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { runCiGitStep, type FetchResult } from "./ci-git-owner.test-support.js";

// Each case owns its checkout and process trees. Overlap their real timeout and
// drain waits, but keep subprocess pressure bounded on the four-core CI runner.
beforeAll(() => {
  vi.setConfig({ maxConcurrency: 2 });
  return () => vi.resetConfig();
});

const linuxIt = it.skipIf(process.platform !== "linux").concurrent;
const releasePolicyIt = it.skipIf(process.platform === "win32");
const base = "c".repeat(40);
const head = "a".repeat(40);
const policyImport =
  "from ci_git_owner import run_git, git_output, GitFailure, FetchTimeout\nimport os, subprocess\n";
const gitOwnerPath = join(process.cwd(), ".github/actions/git-owner/owner.py");
const releaseAncestryPolicyPath = join(
  process.cwd(),
  ".github/actions/git-owner/release-ancestry.py",
);
const releaseAncestryPolicy = readFileSync(releaseAncestryPolicyPath, "utf8");
const fastReleaseAncestryPolicy = releaseAncestryPolicy.replace(
  "max_fetch_seconds = 30",
  "max_fetch_seconds = 2",
);
const expiredReleaseAncestryPolicy = releaseAncestryPolicy.replace(
  "max_total_seconds = 120",
  "max_total_seconds = 0",
);

type AncestryFixture = {
  origin: string;
  root: string;
  source: string;
  target: string;
};

function fixtureGit(cwd: string, args: string[], input?: string) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
    },
    input,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function fixtureCommit(origin: string, tree: string, parent: string | undefined, label: string) {
  return fixtureGit(
    process.cwd(),
    [`--git-dir=${origin}`, "commit-tree", tree, ...(parent ? ["-p", parent] : [])],
    `${label}\n`,
  );
}

function createAncestryFixture(options: {
  sourceDistance: number;
  targetDistance: number;
  related: boolean;
}): AncestryFixture {
  const root = mkdtempSync(join(tmpdir(), "openclaw-release-ancestry-"));
  const origin = join(root, "origin.git");
  fixtureGit(root, ["init", "--quiet", "--bare", origin]);
  const tree = fixtureGit(root, [`--git-dir=${origin}`, "mktree"], "");
  const sourceRoot = fixtureCommit(origin, tree, undefined, "source root");
  const targetRoot = options.related
    ? sourceRoot
    : fixtureCommit(origin, tree, undefined, "target root");
  let source = sourceRoot;
  for (let index = 0; index < options.sourceDistance; index++) {
    source = fixtureCommit(origin, tree, source, `source ${String(index)}`);
  }
  let target = targetRoot;
  for (let index = 0; index < options.targetDistance; index++) {
    target = fixtureCommit(origin, tree, target, `target ${String(index)}`);
  }
  fixtureGit(root, [`--git-dir=${origin}`, "update-ref", "refs/heads/release-source", source]);
  fixtureGit(root, [`--git-dir=${origin}`, "update-ref", "refs/heads/main", target]);
  return { origin, root, source, target };
}

function createProvisionalMergeBaseFixture(): AncestryFixture & { base: string } {
  const root = mkdtempSync(join(tmpdir(), "openclaw-release-ancestry-provisional-"));
  const origin = join(root, "origin.git");
  fixtureGit(root, ["init", "--quiet", "--bare", origin]);
  const commits = Array.from({ length: 341 }, (_, index) => {
    const mark = index + 1;
    const parent = mark > 1 ? `from :${String(mark - 1)}\n` : "";
    return `commit refs/heads/main
mark :${String(mark)}
committer fixture <fixture@example.invalid> ${String(mark)} +0000
data 1
x
${parent}
`;
  });
  commits.push(`commit refs/heads/main
mark :342
committer fixture <fixture@example.invalid> 342 +0000
data 1
x
from :341
merge :1

`);
  for (let mark = 343; mark <= 562; mark += 1) {
    const parent = mark === 343 ? 121 : mark - 1;
    commits.push(`commit refs/heads/release-source
mark :${String(mark)}
committer fixture <fixture@example.invalid> ${String(mark)} +0000
data 1
x
from :${String(parent)}

`);
  }
  commits.push(`commit refs/heads/release-source
mark :563
committer fixture <fixture@example.invalid> 563 +0000
data 1
x
from :562
merge :1

`);
  fixtureGit(origin, ["fast-import", "--quiet"], commits.join(""));
  fixtureGit(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return {
    base: fixtureGit(origin, ["rev-parse", "refs/heads/main~221"]),
    origin,
    root,
    source: fixtureGit(origin, ["rev-parse", "refs/heads/release-source"]),
    target: fixtureGit(origin, ["rev-parse", "refs/heads/main"]),
  };
}

function cloneAncestrySource(fixture: AncestryFixture, name: string) {
  const checkout = join(fixture.root, name);
  fixtureGit(fixture.root, [
    "clone",
    "--quiet",
    "--depth=1",
    "--branch",
    "release-source",
    pathToFileURL(fixture.origin).href,
    checkout,
  ]);
  return checkout;
}

function writeGitProxy(
  fixture: AncestryFixture,
  name: string,
  body: string,
): { binDir: string; realGit: string } {
  const binDir = join(fixture.root, name);
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  mkdirSync(binDir);
  writeFileSync(
    join(binDir, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
${body}
`,
  );
  chmodSync(join(binDir, "git"), 0o755);
  return { binDir, realGit };
}

function runReleaseAncestry(
  checkout: string,
  mode: "ancestor" | "merge-base",
  env: Record<string, string> = {},
) {
  return spawnSync("python3", ["-I", "-S", gitOwnerPath, "--policy", releaseAncestryPolicyPath], {
    cwd: checkout,
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_ANCESTRY_MODE: mode,
      RELEASE_ANCESTRY_TARGET_REF: "refs/heads/main",
      ...env,
    },
  });
}

function expectPolicySuccess(result: ReturnType<typeof runReleaseAncestry>, mode: string) {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain(`Established release ${mode} relationship`);
}

releasePolicyIt("hydrates a divergent release merge base beyond the legacy 50+50 ceiling", () => {
  const fixture = createAncestryFixture({
    sourceDistance: 8,
    targetDistance: 950,
    related: true,
  });
  try {
    const legacy = cloneAncestrySource(fixture, "legacy");
    const legacyTarget = "refs/remotes/origin/legacy-target";
    const refs = [fixture.source, `+refs/heads/main:${legacyTarget}`];
    fixtureGit(legacy, [
      "fetch",
      "--no-tags",
      "--filter=blob:none",
      "--depth=50",
      "origin",
      ...refs,
    ]);
    fixtureGit(legacy, [
      "fetch",
      "--no-tags",
      "--filter=blob:none",
      "--deepen=50",
      "origin",
      ...refs,
    ]);
    const legacyResult = spawnSync("git", ["merge-base", fixture.source, legacyTarget], {
      cwd: legacy,
      encoding: "utf8",
    });
    expect(legacyResult.status).toBe(1);
    expect(fixtureGit(legacy, ["rev-parse", "--is-shallow-repository"])).toBe("true");

    const checkout = cloneAncestrySource(fixture, "progressive");
    expectPolicySuccess(runReleaseAncestry(checkout, "merge-base"), "merge-base");
    expect(fixtureGit(checkout, ["rev-parse", "refs/remotes/origin/main"])).toBe(fixture.target);
    expect(fixtureGit(checkout, ["merge-base", fixture.source, "origin/main"])).not.toBe("");
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

releasePolicyIt("deepens past a provisional shallow merge base", () => {
  const fixture = createProvisionalMergeBaseFixture();
  try {
    const checkout = cloneAncestrySource(fixture, "checkout");
    expectPolicySuccess(runReleaseAncestry(checkout, "merge-base"), "merge-base");
    expect(fixtureGit(checkout, ["merge-base", fixture.source, "refs/remotes/origin/main"])).toBe(
      fixture.base,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

releasePolicyIt("accepts a newly proven relation when deepening only moves a boundary", () => {
  const fixture = createAncestryFixture({
    sourceDistance: 64,
    targetDistance: 8,
    related: true,
  });
  try {
    const checkout = cloneAncestrySource(fixture, "checkout");
    expectPolicySuccess(runReleaseAncestry(checkout, "merge-base"), "merge-base");
    expect(fixtureGit(checkout, ["merge-base", fixture.source, fixture.target])).not.toBe("");
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

releasePolicyIt("hydrates a Tideclaw target more than 180 commits beyond its source", () => {
  const fixture = createAncestryFixture({
    sourceDistance: 0,
    targetDistance: 181,
    related: true,
  });
  try {
    const checkout = cloneAncestrySource(fixture, "checkout");
    expectPolicySuccess(runReleaseAncestry(checkout, "ancestor"), "ancestor");
    fixtureGit(checkout, ["merge-base", "--is-ancestor", fixture.source, fixture.target]);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

releasePolicyIt("freezes the target SHA after the initial release ancestry fetch", () => {
  const fixture = createAncestryFixture({
    sourceDistance: 8,
    targetDistance: 220,
    related: true,
  });
  const moved = fixtureCommit(
    fixture.origin,
    fixtureGit(fixture.root, [`--git-dir=${fixture.origin}`, "mktree"], ""),
    fixture.target,
    "moved target",
  );
  const marker = join(fixture.root, "target-moved");
  const proxy = writeGitProxy(
    fixture,
    "moving-git",
    `"$REAL_GIT" "$@"
status=$?
if [[ "$status" == 0 && " $* " == *" --depth=64 "* && ! -e "$MOVE_MARKER" ]]; then
  "$REAL_GIT" --git-dir="$ORIGIN" update-ref refs/heads/main "$MOVED_TARGET"
  : > "$MOVE_MARKER"
fi
exit "$status"`,
  );
  try {
    const checkout = cloneAncestrySource(fixture, "checkout");
    expectPolicySuccess(
      runReleaseAncestry(checkout, "merge-base", {
        MOVE_MARKER: marker,
        MOVED_TARGET: moved,
        ORIGIN: fixture.origin,
        PATH: `${proxy.binDir}:${process.env.PATH ?? ""}`,
        REAL_GIT: proxy.realGit,
      }),
      "merge-base",
    );
    expect(fixtureGit(fixture.root, [`--git-dir=${fixture.origin}`, "rev-parse", "main"])).toBe(
      moved,
    );
    expect(fixtureGit(checkout, ["rev-parse", "refs/remotes/origin/main"])).toBe(fixture.target);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

releasePolicyIt("rejects fully hydrated disconnected release histories", () => {
  const fixture = createAncestryFixture({
    sourceDistance: 8,
    targetDistance: 12,
    related: false,
  });
  try {
    const checkout = cloneAncestrySource(fixture, "checkout");
    const result = runReleaseAncestry(checkout, "merge-base");
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stdout).toContain("is invalid after complete history");
    expect(fixtureGit(checkout, ["rev-parse", "--is-shallow-repository"])).toBe("false");
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

releasePolicyIt("rejects a successful release history deepen that makes no progress", () => {
  const fixture = createAncestryFixture({
    sourceDistance: 8,
    targetDistance: 220,
    related: true,
  });
  const proxy = writeGitProxy(
    fixture,
    "no-progress-git",
    `if [[ " $* " == *" fetch "* && " $* " == *" --deepen=128 "* ]]; then
  exit 0
fi
exec "$REAL_GIT" "$@"`,
  );
  try {
    const checkout = cloneAncestrySource(fixture, "checkout");
    const result = runReleaseAncestry(checkout, "merge-base", {
      PATH: `${proxy.binDir}:${process.env.PATH ?? ""}`,
      REAL_GIT: proxy.realGit,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(125);
    expect(result.stdout).toContain("completed without ancestry progress");
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

releasePolicyIt.each([
  { label: "timeout", failure: "hang" },
  { label: "Git failure", failure: 23 },
] as const)(
  "retries a drained release ancestry fetch after $label",
  async ({ failure }) => {
    const report = await runCiGitStep({
      policy: failure === "hang" ? fastReleaseAncestryPolicy : releaseAncestryPolicy,
      env: {
        RELEASE_ANCESTRY_MODE: "merge-base",
        RELEASE_ANCESTRY_TARGET_REF: "refs/heads/main",
      },
      fetchResults: [failure, 0],
      commandResults: {
        "rev-parse --verify HEAD^{commit}": { code: 0, output: `${head}\n` },
        "rev-parse --verify refs/remotes/origin/main^{commit}": {
          code: 0,
          output: `${base}\n`,
        },
        "rev-parse --is-shallow-repository": { code: 0, output: "false\n" },
        [`merge-base ${head} ${base}`]: { code: 0, output: `${base}\n` },
      },
    });
    expect(report.code, report.output).toBe(0);
    expect(report.fetches).toHaveLength(2);
    expect(report.output).toContain("fetch failed on attempt 1; retrying");
  },
  55_000,
);

releasePolicyIt(
  "preserves the final release ancestry Git failure after bounded retries",
  async () => {
    const report = await runCiGitStep({
      policy: releaseAncestryPolicy,
      env: {
        RELEASE_ANCESTRY_MODE: "merge-base",
        RELEASE_ANCESTRY_TARGET_REF: "refs/heads/main",
      },
      fetchResults: [23, 23, 23],
      commandResults: {
        "rev-parse --verify HEAD^{commit}": { code: 0, output: `${head}\n` },
      },
    });
    expect(report.code, report.output).toBe(23);
    expect(report.fetches).toHaveLength(3);
  },
);

releasePolicyIt("returns 124 when the release ancestry total budget is exhausted", async () => {
  const report = await runCiGitStep({
    policy: expiredReleaseAncestryPolicy,
    env: {
      RELEASE_ANCESTRY_MODE: "merge-base",
      RELEASE_ANCESTRY_TARGET_REF: "refs/heads/main",
    },
    fetchResults: [],
  });
  expect(report.code, report.output).toBe(124);
  expect(report.commands).toEqual([]);
});

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

it("binds read-only checkout authentication only to the workflow repository", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
    permissions: Record<string, string>;
    jobs: Record<
      string,
      { permissions?: Record<string, string>; steps?: { env?: Record<string, string> }[] }
    >;
  };
  let ownedCheckouts = 0;
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (!step.env?.CHECKOUT_REPO) {
        continue;
      }
      ownedCheckouts++;
      const sameRepository = step.env.CHECKOUT_REPO === "${{ github.repository }}";
      expect(step.env.CHECKOUT_TOKEN).toBe(sameRepository ? "${{ github.token }}" : undefined);
      if (sameRepository) {
        expect((job.permissions ?? workflow.permissions).contents).toBe("read");
      }
    }
  }
  expect(ownedCheckouts).toBeGreaterThan(0);
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

linuxIt.each([0, 23, "cleanup-failure"] as const)(
  "generic Git output drains its writers before consumption (%s)",
  async (code) => {
    const output = `${head}\trefs/heads/main\n`;
    const report = await runCiGitStep({
      policy:
        policyImport +
        'import sys\nsys.stdout.write(git_output(os.getcwd(), "ls-remote", "origin", "refs/heads/main"))\n',
      fetchResults: [],
      lsRemoteResults: [{ code, output }],
    });
    expect(report.code, report.output).toBe(code === "cleanup-failure" ? 125 : code);
    expect(report.commands.map(({ args }) => args)).toEqual([
      ["ls-remote", "origin", "refs/heads/main"],
    ]);
    expect(report.readyAttempts).toEqual([1]);
    if (code === 0) {
      expect(report.output).toBe(output);
    } else {
      expect(report.output).not.toContain(output);
    }
  },
  55_000,
);

const posixIt = it.skipIf(process.platform === "win32").concurrent;
const auditFiles = [".pre-commit-config.yaml", ".github/zizmor.yml"];
const branch = "refs/remotes/origin/main";
const auditObjects = Object.fromEntries(
  [base, branch].flatMap((ref) =>
    auditFiles.map((file) => [
      `${ref}:${file}`,
      {
        text: `# ${ref}\n${file === auditFiles[0] ? "config: .github/zizmor.yml" : "rules: {}"}\n`,
      },
    ]),
  ),
);
function requireAuditObject(ref: string, file: string) {
  const object = auditObjects[`${ref}:${file}`];
  if (!object) {
    throw new Error(`Missing audit fixture object: ${ref}:${file}`);
  }
  return object;
}
const sanity = (options: Omit<Parameters<typeof runCiGitStep>[0], "workflow">) =>
  runCiGitStep({
    ...options,
    workflow: "workflow-sanity",
    objects: { ...auditObjects, ...options.objects },
  });

// These execute the actual YAML body. Every fake transport leaves ready writers
// behind its leader, so fallback and config consumption must wait for the owner.
posixIt(
  "workflow sanity drains ordinary exact failure before branch fallback and config consumption",
  async () => {
    const report = await sanity({
      fetchResults: [23, 0],
      realClock: true,
      realDrain: false,
    });
    expect(report.code, report.output).toBe(0);
    expect(report.readyAttempts).toEqual([1, 2]);
    expect(report.fetches.map(({ args }) => args.at(-1))).toEqual([
      `+${base}:refs/remotes/origin/security-base`,
      `+refs/heads/main:${branch}`,
    ]);
    expect(report.githubEnv).toBe(
      `PRE_COMMIT_CONFIG_PATH=${report.runnerTemp}/pre-commit-base.yaml\n`,
    );
  },
  55_000,
);

type SanityFetchCase = {
  label: string;
  fetchResults: FetchResult[];
  baseAvailableAfter?: number;
  refs: string[];
  warnings: number;
  code: number;
};
const sanityFetchCases: SanityFetchCase[] = [
  {
    label: "already present",
    fetchResults: [],
    baseAvailableAfter: 0,
    refs: [],
    warnings: 0,
    code: 0,
  },
  { label: "exact success", fetchResults: [0], refs: [base], warnings: 0, code: 0 },
  ...[2, 23, 125, 143].map((code) => ({
    label: `ordinary ${code}`,
    fetchResults: [code, 0],
    refs: [base, "refs/heads/main"],
    warnings: 0,
    code: 0,
  })),
  ...[124, 137].flatMap((code) => [
    {
      label: `ordinary ${code} retry`,
      fetchResults: [code, 0],
      refs: [base, base],
      warnings: 1,
      code: 0,
    },
    {
      label: `ordinary ${code} exhaustion`,
      fetchResults: Array(6).fill(code),
      refs: [...Array(3).fill(base), ...Array(3).fill("refs/heads/main")],
      warnings: 4,
      code,
    },
  ]),
  {
    label: "FetchTimeout exhaustion then branch",
    fetchResults: ["hang", "hang", "hang", 0],
    refs: [base, base, base, "refs/heads/main"],
    warnings: 2,
    code: 0,
  },
  {
    label: "FetchTimeout both refs exhausted",
    fetchResults: Array(6).fill("hang"),
    refs: [...Array(3).fill(base), ...Array(3).fill("refs/heads/main")],
    warnings: 4,
    code: 124,
  },
];

posixIt.each(sanityFetchCases)(
  "workflow sanity preserves fetch policy: $label",
  async ({ fetchResults, baseAvailableAfter, refs, warnings, code }) => {
    const report = await sanity({ fetchResults, baseAvailableAfter });
    expect(report.code, report.output).toBe(code);
    expect(report.fetches.map(({ args }) => args)).toEqual(
      refs.map((ref) => [
        "fetch",
        "--no-tags",
        "--depth=1",
        "origin",
        `+${ref}:${ref === base ? "refs/remotes/origin/security-base" : branch}`,
      ]),
    );
    expect(
      report.fetches.every(
        ({ configuration, cwd }) => configuration?.length === 0 && cwd === report.workspace,
      ),
    ).toBe(true);
    expect(report.output.match(/timed out on attempt [12]; retrying/gu) ?? []).toHaveLength(
      warnings,
    );
    expect(
      report.commands.filter(({ args }) => args[0] === "cat-file").map(({ args }) => args),
    ).toEqual([
      ["cat-file", "-e", `${base}^{commit}`],
      ...(code === 0 ? auditFiles.map((file) => ["cat-file", "-e", `${base}:${file}`]) : []),
    ]);
    expect(report.githubEnv).toBe(
      code === 0 ? `PRE_COMMIT_CONFIG_PATH=${report.runnerTemp}/pre-commit-base.yaml\n` : "",
    );
    if (code === 0) {
      expect(report.trustedConfig).toBe(
        `# ${base}\nconfig: ${report.runnerTemp}/zizmor-base.yml\n`,
      );
      expect(report.trustedZizmor).toBe(`# ${base}\nrules: {}\n`);
    } else {
      expect(report.trustedConfig).toBe("");
      expect(report.trustedZizmor).toBe("");
    }
  },
  55_000,
);

posixIt.each([
  { label: "real 30-second fetch timeout", fetchResults: ["hang", 0], warnings: 1 },
  { label: "real five-second backoff", fetchResults: [137, 0], warnings: 1 },
] as const)(
  "workflow sanity retains $label",
  async ({ fetchResults, warnings }) => {
    const started = performance.now();
    const report = await sanity({
      fetchResults: [...fetchResults],
      realClock: true,
      cooperativeTrees: true,
    });
    expect(report.code, report.output).toBe(0);
    expect(report.fetches).toHaveLength(2);
    expect(report.output.match(/; retrying/gu) ?? []).toHaveLength(warnings);
    expect(performance.now() - started).toBeGreaterThanOrEqual(
      fetchResults[0] === "hang" ? 35_000 : 5_000,
    );
  },
  55_000,
);

posixIt.each([
  { label: "owner inspection failure", fetchResults: ["cleanup-failure"], code: 125 },
  { label: "fetch cancellation", fetchResults: ["hang"], scenario: "cancel-SIGTERM", code: 143 },
  {
    label: "timeout drain cancellation",
    fetchResults: ["hang"],
    cancelDuringCleanup: true,
    code: 143,
  },
  {
    label: "backoff cancellation",
    fetchResults: [124],
    cancelDuringBackoff: true,
    realClock: true,
    cooperativeTrees: true,
    code: 143,
  },
  { label: "missing owner", fetchResults: [], setupFailure: "owner", code: 2 },
  {
    label: "missing Python interpreter",
    fetchResults: [],
    setupFailure: "python",
    code: "launcher",
  },
  { label: "Git spawn failure", fetchResults: [], setupFailure: "git", code: 125 },
] satisfies (Partial<Parameters<typeof runCiGitStep>[0]> & {
  label: string;
  code: number | "launcher";
  fetchResults: FetchResult[];
})[])(
  "workflow sanity never recovers or publishes after $label",
  async ({ label: _label, code, ...options }) => {
    const report = await sanity(options);
    if (code === "launcher") {
      // Bash versions differ for a found executable whose interpreter is missing.
      expect([126, 127], report.output).toContain(report.code);
    } else {
      expect(report.code, report.output).toBe(code);
    }
    expect(report.fetches).toHaveLength(options.fetchResults.length);
    expect(report.commands.filter(({ args }) => args[0] === "show")).toEqual([]);
    expect(report.githubEnv).toBe("");
    expect(report.trustedConfig).toBe("");
    expect(report.trustedZizmor).toBe("");
    expect(report.cancelledDuringCleanup).toBe(Boolean(options.cancelDuringCleanup));
    expect(report.boundaries.some(({ name }) => name === "backoff-cancel")).toBe(
      Boolean(options.cancelDuringBackoff),
    );
  },
  55_000,
);

posixIt.each([[], [0], [1], [0, 1]].map((missing) => ({ missing })))(
  "workflow sanity selects missing exact configs independently ($missing)",
  async ({ missing }) => {
    const report = await sanity({
      fetchResults: [],
      baseAvailableAfter: 0,
      objects: Object.fromEntries(
        missing.map((index) => {
          const file = auditFiles[index];
          if (!file) {
            throw new Error(`Missing audit fixture file at index ${index}`);
          }
          return [
            `${base}:${file}`,
            { ...requireAuditObject(base, file), probe: index === 0 ? 125 : 143 },
          ];
        }),
      ),
    });
    expect(report.code, report.output).toBe(0);
    expect(report.fetches).toEqual([]);
    expect(
      report.commands.filter(({ args }) => args[0] === "show").map(({ args }) => args),
    ).toEqual(
      auditFiles.map((file, index) => [
        "show",
        `${missing.includes(index) ? branch : base}:${file}`,
      ]),
    );
    for (const index of missing) {
      expect(report.output).toContain(
        `Base SHA ${base} does not expose ${auditFiles[index]}; using origin/main instead.`,
      );
    }
    expect(report.githubEnv).toBe(
      `PRE_COMMIT_CONFIG_PATH=${report.runnerTemp}/pre-commit-base.yaml\n`,
    );
  },
  55_000,
);

posixIt.each(
  auditFiles.flatMap((file) => [
    { file, fallback: false },
    { file, fallback: true },
  ]),
)(
  "workflow sanity rejects partial $file show (fallback=$fallback)",
  async ({ file, fallback }) => {
    const report = await sanity({
      fetchResults: [],
      baseAvailableAfter: 0,
      objects: {
        [`${base}:${file}`]: { text: "partial\n", probe: fallback ? 1 : 0, code: 23 },
        [`${branch}:${file}`]: { text: "partial\n", code: 23 },
      },
    });
    expect(report.code, report.output).toBe(fallback ? 1 : 23);
    expect(report.fetches).toEqual([]);
    expect(report.githubEnv).toBe("");
    expect(file === auditFiles[0] ? report.trustedConfig : report.trustedZizmor).toBe("");
    const shows = report.commands
      .filter(({ args }) => args[0] === "show")
      .map(({ args }) => args.at(-1));
    expect(shows.at(-1)).toBe(`${fallback ? branch : base}:${file}`);
    expect(shows).not.toContain(`${fallback ? base : branch}:${file}`);
    if (fallback) {
      expect(report.output).toContain(`Could not read ${file} from ${base} or origin/main.`);
    }
  },
  55_000,
);

posixIt("workflow sanity rejects a config without the Zizmor reference", async () => {
  const report = await sanity({
    fetchResults: [],
    baseAvailableAfter: 0,
    objects: { [`${base}:${auditFiles[0]}`]: { text: "repos: []\n" } },
    poisonPython: true,
  });
  expect(report.code, report.output).toBe(1);
  expect(report.output).toContain(
    "trusted pre-commit config does not reference .github/zizmor.yml",
  );
  expect(report.githubEnv).toBe("");
});

const maturityValidation = {
  file: ".github/workflows/maturity-scorecard.yml",
  job: "validate_selected_ref",
  step: "Validate selected ref",
};
const maturityEnvironment = {
  EXPECTED_SHA: head,
  INPUT_REF: "main",
  EVIDENCE_RUN_ID: "123",
  PUBLISH_PULL_REQUEST: "true",
};

posixIt(
  "generated publisher drains real Git descendants before every continuation",
  async () => {
    const report = await runCiGitStep({
      action: "publish-generated-pr",
      step: "Publish generated pull request",
      fetchResults: [],
      publisher: {},
    });
    expect(report.code, report.output).toBe(0);
    expect(report.pushes).toHaveLength(1);
    expect(report.githubSummary).toContain("Generated pull request:");
    expect(report.commands.at(-1)?.args).toEqual([
      "config",
      "--local",
      "--unset-all",
      "http.https://github.com/.extraheader",
    ]);
  },
  55_000,
);

posixIt(
  "maturity validation drains before trust probes and publication",
  async () => {
    const report = await runCiGitStep({
      workflow: maturityValidation,
      env: maturityEnvironment,
      fetchResults: [0],
      mergeBase: { ancestor: true, revision: head },
      lsRemoteResults: [{ code: 0, output: `${head}\trefs/heads/main\n` }],
      commandResults: {
        [`diff --quiet ${head} refs/remotes/origin/main -- . :(exclude)qa/maturity-scores.yaml :(exclude)docs/maturity/scorecard.md :(exclude)docs/maturity/taxonomy.md`]:
          { code: 0 },
      },
    });
    expect(report.code, report.output).toBe(0);
    expect(report.githubOutput).toContain("trusted_reason=main-ancestor\n");
    expect(report.fetches).toHaveLength(2);
  },
  55_000,
);

function publisherRun(options: Partial<Parameters<typeof runCiGitStep>[0]> = {}) {
  return runCiGitStep({
    action: "publish-generated-pr",
    step: "Publish generated pull request",
    fetchResults: [],
    publisher: {},
    ...options,
  });
}
function maturityRun(options: Partial<Parameters<typeof runCiGitStep>[0]> = {}) {
  return runCiGitStep({
    workflow: maturityValidation,
    env: maturityEnvironment,
    fetchResults: [],
    mergeBase: { ancestor: true, revision: head },
    ...options,
  });
}

// Actual-body fault injection covers the former conditional-errexit hole and
// lifecycle/status collisions; the existing real-repository cases own tree semantics.
posixIt.each(
  ["fetch", "ls-remote", "push", "ls-tree"].flatMap((operation) =>
    (["cleanup-failure", "cancel"] as const).map((code) => ({ operation, code })),
  ),
)(
  "generated publisher $code at $operation is terminal before any continuation",
  async ({ operation, code }) => {
    const report = await publisherRun({ gitFault: { match: `^${operation} `, code } });
    expect(report.code, report.output).toBe(code === "cancel" ? 143 : 125);
    expect(report.commands.at(-1)?.args[0]).toBe(operation);
    expect(report.githubSummary).toBe("");
    expect(report.authHeaderPresent).toBe(true);
    expect(report.pushLog).toBe("");
    expect(report.output).not.toMatch(
      /refusing a doomed retry|moved concurrently|merged|Deferred|Generated pull request:/u,
    );
  },
  55_000,
);

posixIt.each([124, 125, 143])(
  "generated publisher ordinary push %s drains before semantic failure reporting",
  async (code) => {
    const report = await publisherRun({
      gitFault: { match: "^push ", code, output: "GH013 repository rule violations\n" },
    });
    expect(report.code, report.output).toBe(code);
    expect(report.pushes).toHaveLength(1);
    expect(report.commands.filter(({ args }) => args[0] === "ls-remote")).toHaveLength(2);
    expect(report.output).toContain("refusing a doomed retry");
    expect(report.pushLog).toBe("GH013 repository rule violations\n");
    expect(report.authHeaderPresent).toBe(false);
    expect(report.githubSummary).toBe("");
  },
  55_000,
);

posixIt.each(["fetch", "ls-remote", "push"])(
  "generated publisher %s timeout has one attempt and no general retry",
  async (operation) => {
    const report = await publisherRun({ gitFault: { match: `^${operation} `, code: "hang" } });
    expect(report.code, report.output).toBe(124);
    expect(report.fetches).toHaveLength(1);
    expect(report.pushes).toHaveLength(operation === "push" ? 1 : 0);
    expect(report.githubSummary).toBe("");
    expect(report.authHeaderPresent).toBe(false);
  },
  55_000,
);

posixIt.each([
  { label: "overlap candidate diff", match: "^diff --name-only", occurrence: 2 },
  { label: "overlap tree read", match: "^ls-tree ", occurrence: 1 },
  { label: "invalidation diff", match: "^diff --quiet ", occurrence: 1 },
  { label: "ancestor probe", match: "^merge-base ", occurrence: 1 },
  { label: "merged-tree read", match: "^ls-tree ", occurrence: 5, merged: true },
  { label: "neutralization fetch", match: "^fetch ", occurrence: 1, noChange: true },
  {
    label: "neutralization tree read",
    match: "^ls-tree ",
    occurrence: 1,
    noChange: true,
    overlap: true,
  },
])(
  "generated publisher ordinary failure inside $label never becomes success",
  async ({ match, occurrence, merged, noChange, overlap }) => {
    const report = await publisherRun({
      publisher: {
        mergeGeneratedPush: merged,
        noGeneratedChange: noChange,
        baseChangePath: overlap ? "a" : null,
      },
      gitFault: { match, occurrence, code: 23 },
    });
    expect(report.code, report.output).toBe(23);
    expect(report.githubSummary).toBe("");
    expect(report.authHeaderPresent).toBe(false);
    expect(report.output).not.toMatch(
      /Generated output was merged|Deferred stale|Neutralized stale/u,
    );
  },
  55_000,
);

posixIt.each([0, 2, 23, 125, 143, "hang", "cleanup-failure", "cancel"] as const)(
  "maturity branch lookup %s preserves 0/2/ordinary/fatal policy after drain",
  async (code) => {
    const report = await maturityRun({
      env: { ...maturityEnvironment, INPUT_REF: "release/2026.8.1" },
      gitFault: { match: "^ls-remote ", code },
    });
    const success = code === 0 || code === 2;
    expect(report.code, report.output).toBe(
      success
        ? 0
        : code === "hang"
          ? 124
          : code === "cancel"
            ? 143
            : code === "cleanup-failure"
              ? 125
              : code,
    );
    expect(report.fetches).toHaveLength(success ? 2 : 1);
    if (success) {
      expect(report.githubOutput).toContain(
        `publication_base=${code === 0 ? "release/2026.8.1" : "main"}\n`,
      );
    } else {
      expect(report.githubOutput).toBe("");
      expect(report.githubSummary).toBe("");
      expect(report.commands.at(-1)?.args[0]).toBe("ls-remote");
      if (typeof code === "number" || code === "hang") {
        expect(report.output).toContain(`(status ${code === "hang" ? 124 : code})`);
      } else {
        expect(report.output).not.toContain("Unable to determine");
      }
    }
  },
  55_000,
);

posixIt.each(
  [
    { match: "^fetch ", occurrence: 1 },
    { match: "^fetch ", occurrence: 2 },
    { match: "^rev-parse refs/remotes", occurrence: 1 },
    { match: "^rev-parse refs/remotes", occurrence: 2 },
    { match: "^diff ", occurrence: 1 },
  ].flatMap((site) =>
    (["cleanup-failure", "cancel"] as const).map((code) => Object.assign({}, site, { code })),
  ),
)(
  "maturity $code at $match/$occurrence stops before fallback/output",
  async ({ match, occurrence, code }) => {
    const report = await maturityRun({
      env: { ...maturityEnvironment, EXPECTED_SHA: "" },
      gitFault: { match, occurrence, code },
    });
    expect(report.code, report.output).toBe(code === "cancel" ? 143 : 125);
    expect(report.commands.at(-1)?.args.join(" ")).toMatch(new RegExp(match));
    expect(report.githubOutput).toBe("");
    expect(report.githubSummary).toBe("");
  },
  55_000,
);

posixIt.each([
  { race: "delete", secondFailure: false, code: 0, pushes: 2, fetches: 2 },
  { race: "advance", secondFailure: false, code: 1, pushes: 1, fetches: 1 },
  { race: "recreate", secondFailure: false, code: 1, pushes: 2, fetches: 2 },
  { race: "delete", secondFailure: true, code: 1, pushes: 2, fetches: 2 },
] as const)(
  "generated publisher exact deletion-race lease policy ($race, second failure=$secondFailure)",
  async ({ race, secondFailure, code, pushes, fetches }) => {
    const report = await publisherRun({
      publisher: { existingPr: true, race, failGeneratedPush: secondFailure },
    });
    expect(report.code, report.output).toBe(code);
    expect(report.initialBranch).toMatch(/^[0-9a-f]{40}$/u);
    expect(report.pushes.map(({ args }) => args)).toEqual([
      [
        "push",
        `--force-with-lease=refs/heads/automation/locale:${report.initialBranch}`,
        "origin",
        "HEAD:refs/heads/automation/locale",
      ],
      ...(pushes === 2
        ? [
            [
              "push",
              "--force-with-lease=refs/heads/automation/locale:",
              "origin",
              "HEAD:refs/heads/automation/locale",
            ],
          ]
        : []),
    ]);
    expect(report.fetches).toHaveLength(fetches);
    expect(report.authHeaderPresent).toBe(false);
    expect(report.output).toContain("stale info");
    if (code === 0) {
      expect(report.publication?.generatedA).toBe("desired-a");
      expect(report.githubSummary).toContain("Generated pull request:");
    } else {
      expect(report.githubSummary).toBe("");
      expect(
        report.commands.filter(
          ({ tool, args }) => tool === "gh" && ["create", "edit", "merge"].includes(args[1] ?? ""),
        ),
      ).toEqual([]);
    }
  },
  55_000,
);

posixIt.each(
  [
    { match: "^fetch ", occurrence: 2 },
    { match: "^ls-tree ", occurrence: 5 },
  ].flatMap((site) =>
    ([23, "cleanup-failure", "cancel"] as const).map((code) => Object.assign({}, site, { code })),
  ),
)(
  "generated publisher verify_publication $code at $match is terminal",
  async ({ match, occurrence, code }) => {
    const report = await publisherRun({
      publisher: { reconciliation: "missing" },
      gitFault: { match, occurrence, code },
    });
    expect(report.code, report.output).toBe(
      code === "cancel" ? 143 : code === "cleanup-failure" ? 125 : code,
    );
    expect(report.githubSummary).toBe("");
    expect(report.authHeaderPresent).toBe(code !== 23);
    expect(report.commands.at(code === 23 ? -2 : -1)?.args.join(" ")).toMatch(new RegExp(match));
    expect(report.output).not.toContain("Generated output was merged");
  },
  55_000,
);

posixIt.each([0, 5, 125, "cleanup-failure", "cancel"] as const)(
  "generated publisher auth cleanup keeps ordinary tolerance but fences fatal %s",
  async (code) => {
    const report = await publisherRun({
      gitFault: { match: "^config --local --unset-all ", code },
    });
    expect(report.code, report.output).toBe(
      code === "cleanup-failure" ? 125 : code === "cancel" ? 143 : 0,
    );
    expect(report.commands.at(-1)?.args).toEqual([
      "config",
      "--local",
      "--unset-all",
      "http.https://github.com/.extraheader",
    ]);
    for (const text of [report.output, report.pushLog, JSON.stringify(report.commands)]) {
      expect(text).not.toContain("contents-token");
      expect(text).not.toContain(Buffer.from("x-access-token:contents-token").toString("base64"));
      expect(text).not.toContain("test-token");
    }
  },
  55_000,
);

posixIt(
  "generated publisher removes Git auth after an unexpected policy exception",
  async () => {
    const report = await publisherRun({
      publisher: { autoMerge: true, malformedAutoMergeRecord: true },
    });
    expect(report.code, report.output).toBe(125);
    expect(report.authHeaderPresent).toBe(false);
    expect(report.commands.at(-1)?.args).toEqual([
      "config",
      "--local",
      "--unset-all",
      "http.https://github.com/.extraheader",
    ]);
    expect(report.output).toContain("Git ownership/setup failed (IndexError)");
  },
  55_000,
);

posixIt.each(["main-ancestor", "release-tag", "release-branch-head", "floating-main"])(
  "maturity preserves exact trust order, output hash bytes and fetches: %s",
  async (reason) => {
    const release = "release/2026.8.1";
    const floating = reason === "floating-main";
    const tag = reason === "release-tag";
    const releaseBranch = reason === "release-branch-head";
    const revision = floating ? "d".repeat(40) : head;
    const publicationBase = releaseBranch ? release : "main";
    const report = await maturityRun({
      realClock: true,
      realDrain: false,
      env: {
        ...maturityEnvironment,
        EXPECTED_SHA: floating ? "" : head,
        PUBLISH_PULL_REQUEST: tag ? "false" : "true",
        INPUT_REF: tag ? "refs/tags/v2026.8.1" : releaseBranch ? release : "main",
      },
      revisions: { "refs/heads/main": revision, [`refs/heads/${release}`]: head },
      commandResults: {
        ...(tag || releaseBranch
          ? { [`merge-base --is-ancestor ${head} refs/remotes/origin/main`]: { code: 1 } }
          : {}),
        ...(tag ? { [`tag --points-at ${head}`]: { code: 0, output: "v2026.8.1\n" } } : {}),
      },
    });
    expect(report.code, report.output).toBe(0);
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256")
      .update(`123\n${publicationBase}\n${revision}\n`)
      .digest("hex")
      .slice(0, 16);
    expect(report.githubOutput).toBe(
      `publication_base=${publicationBase}\npublication_head=${tag ? "" : `automation/maturity-scorecard-123-${digest}`}\nselected_revision=${revision}\ntrusted_reason=${floating ? "main-ancestor" : reason}\n`,
    );
    expect(report.fetches.map(({ args }) => args)).toEqual([
      ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
      ...(releaseBranch
        ? [
            [
              "fetch",
              "--no-tags",
              "origin",
              `+refs/heads/${release}:refs/remotes/origin/${release}`,
            ],
          ]
        : []),
      ...(!tag
        ? [
            [
              "fetch",
              "--no-tags",
              "origin",
              `+refs/heads/${publicationBase}:refs/remotes/origin/${publicationBase}`,
            ],
          ]
        : []),
    ]);
    expect(report.commands.some(({ args }) => args[0] === "tag")).toBe(tag || releaseBranch);
    expect(report.commands.at(-1)?.args).toEqual(
      tag
        ? ["tag", "--points-at", head]
        : [
            "diff",
            "--quiet",
            revision,
            `refs/remotes/origin/${publicationBase}`,
            "--",
            ".",
            ":(exclude)qa/maturity-scores.yaml",
            ":(exclude)docs/maturity/scorecard.md",
            ":(exclude)docs/maturity/taxonomy.md",
          ],
    );
  },
  55_000,
);

posixIt.each(
  ["publisher", "maturity"].flatMap((surface) =>
    (["owner", "python", "git"] as const).map((setupFailure) => ({ surface, setupFailure })),
  ),
)(
  "$surface setup failure ($setupFailure) never reaches Git, GH, or outputs",
  async ({ surface, setupFailure }) => {
    const report = await (surface === "publisher" ? publisherRun : maturityRun)({ setupFailure });
    expect(report.code).not.toBe(0);
    expect(report.commands).toEqual([]);
    expect(report.githubOutput).toBe("");
    expect(report.githubSummary).toBe("");
  },
  55_000,
);

posixIt(
  "generated publisher reconciliation accepts a tree merged after PR mutation",
  async () => {
    const report = await publisherRun({ publisher: { reconciliation: "merged" } });
    expect(report.code, report.output).toBe(0);
    expect(report.fetches).toHaveLength(2);
    expect(report.pushes).toHaveLength(1);
    expect(report.githubSummary).toBe(
      "Generated output was merged while publication was being reconciled.\n",
    );
    expect(report.authHeaderPresent).toBe(false);
  },
  55_000,
);

posixIt.each([125, 143])(
  "generated publisher ordinary stale-lease %s permits the exact deletion rebuild",
  async (code) => {
    const report = await publisherRun({
      publisher: { existingPr: true, race: "delete" },
      gitFault: { match: "^push ", code, output: "stale info\n" },
    });
    expect(report.code, report.output).toBe(0);
    expect(report.fetches).toHaveLength(2);
    expect(report.pushes.map(({ args }) => args[1])).toEqual([
      `--force-with-lease=refs/heads/automation/locale:${report.initialBranch}`,
      "--force-with-lease=refs/heads/automation/locale:",
    ]);
    expect(report.publication?.generatedA).toBe("desired-a");
    expect(report.authHeaderPresent).toBe(false);
  },
  55_000,
);

posixIt.each([
  {
    label: "invalid expected SHA",
    env: { EXPECTED_SHA: "bad" },
    fetches: 0,
    diagnostic: "expected_sha must be a full",
  },
  {
    label: "mismatched expected SHA",
    env: { EXPECTED_SHA: "f".repeat(40) },
    fetches: 0,
    diagnostic: "expected fffff",
  },
  {
    label: "invalid evidence id",
    env: { EVIDENCE_RUN_ID: "1x" },
    fetches: 1,
    diagnostic: "must be a numeric",
  },
  {
    label: "publication ancestry",
    fault: { match: "^merge-base ", occurrence: 2, code: 1 },
    fetches: 2,
    diagnostic: "not an ancestor of pull request base",
  },
  {
    label: "changed publication inputs",
    fault: { match: "^diff ", code: 1 },
    fetches: 2,
    diagnostic: "changed maturity inputs",
  },
  {
    label: "failed publication diff",
    fault: { match: "^diff ", code: 23 },
    fetches: 2,
    diagnostic: "",
    code: 23,
  },
])(
  "maturity rejects $label without outputs",
  async ({ env, fault, fetches, diagnostic, code }) => {
    const report = await maturityRun({ env: { ...maturityEnvironment, ...env }, gitFault: fault });
    expect(report.code, report.output).toBe(code ?? 1);
    expect(report.fetches).toHaveLength(fetches);
    expect(report.githubOutput).toBe("");
    expect(report.githubSummary).toBe("");
    if (diagnostic) {
      expect(report.output).toContain(diagnostic);
    }
  },
  55_000,
);
