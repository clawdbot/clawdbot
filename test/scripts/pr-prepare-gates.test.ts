// Covers the scripts/pr prepare-gates remote testbox mode.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = process.cwd();

const tempDirs = createTempDirTracker();

function sanitizedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.OPENCLAW_PR_GATES_REMOTE;
  delete env.OPENCLAW_TESTBOX;
  return { ...env, ...overrides };
}

function runGatesBash(
  script: string,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    sourcePrepareCore?: boolean;
    sourcePush?: boolean;
  } = {},
) {
  return spawnSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        `script_parent_dir='${repoRoot}/scripts'`,
        `source '${repoRoot}/scripts/pr-lib/common.sh'`,
        `source '${repoRoot}/scripts/pr-lib/gates.sh'`,
        "mark_pr_operation_side_effects_started() { :; }",
        ...(options.sourcePush ? [`source '${repoRoot}/scripts/pr-lib/push.sh'`] : []),
        ...(options.sourcePrepareCore
          ? [`source '${repoRoot}/scripts/pr-lib/prepare-core.sh'`]
          : ["refresh_prep_branch_for_reviewed_head() { :; }"]),
        script,
      ].join("\n"),
    ],
    {
      cwd: options.cwd ?? repoRoot,
      encoding: "utf8",
      env: sanitizedEnv(options.env),
    },
  );
}

function makeRetryRepo(): { repoDir: string; stubBin: string; headSha: string } {
  const dir = tempDirs.make("openclaw-pr-gates-retry-");
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir);
  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "t"],
    ["config", "user.email", "t@example.com"],
    ["commit", "-q", "--allow-empty", "-m", "retry head"],
  ]) {
    const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
    expect(result.status).toBe(0);
  }
  mkdirSync(join(repoDir, ".local"));

  const stubBin = join(dir, "bin");
  mkdirSync(stubBin);
  writeFileSync(join(stubBin, "pnpm"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(stubBin, "pnpm"), 0o755);
  // Route the crabbox wrapper to a canned timing report; everything else
  // (the gate lock helper) still needs the real node.
  writeFileSync(
    join(stubBin, "node"),
    [
      "#!/bin/sh",
      'case "$2" in',
      `run) printf '{"provider":"blacksmith-testbox","leaseId":"tbx_retry","exitCode":0,"runStatus":"succeeded","actionsRunUrl":"https://example.test/runs/7"}\\n' >&2; exit 0;;`,
      `*) exec '${process.execPath}' "$@";;`,
      "esac",
    ].join("\n"),
  );
  chmodSync(join(stubBin, "node"), 0o755);

  const headSha = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoDir,
    encoding: "utf8",
  }).stdout.trim();
  return { repoDir, stubBin, headSha };
}

function makeSyncRepo(options: { needsRebase: boolean }): string {
  const repoDir = join(tempDirs.make("openclaw-pr-sync-"), "repo");
  mkdirSync(repoDir);

  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.com");

  const base = ["shared: old", "one", "two", "three", "four", "five", "pr: old", ""].join("\n");
  const prChange = base.replace("shared: old", "shared: new").replace("pr: old", "pr: new");
  const mainChange = base.replace("shared: old", "shared: new");
  writeFileSync(join(repoDir, "config.yml"), base);
  git("add", "config.yml");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "prep");
  writeFileSync(join(repoDir, "config.yml"), prChange);
  git("add", "config.yml");
  git("commit", "-qm", "pr change");
  git("checkout", "-q", "main");
  if (options.needsRebase) {
    writeFileSync(join(repoDir, "config.yml"), mainChange);
    git("add", "config.yml");
    git("commit", "-qm", "upstream shared hunk");
  }
  git("remote", "add", "origin", ".");
  git("fetch", "-q", "origin", "main");
  git("checkout", "-q", "prep");

  mkdirSync(join(repoDir, ".local"));
  writeFileSync(join(repoDir, ".local", "hosted-sha"), `${git("rev-parse", "HEAD")}\n`);
  writeFileSync(
    join(repoDir, ".local", "pr-meta.env"),
    "PR_NUMBER=4242\nPR_AUTHOR=steipete\nPR_URL=https://example.test/pr/4242\n",
  );
  writeFileSync(join(repoDir, ".local", "prep-context.env"), "PR_HEAD=topic\nPREP_BRANCH=prep\n");
  writeFileSync(join(repoDir, ".local", "prep.md"), "# Prepare\n");
  return repoDir;
}

function makePreparePushHeadDriftRepo(): {
  repoDir: string;
  recordedHead: string;
  reviewedHead: string;
} {
  const repoDir = join(tempDirs.make("openclaw-pr-prepare-drift-"), "repo");
  mkdirSync(repoDir);

  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.com");
  writeFileSync(join(repoDir, "base.txt"), "base\n");
  git("add", "base.txt");
  git("commit", "-qm", "base");
  const recordedHead = git("rev-parse", "HEAD");
  git("remote", "add", "origin", ".");
  git("fetch", "-q", "origin", "main");

  git("checkout", "-qb", "pr-4242");
  writeFileSync(join(repoDir, "reviewed.txt"), "new reviewed head\n");
  git("add", "reviewed.txt");
  git("commit", "-qm", "reviewed head update");
  const reviewedHead = git("rev-parse", "HEAD");

  git("checkout", "-qb", "prep", recordedHead);
  writeFileSync(join(repoDir, "stale-fixup.txt"), "belongs to stale prep head\n");
  git("add", "stale-fixup.txt");
  git("commit", "-qm", "stale prep fixup");

  mkdirSync(join(repoDir, ".local"));
  writeFileSync(
    join(repoDir, ".local", "pr-meta.env"),
    [
      "PR_NUMBER=4242",
      "PR_AUTHOR=steipete",
      "PR_URL=https://example.test/pr/4242",
      "PR_HEAD=topic",
      `PR_HEAD_SHA=${reviewedHead}`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(repoDir, ".local", "prep-context.env"),
    [
      "PR_NUMBER=4242",
      "PR_HEAD=topic",
      `PR_HEAD_SHA_BEFORE=${recordedHead}`,
      "PREP_BRANCH=prep",
      "PREP_STARTED_AT=2026-07-19T00:00:00Z",
      "",
    ].join("\n"),
  );
  writeFileSync(join(repoDir, ".local", "gates.env"), "GATES_MODE=stale\n");
  writeFileSync(join(repoDir, ".local", "prep.env"), "PREP_HEAD_SHA=stale\n");
  writeFileSync(join(repoDir, ".local", "prep.md"), "# Prepare\n");
  return { repoDir, recordedHead, reviewedHead };
}

function prepareSyncHeadStubs(): string[] {
  return [
    "enter_worktree() { :; }",
    "hosted_sha=$(cat .local/hosted-sha)",
    'gh() { printf "%s\\n" "$hosted_sha"; }',
    "verify_pr_head_branch_matches_expected() { :; }",
    'verify_prep_head_extends_hosted_head() { git merge-base --is-ancestor "$1" HEAD; }',
    "push_prep_head_to_pr_branch() {",
    '  local result_env="$7"',
    "  touch .local/published",
    '  printf \'PUSH_PREP_HEAD_SHA=%q\\nPUSH_LOCAL_PREP_HEAD_SHA=%q\\nPUSHED_FROM_SHA=%q\\nPR_HEAD_SHA_AFTER_PUSH=%q\\n\' "$3" "$3" "$hosted_sha" "$3" > "$result_env"',
    "}",
  ];
}

afterEach(() => {
  tempDirs.cleanup();
});

describe("resolve_pr_gates_remote_mode", () => {
  it.each([
    { value: undefined, expected: "local" },
    { value: "", expected: "local" },
    { value: "testbox", expected: "testbox" },
    { value: "crabbox-aws", expected: "crabbox-aws" },
  ])("resolves OPENCLAW_PR_GATES_REMOTE=$value to $expected", ({ value, expected }) => {
    const env: NodeJS.ProcessEnv = {};
    if (value !== undefined) {
      env.OPENCLAW_PR_GATES_REMOTE = value;
    }
    const result = runGatesBash("resolve_pr_gates_remote_mode", { env });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  it("rejects unsupported values", () => {
    const result = runGatesBash("resolve_pr_gates_remote_mode", {
      env: { OPENCLAW_PR_GATES_REMOTE: "azure" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unsupported OPENCLAW_PR_GATES_REMOTE=azure");
  });

  it("rejects the hosted-gates conflict before touching the worktree", () => {
    const result = runGatesBash("prepare_gates 424242", {
      env: { OPENCLAW_PR_GATES_REMOTE: "testbox", OPENCLAW_TESTBOX: "1" },
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("conflicts with OPENCLAW_TESTBOX=1");
  });

  it("rejects the Crabbox AWS hosted-gates conflict before touching the worktree", () => {
    const result = runGatesBash("prepare_gates 424242", {
      env: { OPENCLAW_PR_GATES_REMOTE: "crabbox-aws", OPENCLAW_TESTBOX: "1" },
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("OPENCLAW_PR_GATES_REMOTE=crabbox-aws conflicts");
  });
});

describe("remote Crabbox AWS gate contract", () => {
  it("accepts only a successful released AWS timing stamp", () => {
    const dir = tempDirs.make("openclaw-pr-gates-aws-stamp-");
    const log = join(dir, "gate.log");
    writeFileSync(
      log,
      [
        '{"provider":"aws","leaseId":"cbx_bad","runId":"run_bad","exitCode":1,"runStatus":"failed","leaseStopped":true}',
        '{"provider":"aws","leaseId":"cbx_ok","runId":"run_ok","exitCode":0,"runStatus":"succeeded","leaseStopped":true}',
        "",
      ].join("\n"),
    );
    const result = runGatesBash(
      `read_remote_crabbox_aws_gate_stamp '${log}' | jq -r '[.runId, .leaseId] | @tsv'`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("run_ok\tcbx_ok");
  });

  it("builds the canonical deterministic proof command", () => {
    const planPath = join(tempDirs.make("openclaw-crabbox-command-"), "plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        baseSha: "a".repeat(40),
        changedPaths: [{ path: "scripts/pr-lib/gates.sh", status: "M" }],
        headSha: "b".repeat(40),
        targets: ["test/scripts/pr-prepare-gates.test.ts"],
        version: 1,
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts/pr-crabbox-gate-publisher.mjs"),
        "--print-command",
        planPath,
        "c".repeat(64),
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("umask 022");
    expect(result.stdout).toContain("pnpm build");
    expect(result.stdout).toContain("pnpm check");
    expect(result.stdout).toContain("test/scripts/pr-prepare-gates.test.ts");
    expect(result.stdout).toContain(`OPENCLAW_CRABBOX_GATE_BASE=${"a".repeat(40)}`);
    expect(result.stdout).toContain(`OPENCLAW_CRABBOX_GATE_HEAD=${"b".repeat(40)}`);
    expect(result.stdout).not.toContain("OPENCLAW_CRABBOX_GATE_WORKFLOW=");
    expect(result.stdout).not.toContain("test/scripts/pr-wrappers.test.ts");
    expect(result.stdout).not.toContain("OPENCLAW_TEST_PROJECTS_PARALLEL");
    expect(result.stdout).not.toContain("pnpm test");
    expect(result.stdout).not.toContain("pnpm check:changed");
  });

  it("bounds the direct AWS lease for the PR-derived proof", () => {
    const dir = tempDirs.make("openclaw-pr-gates-aws-run-");
    const workDir = join(dir, "work");
    const crabbox = join(dir, "crabbox");
    mkdirSync(workDir);
    mkdirSync(join(workDir, ".local"));
    writeFileSync(
      crabbox,
      [
        "#!/bin/sh",
        'if [ "$1" = "config" ]; then',
        `  printf '%s\\n' '{"aws":{"instanceProfile":""},"coordinator":"https://example.test"}'`,
        "  exit 0",
        "fi",
        "printf 'ARG:%s\\n' \"$@\"",
        `printf '%s\\n' '{"provider":"aws","leaseId":"cbx_stub","runId":"run_stub","exitCode":0,"runStatus":"succeeded","leaseStopped":true}'`,
      ].join("\n"),
    );
    chmodSync(crabbox, 0o755);

    const result = runGatesBash(
      [
        "require_active_org_admin_for_crabbox_gate() { printf 'maintainer\\n'; }",
        `install_crabbox_release_v046() { printf '%s\\n' '${crabbox}'; }`,
        "git() { printf '#!/bin/sh\\n'; }",
        "node() {",
        '  case "$*" in',
        `    *crabbox-gate-plan.mts*) printf '%s\\n' '{"baseSha":"${"a".repeat(40)}","changedPaths":[],"headSha":"${"b".repeat(40)}","targets":[],"version":1,"digest":"${"c".repeat(64)}"}' ;;`,
        "    *pr-crabbox-gate-publisher.mjs*) printf 'true\\n' ;;",
        `    *) command '${process.execPath}' "$@" ;;`,
        "  esac",
        "}",
        `run_remote_crabbox_aws_gate 424242 '${"a".repeat(40)}' '${"b".repeat(40)}' >/dev/null`,
      ].join("\n"),
      { cwd: workDir },
    );

    expect(result.status, result.stderr).toBe(0);
    const args = readFileSync(join(workDir, ".local/gates-crabbox-aws.log"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("ARG:"))
      .map((line) => line.slice(4));
    const idleTimeoutIndex = args.indexOf("--idle-timeout");
    expect(idleTimeoutIndex).toBeGreaterThan(-1);
    expect(args.slice(idleTimeoutIndex, idleTimeoutIndex + 4)).toEqual([
      "--idle-timeout",
      "90m",
      "--ttl",
      "240m",
    ]);
  });
});

describe("prepare gate changed-file plan", () => {
  it.each([
    { paths: [] as string[], docsOnly: false, changelogOnly: false },
    { paths: ["docs/guide.md"], docsOnly: true, changelogOnly: false },
    { paths: ["CHANGELOG.md"], docsOnly: true, changelogOnly: true },
    { paths: ["src/index.ts"], docsOnly: false, changelogOnly: false },
    {
      paths: ["docs/guide.md", "src/index.ts"],
      docsOnly: false,
      changelogOnly: false,
    },
  ])("derives the coupled plan for $paths", ({ paths, docsOnly, changelogOnly }) => {
    const gitStub =
      paths.length === 0
        ? "git() { :; }"
        : `git() { printf '%s\\n' ${paths.map((path) => `'${path}'`).join(" ")}; }`;
    const result = runGatesBash(
      [
        gitStub,
        "derive_prepare_gate_change_plan",
        'printf "%s\\t%s\\t%s\\t%s\\n" "$PREPARE_GATE_CHANGED_FILES" "$PREPARE_GATE_DOCS_ONLY" "$PREPARE_GATE_CHANGELOG_ONLY" "$PREPARE_GATE_CHANGELOG_REQUIRED"',
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    const fields = result.stdout.trimEnd().split("\t");
    expect(fields).toEqual([paths.join("\n"), String(docsOnly), String(changelogOnly), "false"]);
  });

  it("carries the changelog policy decision into the plan", () => {
    const result = runGatesBash(
      [
        "git() { printf 'src/index.ts\\n'; }",
        "changelog_required_for_changed_files() { return 0; }",
        "derive_prepare_gate_change_plan",
        'printf "%s\\n" "$PREPARE_GATE_CHANGELOG_REQUIRED"',
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("true");
  });

  it("scans changed files without temporary input storage", () => {
    const workDir = tempDirs.make("openclaw-pr-gates-no-tmp-");
    mkdirSync(join(workDir, ".local"));
    writeFileSync(join(workDir, ".local", "pr-meta.env"), "PR_AUTHOR=steipete\n");
    const result = runGatesBash(
      [
        "enter_worktree() { :; }",
        "checkout_prep_branch() { :; }",
        "derive_prepare_gate_change_plan() {",
        "  PREPARE_GATE_CHANGED_FILES=$'CHANGELOG.md\\nchangelog/fragments/stale.md'",
        "  PREPARE_GATE_DOCS_ONLY=true",
        "  PREPARE_GATE_CHANGELOG_ONLY=false",
        "  PREPARE_GATE_CHANGELOG_REQUIRED=false",
        "}",
        "prepare_gates 4242",
      ].join("\n"),
      {
        cwd: workDir,
        env: { TMPDIR: join(workDir, "missing-tmp") },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Unsupported changelog fragment files detected:");
    expect(result.stdout).toContain("changelog/fragments/stale.md");
    expect(result.stderr).not.toContain("cannot create temp file");
    expect(readFileSync(join(repoRoot, "scripts/pr-lib/gates.sh"), "utf8")).not.toMatch(
      /done\s+(?:<<<|<\s*<\()/u,
    );
  });
});

describe("remote testbox gate delegation", () => {
  it("runs the full pnpm test through the worktree crabbox wrapper", () => {
    const dir = tempDirs.make("openclaw-pr-gates-remote-");
    const stubBin = join(dir, "bin");
    mkdirSync(stubBin);
    writeFileSync(
      join(stubBin, "node"),
      [
        "#!/bin/sh",
        "printf 'ARG:%s\\n' \"$@\"",
        `printf '{"provider":"blacksmith-testbox","leaseId":"tbx_stub","exitCode":0,"runStatus":"passed"}\\n' >&2`,
      ].join("\n"),
    );
    chmodSync(join(stubBin, "node"), 0o755);

    const workDir = join(dir, "work");
    mkdirSync(workDir);
    const result = runGatesBash(
      "run_remote_testbox_full_test_gate 'pnpm test (blacksmith-testbox)' .local/gates-test.log pr-424242-gates\n" +
        "grep '^ARG:' .local/gates-test.log | paste -sd ' ' -",
      {
        cwd: workDir,
        env: { PATH: `${stubBin}:${process.env.PATH ?? ""}` },
      },
    );

    expect(result.status).toBe(0);
    const argLine = result.stdout
      .split("\n")
      .find((line) => line.includes("crabbox-wrapper.mjs"))
      ?.replaceAll("ARG:", "");
    expect(argLine).toBe(
      "scripts/crabbox-wrapper.mjs run " +
        "--provider blacksmith-testbox " +
        "--blacksmith-org openclaw " +
        "--blacksmith-workflow .github/workflows/ci-check-testbox.yml " +
        "--blacksmith-job check " +
        "--blacksmith-ref main " +
        "--idle-timeout 90m --ttl 240m --timing-json " +
        "--label pr-424242-gates " +
        "-- env CI=1 OPENCLAW_TESTBOX_REMOTE_RUN=1 " +
        "PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=install corepack pnpm test",
    );
  });

  it("extracts the last successful blacksmith-testbox timing stamp", () => {
    const dir = tempDirs.make("openclaw-pr-gates-stamp-");
    const log = join(dir, "gates-test.log");
    writeFileSync(
      log,
      [
        "provider=blacksmith-testbox id=tbx_first sync=delegated auth=blacksmith",
        "GitHub Actions run: https://github.com/openclaw/openclaw/actions/runs/1234",
        '{"not":"a stamp"}',
        "not json at all",
        '{"provider":"blacksmith-testbox","leaseId":"tbx_first","exitCode":1,"runStatus":"failed"}',
        '{"provider":"blacksmith-testbox","leaseId":"tbx_final","exitCode":0,"runStatus":"passed"}',
        "GitHub Actions run: https://github.com/openclaw/openclaw/actions/runs/9999",
        "GitHub Actions run: https://github.com/example/other/actions/runs/8888",
        "",
      ].join("\n"),
    );

    const result = runGatesBash(
      `require_remote_testbox_gate_stamp '${log}' | jq -r '[.leaseId, .actionsRunUrl] | @tsv'`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "tbx_final\thttps://github.com/openclaw/openclaw/actions/runs/1234",
    );
  });

  it("fails when the gate log has no successful stamp", () => {
    const dir = tempDirs.make("openclaw-pr-gates-stamp-");
    const log = join(dir, "gates-test.log");
    writeFileSync(
      log,
      '{"provider":"blacksmith-testbox","leaseId":"tbx_only","exitCode":1,"runStatus":"failed"}\n',
    );

    const result = runGatesBash(`require_remote_testbox_gate_stamp '${log}'`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no successful blacksmith-testbox timing stamp");
  });
});

describe("lease-retry gate stamp refresh", () => {
  it("rewrites gates.env with the fresh remote stamp for the rebased head", () => {
    const { repoDir, stubBin, headSha } = makeRetryRepo();
    const result = runGatesBash(
      [
        "PR_NUMBER=4242",
        "CHANGELOG_REQUIRED=false",
        "REMOTE_GATES_PROVIDER=blacksmith-testbox",
        "REMOTE_GATES_LEASE_ID=tbx_stale",
        "REMOTE_GATES_RUN_URL=https://example.test/runs/1",
        "FULL_GATES_HEAD_SHA=deadbeef",
        "run_prepare_push_retry_gates false",
        "cat .local/gates.env",
      ].join("\n"),
      {
        cwd: repoDir,
        env: {
          PATH: `${stubBin}:${process.env.PATH ?? ""}`,
          OPENCLAW_PR_GATES_REMOTE: "testbox",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GATES_MODE=remote_testbox");
    expect(result.stdout).toContain("REMOTE_GATES_LEASE_ID=tbx_retry");
    expect(result.stdout).toContain(`LAST_VERIFIED_HEAD_SHA=${headSha}`);
    expect(result.stdout).toContain(`FULL_GATES_HEAD_SHA=${headSha}`);
    expect(result.stdout).not.toContain("tbx_stale");
  });

  it("clears a stale remote stamp when the retry test ran locally", () => {
    const { repoDir, stubBin, headSha } = makeRetryRepo();
    const result = runGatesBash(
      [
        "PR_NUMBER=4242",
        "CHANGELOG_REQUIRED=false",
        "REMOTE_GATES_PROVIDER=blacksmith-testbox",
        "REMOTE_GATES_LEASE_ID=tbx_stale",
        "run_prepare_push_retry_gates false",
        "cat .local/gates.env",
      ].join("\n"),
      {
        cwd: repoDir,
        env: { PATH: `${stubBin}:${process.env.PATH ?? ""}` },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GATES_MODE=full");
    expect(result.stdout).toContain("REMOTE_GATES_LEASE_ID=''");
    expect(result.stdout).toContain(`FULL_GATES_HEAD_SHA=${headSha}`);
    expect(result.stdout).not.toContain("tbx_stale");
  });
});

describe("prepare review readiness", () => {
  it("rejects invalid review artifacts before any preparation side effects", () => {
    const repoDir = tempDirs.make("openclaw-pr-prepare-invalid-review-");
    mkdirSync(join(repoDir, ".local"));
    const result = runGatesBash(
      [
        "review_validate_artifacts() { echo 'invalid review artifacts'; return 1; }",
        "require_ready_review_recommendation() { touch .local/readiness-called; }",
        "mark_pr_operation_side_effects_started() { touch .local/side-effects; }",
        "enter_worktree() { touch .local/worktree-entered; }",
        "prepare_init 4242",
      ].join("\n"),
      { cwd: repoDir, sourcePrepareCore: true },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("invalid review artifacts");
    expect(existsSync(join(repoDir, ".local", "readiness-called"))).toBe(false);
    expect(existsSync(join(repoDir, ".local", "side-effects"))).toBe(false);
    expect(existsSync(join(repoDir, ".local", "worktree-entered"))).toBe(false);
  });

  it("rejects a non-ready review before taking the operation lock past validation", () => {
    const repoDir = tempDirs.make("openclaw-pr-prepare-not-ready-");
    mkdirSync(join(repoDir, ".local"));
    const result = runGatesBash(
      [
        "review_validate_artifacts() { touch .local/review-validated; }",
        "require_ready_review_recommendation() { echo 'review is not ready'; return 1; }",
        "mark_pr_operation_side_effects_started() { touch .local/side-effects; }",
        "enter_worktree() { touch .local/worktree-entered; }",
        "prepare_init 4242",
      ].join("\n"),
      { cwd: repoDir, sourcePrepareCore: true },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("review is not ready");
    expect(existsSync(join(repoDir, ".local", "review-validated"))).toBe(true);
    expect(existsSync(join(repoDir, ".local", "side-effects"))).toBe(false);
    expect(existsSync(join(repoDir, ".local", "worktree-entered"))).toBe(false);
  });
});

describe("prepare sync-head transitions", () => {
  it("publishes only appended fixups when main advances", () => {
    const repoDir = makeSyncRepo({ needsRebase: true });
    writeFileSync(join(repoDir, "fixup.ts"), "export const fixed = true;\n");
    for (const args of [
      ["add", "fixup.ts"],
      ["commit", "-qm", "reviewed fixup"],
    ]) {
      const commit = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
      expect(commit.status, commit.stderr).toBe(0);
    }
    const localHead = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();

    const result = runGatesBash(
      [
        ...prepareSyncHeadStubs(),
        "prepare_sync_head 4242",
        `test "$(git rev-parse HEAD)" = "${localHead}"`,
        'test "$(git diff --name-only "$hosted_sha" HEAD)" = "fixup.ts"',
        'git merge-base --is-ancestor "$hosted_sha" HEAD',
        "! git merge-base --is-ancestor origin/main HEAD",
        "test -e .local/published",
        "grep -F 'Preserved hosted PR ancestry' .local/prep.md",
      ].join("\n"),
      { cwd: repoDir, env: { OPENCLAW_TESTBOX: "1" }, sourcePrepareCore: true },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("prepare-sync-head complete");
    expect(result.stdout).not.toContain("Rebase");
  });
});

describe("prepare push head drift", () => {
  it("rebuilds a stale prep branch and reruns gates before push", () => {
    const { repoDir, recordedHead, reviewedHead } = makePreparePushHeadDriftRepo();
    const result = runGatesBash(
      [
        "enter_worktree() { :; }",
        `reviewed_head='${reviewedHead}'`,
        'gh() { printf "%s\\n" "$reviewed_head"; }',
        "verify_pr_head_branch_matches_expected() { :; }",
        "prepare_gates() {",
        "  touch .local/gates-reran",
        "  printf 'DOCS_ONLY=false\\nGATES_MODE=fresh\\n' > .local/gates.env",
        "}",
        "push_prep_head_to_pr_branch() {",
        '  local result_env="$7"',
        '  printf \'PUSH_PREP_HEAD_SHA=%q\\nPUSH_LOCAL_PREP_HEAD_SHA=%q\\nPUSHED_FROM_SHA=%q\\nPR_HEAD_SHA_AFTER_PUSH=%q\\n\' "$3" "$3" "$reviewed_head" "$3" > "$result_env"',
        "}",
        "prepare_push 4242",
        'test "$(git rev-parse HEAD)" = "$reviewed_head"',
        "test -e .local/gates-reran",
        "test ! -e stale-fixup.txt",
        'test "$(. .local/prep-context.env; printf "%s" "$PR_HEAD_SHA_BEFORE")" = "$reviewed_head"',
        `grep -F 'drifted from ${recordedHead} to ${reviewedHead}' .local/prep.md`,
        "grep -F 'Gate mode: fresh' .local/prep.md",
      ].join("\n"),
      { cwd: repoDir, sourcePrepareCore: true },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `Prep source head changed from ${recordedHead} to reviewed head ${reviewedHead}.`,
    );
    expect(result.stdout).toContain(
      "Prep branch was refreshed for reviewed head drift; rerunning prepare gates before push.",
    );
    expect(result.stdout).toContain("prepare-push complete");
  });
});

describe("GraphQL fork publication", () => {
  it("accepts appended fixups and preserves the commit body", () => {
    const { repoDir, headSha } = makeRetryRepo();
    writeFileSync(join(repoDir, "fixup.ts"), "export const fixed = true;\n");
    for (const args of [
      ["add", "fixup.ts"],
      ["commit", "-qm", "reviewed fixup\n\nCo-authored-by: Helper <helper@example.com>"],
    ]) {
      const commit = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
      expect(commit.status, commit.stderr).toBe(0);
    }

    const result = runGatesBash(
      [
        'gh_plain() { cat > .local/graphql-payload.json; printf \'%s\\n\' \'{"data":{"createCommitOnBranch":{"commit":{"oid":"signed-head","url":"https://example.test/commit"}}}}\'; }',
        `graphql_push_to_fork example/repo topic ${headSha}`,
        'test "$(jq -r .variables.input.message.headline .local/graphql-payload.json)" = "reviewed fixup"',
        'test "$(jq -r .variables.input.message.body .local/graphql-payload.json)" = "Co-authored-by: Helper <helper@example.com>"',
      ].join("\n"),
      { cwd: repoDir, sourcePush: true },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("signed-head");
  });

  it("rejects merge commits before encoding files or calling GitHub", () => {
    const { repoDir, headSha } = makeRetryRepo();
    const baseBranch = spawnSync("git", ["branch", "--show-current"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();
    for (const args of [
      ["checkout", "-qb", "other"],
      ["commit", "-qm", "other", "--allow-empty"],
      ["checkout", "-q", baseBranch],
      ["merge", "-q", "--no-ff", "other", "-m", "merge other"],
    ]) {
      const command = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
      expect(command.status, command.stderr).toBe(0);
    }

    const result = runGatesBash(
      [
        "gh_plain() { touch .local/gh-called; return 99; }",
        `graphql_push_to_fork example/repo topic ${headSha}`,
      ].join("\n"),
      { cwd: repoDir, sourcePush: true },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot preserve merge ancestry");
    expect(existsSync(join(repoDir, ".local", "gh-called"))).toBe(false);
  });

  it("rejects rewritten history before encoding files or calling GitHub", () => {
    const { repoDir, headSha } = makeRetryRepo();
    const tree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();
    const unrelatedHead = spawnSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit-tree",
        tree,
        "-m",
        "rewritten",
      ],
      { cwd: repoDir, encoding: "utf8" },
    ).stdout.trim();
    const checkout = spawnSync("git", ["checkout", "-q", "--detach", unrelatedHead], {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(checkout.status, checkout.stderr).toBe(0);

    const result = runGatesBash(
      [
        "gh_plain() { touch .local/gh-called; return 99; }",
        `graphql_push_to_fork example/repo topic ${headSha}`,
      ].join("\n"),
      { cwd: repoDir, sourcePush: true },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refused rewritten history");
    expect(existsSync(join(repoDir, ".local", "gh-called"))).toBe(false);
  });
});

describe("fork publication transport", () => {
  it("keeps the PR push URL process-local and reports a missing branch", () => {
    const { repoDir } = makeRetryRepo();
    const result = runGatesBash(
      [
        "resolve_head_push_url() { printf '%s\\n' https://github.com/contributor/repo.git; }",
        "git() { touch .local/git-called; return 99; }",
        "setup_prhead_remote",
        'test "$PRHEAD_REMOTE_URL" = https://github.com/contributor/repo.git',
        "test ! -e .local/git-called",
        "if remote_error=$(resolve_prhead_remote_sha topic 2>&1); then exit 97; fi",
        'test "$remote_error" = "Remote branch refs/heads/topic not found on prhead"',
        "test -e .local/git-called",
      ].join("\n"),
      { cwd: repoDir, sourcePush: true },
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it("uses git transport automatically for a verified signed prep commit", () => {
    const { repoDir } = makeRetryRepo();
    const result = runGatesBash(
      [
        "PR_HEAD_OWNER=contributor",
        "PR_HEAD_REPO_NAME=repo",
        "PRHEAD_REMOTE_URL=https://github.com/contributor/repo.git",
        "git() { printf '%s\\n' \"$*\" >> .local/git-calls; case \"$1\" in rev-list) printf '%s\\n' prepared;; esac; return 0; }",
        "graphql_push_to_fork() { touch .local/graphql-called; return 99; }",
        "push_prep_head_once topic hosted prepared",
        "grep -F 'verify-commit prepared' .local/git-calls",
        "grep -F 'push --force-with-lease=refs/heads/topic:hosted https://github.com/contributor/repo.git prepared:refs/heads/topic' .local/git-calls",
        "test ! -e .local/graphql-called",
      ].join("\n"),
      { cwd: repoDir, sourcePush: true },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("prepared");
  });

  it("keeps unsigned single-parent fixups on GitHub-signed GraphQL publication", () => {
    const { repoDir } = makeRetryRepo();
    const result = runGatesBash(
      [
        "PR_HEAD_OWNER=contributor",
        "PR_HEAD_REPO_NAME=repo",
        "PRHEAD_REMOTE_URL=https://github.com/contributor/repo.git",
        "git() { case \"$1\" in rev-list) printf '%s\\n' prepared;; verify-commit) return 1;; esac; return 0; }",
        "graphql_push_to_fork() { touch .local/graphql-called; printf '%s\\n' signed-head; }",
        "push_prep_head_once topic hosted prepared",
        "test -e .local/graphql-called",
      ].join("\n"),
      { cwd: repoDir, sourcePush: true },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("signed-head");
  });
});

describe("prepare gate stamp transitions", () => {
  it.each([
    ["CHANGELOG.md", true],
    ["changed.ts", false],
  ])("derives recent parent evidence for a %s commit: %s", (path, expected) => {
    const { repoDir, headSha: parentSha } = makeRetryRepo();
    writeFileSync(join(repoDir, path), "change\n");
    spawnSync("git", ["add", path], { cwd: repoDir });
    spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "change"],
      { cwd: repoDir },
    );
    const currentHead = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();
    const result = runGatesBash(
      [
        `gh() { if [ "$1" = pr ]; then printf '{"headRefName":"topic","headRefOid":"${currentHead}","isCrossRepository":false}\\n'; else printf 'openclaw/openclaw\\n'; fi; }`,
        "run_quiet_logged() { printf 'ARG:%s\\n' \"$@\"; }",
        `run_hosted_prepare_gates 100606 ${currentHead} false`,
      ].join("\n"),
      { cwd: repoDir },
    );

    expect(result.status).toBe(0);
    if (expected) {
      expect(result.stdout).toContain(`ARG:--recent-sha\nARG:${parentSha}`);
    } else {
      expect(result.stdout).not.toContain("ARG:--recent-sha");
    }
  });

  it("prints the exact recovery command when hosted CI is missing", () => {
    const { repoDir, headSha } = makeRetryRepo();
    const result = runGatesBash(
      [
        `gh() { if [ "$1" = pr ]; then printf '{"headRefName":"topic","headRefOid":"${headSha}","isCrossRepository":false}\\n'; else printf 'openclaw/openclaw\\n'; fi; }`,
        'rg() { command grep -F -q "$3" "$4"; }',
        `run_quiet_logged() { printf 'Missing successful recent CI workflow for ${headSha}. Observed: none\\n' > "$2"; return 1; }`,
        `run_hosted_prepare_gates 100606 ${headSha} false`,
      ].join("\n"),
      { cwd: repoDir },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("scripts/pr ci-dispatch 100606");
    expect(result.stdout).toContain(
      `gh workflow run ci.yml --ref topic -f target_ref=${headSha} -f release_gate=true -f pull_request_number=100606`,
    );
  });

  it("does not advertise an unusable dispatch command for fork PRs", () => {
    const { repoDir, headSha } = makeRetryRepo();
    const result = runGatesBash(
      [
        `gh() { if [ "$1" = pr ]; then printf '{"headRefName":"topic","headRefOid":"${headSha}","isCrossRepository":true}\\n'; else printf 'openclaw/openclaw\\n'; fi; }`,
        'rg() { command grep -F -q "$3" "$4"; }',
        `run_quiet_logged() { printf 'Missing successful recent CI workflow for ${headSha}. Observed: none\\n' > "$2"; return 1; }`,
        `run_hosted_prepare_gates 100606 ${headSha} false`,
      ].join("\n"),
      { cwd: repoDir },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("scripts/pr ci-dispatch 100606");
    expect(result.stdout).toContain("unavailable: PR #100606 comes from a fork");
    expect(result.stdout).not.toContain("gh workflow run");
  });

  it("clears remote stamps when fresh docs-only gates do not reuse prior proof", () => {
    const { repoDir } = makeRetryRepo();
    spawnSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repoDir });
    mkdirSync(join(repoDir, "docs"), { recursive: true });
    writeFileSync(join(repoDir, "docs", "proof.md"), "fresh docs\n");
    spawnSync("git", ["add", "docs/proof.md"], { cwd: repoDir });
    spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "docs"],
      { cwd: repoDir },
    );
    writeFileSync(join(repoDir, ".local", "pr-meta.env"), "PR_AUTHOR=steipete\n");
    writeFileSync(
      join(repoDir, ".local", "gates.env"),
      [
        "LAST_VERIFIED_HEAD_SHA=deadbeef",
        "FULL_GATES_HEAD_SHA=deadbeef",
        "REMOTE_GATES_PROVIDER=blacksmith-testbox",
        "REMOTE_GATES_LEASE_ID=tbx_stale",
        "REMOTE_GATES_RUN_URL=https://example.test/runs/1",
        "",
      ].join("\n"),
    );

    const result = runGatesBash(
      [
        "enter_worktree() { :; }",
        "checkout_prep_branch() { :; }",
        "path_is_docsish() { return 0; }",
        "changelog_required_for_changed_files() { return 1; }",
        "prepare_local_gate_workspace() { :; }",
        "run_quiet_logged() { :; }",
        "prepare_gates 4242",
        "cat .local/gates.env",
      ].join("\n"),
      { cwd: repoDir },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GATES_MODE=docs_only");
    expect(result.stdout).toContain("FULL_GATES_HEAD_SHA=''");
    expect(result.stdout).toContain("REMOTE_GATES_LEASE_ID=''");
    expect(result.stdout).not.toContain("tbx_stale");
  });

  it("clears remote stamps when hosted gates replace remote proof", () => {
    const { repoDir } = makeRetryRepo();
    spawnSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repoDir });
    writeFileSync(join(repoDir, "changed.ts"), "export {};\n");
    spawnSync("git", ["add", "changed.ts"], { cwd: repoDir });
    spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "change"],
      { cwd: repoDir },
    );
    writeFileSync(join(repoDir, ".local", "pr-meta.env"), "PR_AUTHOR=steipete\n");
    writeFileSync(
      join(repoDir, ".local", "gates.env"),
      [
        "LAST_VERIFIED_HEAD_SHA=deadbeef",
        "FULL_GATES_HEAD_SHA=deadbeef",
        "REMOTE_GATES_PROVIDER=blacksmith-testbox",
        "REMOTE_GATES_LEASE_ID=tbx_stale",
        "REMOTE_GATES_RUN_URL=https://example.test/runs/1",
        "",
      ].join("\n"),
    );

    const result = runGatesBash(
      [
        "enter_worktree() { :; }",
        "checkout_prep_branch() { :; }",
        "path_is_docsish() { return 1; }",
        "changelog_required_for_changed_files() { return 1; }",
        "run_hosted_prepare_gates() { printf 'HOSTED\\n'; }",
        "prepare_gates 4242",
        "cat .local/gates.env",
      ].join("\n"),
      { cwd: repoDir, env: { OPENCLAW_TESTBOX: "1" } },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GATES_MODE=hosted_exact_or_recent_parent");
    expect(result.stdout).toContain("HOSTED");
    expect(result.stdout).toContain("REMOTE_GATES_LEASE_ID=''");
    expect(result.stdout).not.toContain("tbx_stale");
  });
});

describe("gates.sh local gate workspace", () => {
  it("pins the worktree before dependency bootstrap", () => {
    const result = runGatesBash(
      [
        "events=$(mktemp)",
        'pin_worktree_bundled_plugins_dir() { echo pin >> "$events"; }',
        'bootstrap_deps_if_needed() { echo bootstrap >> "$events"; }',
        "prepare_local_gate_workspace",
        'cat "$events"',
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["pin", "bootstrap"]);
  });
});
