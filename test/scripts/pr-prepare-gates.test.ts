// Covers the scripts/pr prepare-gates remote testbox mode and the
// cross-worktree gate lock that serializes whole gate blocks.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const gateLockHelperPath = join(repoRoot, "scripts", "pr-gates-lock.mjs");

const tempDirs: string[] = [];
const children: ChildProcess[] = [];

function makeTempDir(prefix: string): string {
  // macOS os.tmpdir() is a /var -> /private/var symlink; resolve so lock and
  // owner paths compare canonically.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function makeLockRepoDir(): string {
  const dir = makeTempDir("openclaw-pr-gates-lock-");
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

function heavyCheckLockDir(repoDir: string): string {
  return join(repoDir, ".git", "openclaw-local-checks", "heavy-check.lock");
}

function sanitizedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // check:changed and gate runs export these to children; drop ambient copies
  // so lock and mode behavior under test only sees explicit overrides.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.OPENCLAW_PR_GATES_REMOTE;
  delete env.OPENCLAW_TESTBOX;
  delete env.OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD;
  delete env.OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD;
  delete env.OPENCLAW_OXLINT_SKIP_LOCK;
  delete env.OPENCLAW_HEAVY_CHECK_LOCK_TIMEOUT_MS;
  delete env.OPENCLAW_HEAVY_CHECK_LOCK_POLL_MS;
  return { ...env, ...overrides };
}

function runGatesBash(
  script: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; sourcePrepareCore?: boolean } = {},
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
        ...(options.sourcePrepareCore
          ? [`source '${repoRoot}/scripts/pr-lib/prepare-core.sh'`]
          : []),
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

function spawnGateLockHolder(repoDir: string, statusFile: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [gateLockHelperPath, "--status-file", statusFile], {
    cwd: repoDir,
    stdio: ["ignore", "ignore", "pipe"],
    env: sanitizedEnv(env),
  });
  children.push(child);
  return child;
}

function makeRetryRepo(): { repoDir: string; stubBin: string; headSha: string } {
  const dir = makeTempDir("openclaw-pr-gates-retry-");
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir);
  for (const args of [
    ["init", "-q"],
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "retry head",
    ],
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
  const repoDir = join(makeTempDir("openclaw-pr-sync-"), "repo");
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
  writeFileSync(
    join(repoDir, ".local", "pr-meta.env"),
    "PR_NUMBER=4242\nPR_AUTHOR=steipete\nPR_URL=https://example.test/pr/4242\n",
  );
  writeFileSync(join(repoDir, ".local", "prep-context.env"), "PR_HEAD=topic\nPREP_BRANCH=prep\n");
  writeFileSync(join(repoDir, ".local", "prep.md"), "# Prepare\n");
  return repoDir;
}

function prepareSyncHeadStubs(): string[] {
  return [
    "enter_worktree() { :; }",
    "hosted_sha=$(git rev-parse HEAD)",
    'gh() { printf "%s\\n" "$hosted_sha"; }',
    "verify_pr_head_branch_matches_expected() { :; }",
    "push_prep_head_to_pr_branch() {",
    '  [ ! -e .local/prep-sync.env ] || { echo "stale sync evidence reached publication" >&2; return 97; }',
    '  local result_env="$7"',
    "  touch .local/published",
    '  printf \'PUSH_PREP_HEAD_SHA=%q\\nPUSH_LOCAL_PREP_HEAD_SHA=%q\\nPUSHED_FROM_SHA=%q\\nPR_HEAD_SHA_AFTER_PUSH=%q\\n\' "$3" "$3" "$hosted_sha" "$3" > "$result_env"',
    "}",
  ];
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    child.once("exit", resolve);
  });
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolve_pr_gates_remote_mode", () => {
  it.each([
    { value: undefined, expected: "local" },
    { value: "", expected: "local" },
    { value: "testbox", expected: "testbox" },
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
});

describe("remote testbox gate delegation", () => {
  it("runs the full pnpm test through the worktree crabbox wrapper", () => {
    const dir = makeTempDir("openclaw-pr-gates-remote-");
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
        "-- env CI=1 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=install corepack pnpm test",
    );
  });

  it("extracts the last successful blacksmith-testbox timing stamp", () => {
    const dir = makeTempDir("openclaw-pr-gates-stamp-");
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
    const dir = makeTempDir("openclaw-pr-gates-stamp-");
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

describe("prepare sync-head transitions", () => {
  it("publishes a changed-patch Testbox rebase with fresh sync evidence", () => {
    const repoDir = makeSyncRepo({ needsRebase: true });
    writeFileSync(join(repoDir, ".local", "prep-sync.env"), "PREP_SYNC_TREE=stale\n");
    writeFileSync(join(repoDir, ".local", "gates.env"), "GATES_MODE=stale\n");
    writeFileSync(join(repoDir, ".local", "prep.env"), "PREP_HEAD_SHA=stale\n");

    const result = runGatesBash(
      [
        ...prepareSyncHeadStubs(),
        "resolve_prep_sync_evidence_sha() { touch .local/evidence-called; printf '%s\\n' \"$2\"; }",
        "prepare_sync_head 4242",
        "source .local/prep-sync.env",
        'test "$PREP_SYNC_TREE" = "$(git rev-parse HEAD^{tree})"',
        'test "$PREP_SYNC_PATCH_ID" = "$(compute_pr_patch_id origin/main HEAD)"',
        'test -z "$PREP_SYNC_EVIDENCE_SHA"',
        "test -e .local/published",
        "test ! -e .local/evidence-called",
        "test ! -e .local/gates.env",
        "test ! -e .local/prep.env",
        'printf "SYNC_EVIDENCE=<%s>\\n" "$PREP_SYNC_EVIDENCE_SHA"',
      ].join("\n"),
      { cwd: repoDir, env: { OPENCLAW_TESTBOX: "1" }, sourcePrepareCore: true },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Rebase changed the PR patch");
    expect(result.stdout).toContain("prepare-sync-head complete");
    expect(result.stdout).toContain("SYNC_EVIDENCE=<>\n");
  });

  it("clears stale sync evidence before a new publication attempt", () => {
    const repoDir = makeSyncRepo({ needsRebase: false });
    writeFileSync(join(repoDir, ".local", "prep-sync.env"), "PREP_SYNC_TREE=stale\n");

    const result = runGatesBash(
      [
        ...prepareSyncHeadStubs(),
        "prepare_sync_head 4242",
        "test -e .local/published",
        "test ! -e .local/prep-sync.env",
        'printf "STALE_SYNC_EXISTS=no\\n"',
      ].join("\n"),
      { cwd: repoDir, env: { OPENCLAW_TESTBOX: "1" }, sourcePrepareCore: true },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("STALE_SYNC_EXISTS=no\n");
  });
});

describe("prepare gate stamp transitions", () => {
  it("preserves whitespace in the rebase patch fingerprint", () => {
    const { repoDir, headSha: baseSha } = makeRetryRepo();
    writeFileSync(join(repoDir, "config.yml"), "root:\n  child: value\n");
    spawnSync("git", ["add", "config.yml"], { cwd: repoDir });
    spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "two spaces"],
      { cwd: repoDir },
    );
    const twoSpaceSha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();
    writeFileSync(join(repoDir, "config.yml"), "root:\n    child: value\n");
    spawnSync("git", ["add", "config.yml"], { cwd: repoDir });
    spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "four spaces"],
      { cwd: repoDir },
    );
    const fourSpaceSha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();

    const result = runGatesBash(
      [
        `compute_pr_patch_id ${baseSha} ${twoSpaceSha}`,
        `compute_pr_patch_id ${baseSha} ${fourSpaceSha}`,
      ].join("\n"),
      { cwd: repoDir },
    );
    expect(result.status).toBe(0);
    const patchIds = result.stdout.trim().split("\n");
    expect(patchIds).toHaveLength(2);
    expect(patchIds[0]).not.toBe(patchIds[1]);
  });

  it("uses the hosted pre-sync SHA only when its tree matches the local prep head", () => {
    const { repoDir, headSha } = makeRetryRepo();
    const tree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();
    const remoteSha = spawnSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit-tree",
        tree,
        "-p",
        headSha,
        "-m",
        "hosted head",
      ],
      { cwd: repoDir, encoding: "utf8" },
    ).stdout.trim();

    const matching = runGatesBash(`resolve_prep_sync_evidence_sha ${headSha} ${remoteSha}`, {
      cwd: repoDir,
      sourcePrepareCore: true,
    });
    expect(matching.status).toBe(0);
    expect(matching.stdout.trim()).toBe(remoteSha);

    writeFileSync(join(repoDir, "changed.ts"), "export {};\n");
    spawnSync("git", ["add", "changed.ts"], { cwd: repoDir });
    spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "different"],
      { cwd: repoDir },
    );
    const mismatched = runGatesBash(
      `resolve_prep_sync_evidence_sha ${headSha} $(git rev-parse HEAD)`,
      { cwd: repoDir, sourcePrepareCore: true },
    );
    expect(mismatched.status).not.toBe(0);
  });

  it("forwards only the recorded pre-rebase SHA as recent evidence", () => {
    const result = runGatesBash(
      [
        "gh() { if [ \"$1\" = pr ]; then printf 'deadbeef\\n'; else printf 'openclaw/openclaw\\n'; fi; }",
        "run_quiet_logged() { printf 'ARG:%s\\n' \"$@\"; }",
        "run_hosted_prepare_gates 100606 deadbeef false cafebabe",
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ARG:hosted CI/Testbox gates");
    expect(result.stdout).toContain(`ARG:${repoRoot}/scripts/verify-pr-hosted-gates.mjs`);
    expect(result.stdout).toContain("ARG:--pr\nARG:100606");
    expect(result.stdout).toContain("ARG:--recent-sha\nARG:cafebabe");
  });

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
        `gh() { if [ "$1" = pr ]; then printf '${currentHead}\\n'; else printf 'openclaw/openclaw\\n'; fi; }`,
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
        "release_pr_gates_lock() { :; }",
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
    const prepTree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();
    const mainlineBase = spawnSync("git", ["rev-parse", "refs/remotes/origin/main"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();
    const patchId = spawnSync(
      "bash",
      [
        "-c",
        "git diff --binary refs/remotes/origin/main HEAD | git patch-id --verbatim | awk 'NR == 1 { print $1 }'",
      ],
      { cwd: repoDir, encoding: "utf8" },
    ).stdout.trim();
    writeFileSync(join(repoDir, ".local", "pr-meta.env"), "PR_AUTHOR=steipete\n");
    writeFileSync(
      join(repoDir, ".local", "prep-sync.env"),
      [
        `PREP_SYNC_MAINLINE_BASE_SHA=${mainlineBase}`,
        `PREP_SYNC_TREE=${prepTree}`,
        `PREP_SYNC_PATCH_ID=${patchId}`,
        "PREP_SYNC_EVIDENCE_SHA=cafebabe",
        "",
      ].join("\n"),
    );
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
        "run_hosted_prepare_gates() { printf 'RECENT:%s\\n' \"${4:-}\"; }",
        "prepare_gates 4242",
        "cat .local/gates.env",
      ].join("\n"),
      { cwd: repoDir, env: { OPENCLAW_TESTBOX: "1" } },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GATES_MODE=hosted_exact_or_recent_rebase");
    expect(result.stdout).toContain("RECENT:cafebabe");
    expect(result.stdout).toContain("REMOTE_GATES_LEASE_ID=''");
    expect(result.stdout).not.toContain("tbx_stale");
  });
});

describe("pr-gates-lock helper", () => {
  it("acquires the shared heavy-check lock and releases it on SIGTERM", async () => {
    const repoDir = makeLockRepoDir();
    const statusFile = join(repoDir, "status");
    const holder = spawnGateLockHolder(repoDir, statusFile);

    expect(await waitFor(() => existsSync(statusFile), 5_000)).toBe(true);
    expect(existsSync(heavyCheckLockDir(repoDir))).toBe(true);

    holder.kill("SIGTERM");
    await waitForExit(holder);
    expect(await waitFor(() => !existsSync(heavyCheckLockDir(repoDir)), 5_000)).toBe(true);
  });

  it("queues behind an existing holder and acquires after it exits", async () => {
    const repoDir = makeLockRepoDir();
    const firstStatus = join(repoDir, "status-first");
    const secondStatus = join(repoDir, "status-second");

    const first = spawnGateLockHolder(repoDir, firstStatus);
    expect(await waitFor(() => existsSync(firstStatus), 5_000)).toBe(true);

    const second = spawnGateLockHolder(repoDir, secondStatus, {
      OPENCLAW_HEAVY_CHECK_LOCK_POLL_MS: "50",
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(existsSync(secondStatus)).toBe(false);

    first.kill("SIGTERM");
    await waitForExit(first);
    expect(await waitFor(() => existsSync(secondStatus), 5_000)).toBe(true);

    second.kill("SIGTERM");
    await waitForExit(second);
    expect(await waitFor(() => !existsSync(heavyCheckLockDir(repoDir)), 5_000)).toBe(true);
  });

  it("fails instead of holding when the wait times out", async () => {
    const repoDir = makeLockRepoDir();
    const lockDir = heavyCheckLockDir(repoDir);
    mkdirSync(lockDir, { recursive: true });
    // Owner pid must be alive or the helper reclaims the stale lock.
    writeFileSync(
      join(lockDir, "owner.json"),
      `${JSON.stringify({ pid: process.pid, tool: "test-holder", cwd: repoDir })}\n`,
    );

    const statusFile = join(repoDir, "status");
    const holder = spawnGateLockHolder(repoDir, statusFile, {
      OPENCLAW_HEAVY_CHECK_LOCK_TIMEOUT_MS: "200",
      OPENCLAW_HEAVY_CHECK_LOCK_POLL_MS: "50",
    });
    await waitForExit(holder);

    expect(holder.exitCode).not.toBe(0);
    expect(existsSync(statusFile)).toBe(false);
  });

  it("releases the lock when the parent process dies", async () => {
    const repoDir = makeLockRepoDir();
    const statusFile = join(repoDir, "status");
    const parent = spawn(
      "bash",
      [
        "-c",
        `node '${gateLockHelperPath}' --status-file '${statusFile}' 2>/dev/null & ` +
          `while [ ! -s '${statusFile}' ]; do sleep 0.05; done`,
      ],
      { cwd: repoDir, stdio: "ignore", env: sanitizedEnv() },
    );
    children.push(parent);
    await waitForExit(parent);

    expect(existsSync(statusFile)).toBe(true);
    expect(await waitFor(() => !existsSync(heavyCheckLockDir(repoDir)), 8_000)).toBe(true);
  });
});

describe("gates.sh gate lock plumbing", () => {
  it("acquires the block lock before dependency bootstrap", () => {
    const result = runGatesBash(
      [
        "events=$(mktemp)",
        'pin_worktree_bundled_plugins_dir() { echo pin >> "$events"; }',
        'acquire_pr_gates_lock() { echo lock >> "$events"; }',
        'bootstrap_deps_if_needed() { echo bootstrap >> "$events"; }',
        "prepare_local_gate_workspace",
        'cat "$events"',
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["pin", "lock", "bootstrap"]);
  });

  it("exports the held-lock contract while holding and clears it on release", () => {
    const repoDir = makeLockRepoDir();
    const result = runGatesBash(
      [
        "acquire_pr_gates_lock",
        'echo "held=${OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD:-unset},${OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD:-unset},${OPENCLAW_OXLINT_SKIP_LOCK:-unset}"',
        "jq -r .tool .git/openclaw-local-checks/heavy-check.lock/owner.json",
        "release_pr_gates_lock",
        'echo "released=${OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD:-unset}"',
        '[ -d .git/openclaw-local-checks/heavy-check.lock ] && echo "lock=held" || echo "lock=free"',
      ].join("\n"),
      { cwd: repoDir },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("held=1,1,1");
    expect(result.stdout).toContain("pr-gates");
    expect(result.stdout).toContain("released=unset");
    expect(result.stdout).toContain("lock=free");
  });

  it("skips acquisition when a parent already holds the lock", () => {
    const repoDir = makeLockRepoDir();
    const result = runGatesBash(
      [
        "acquire_pr_gates_lock",
        '[ -d .git/openclaw-local-checks/heavy-check.lock ] && echo "lock=held" || echo "lock=free"',
        'echo "helper_pid=${PR_GATES_LOCK_PID:-none}"',
      ].join("\n"),
      { cwd: repoDir, env: { OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1" } },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("lock=free");
    expect(result.stdout).toContain("helper_pid=none");
  });

  it("fails the gate run when the lock wait times out", () => {
    const repoDir = makeLockRepoDir();
    const lockDir = heavyCheckLockDir(repoDir);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      `${JSON.stringify({ pid: process.pid, tool: "test-holder", cwd: repoDir })}\n`,
    );

    const result = runGatesBash("acquire_pr_gates_lock", {
      cwd: repoDir,
      env: {
        OPENCLAW_HEAVY_CHECK_LOCK_TIMEOUT_MS: "200",
        OPENCLAW_HEAVY_CHECK_LOCK_POLL_MS: "50",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "Failed to acquire the shared local heavy-check lock for prepare gates.",
    );
  });
});
