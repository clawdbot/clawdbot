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

function makeRetryRepo(): { repoDir: string; headSha: string } {
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

  const headSha = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoDir,
    encoding: "utf8",
  }).stdout.trim();
  return { repoDir, headSha };
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
  writeFileSync(
    join(repoDir, ".local", "prep-context.env"),
    `PR_HEAD=topic\nPREP_BRANCH=prep\nPR_HEAD_SHA_BEFORE=${git("rev-parse", "HEAD")}\n`,
  );
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
    "enter_worktree() { PR_MAIN_SHA=$(git rev-parse --verify refs/remotes/origin/main); }",
    "hosted_sha=$(cat .local/hosted-sha)",
    'gh() { printf "%s\\n" "$hosted_sha"; }',
    "verify_pr_head_branch_matches_expected() { :; }",
    'verify_prep_head_extends_hosted_head() { git merge-base --is-ancestor "$1" HEAD; }',
    "push_prep_head_to_pr_branch() {",
    '  local result_env="$5"',
    "  touch .local/published",
    '  printf \'PUSH_PREP_HEAD_SHA=%q\\nPUSH_LOCAL_PREP_HEAD_SHA=%q\\nPUSHED_FROM_SHA=%q\\nPUSH_REPLACED_HOSTED_ANCESTRY=false\\nPR_HEAD_SHA_AFTER_PUSH=%q\\n\' "$3" "$3" "$hosted_sha" "$3" > "$result_env"',
    "}",
  ];
}

function makePublisherRepo() {
  const root = tempDirs.make("openclaw-pr-publication-");
  const repoDir = join(root, "repo");
  const remote = join(root, "remote.git");
  const env = sanitizedEnv({
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    OPENCLAW_ALLOW_UNSIGNED_GIT_PUSH: "1",
    OPENCLAW_PR_PUSH_MODE: "git",
  });
  mkdirSync(repoDir);
  function git(...args: string[]) {
    const result = spawnSync("git", args, { cwd: repoDir, env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }
  git("init", "-q", "-b", "prep");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("commit", "-qm", "base", "--allow-empty");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repoDir, "reviewed.txt"), "reviewed\n");
  git("add", ".");
  git("commit", "-qm", "reviewed");
  const source = git("rev-parse", "HEAD");
  writeFileSync(join(repoDir, "fixup.txt"), "fixup\n");
  git("add", ".");
  git("commit", "-qm", "fixup");
  const candidate = git("rev-parse", "HEAD");
  const sameTree = git("commit-tree", `${candidate}^{tree}`, "-p", source, "-m", "foreign");
  const advance = git("commit-tree", `${source}^{tree}`, "-p", source, "-m", "foreign advance");
  git("init", "-q", "--bare", remote);
  git("remote", "add", "origin", remote);
  git("push", "-q", "origin", `${candidate}:refs/heads/objects`, `${source}:refs/heads/topic`);
  git("--git-dir", remote, "symbolic-ref", "refs/pull/4242/head", "refs/heads/topic");
  const local = join(repoDir, ".local");
  mkdirSync(local);
  writeFileSync(
    join(local, "pr-meta.env"),
    `PR_NUMBER=4242\nPR_AUTHOR=fixture\nPR_HEAD=topic\nPR_HEAD_SHA=${source}\n`,
  );
  writeFileSync(
    join(local, "prep-context.env"),
    `PR_NUMBER=4242\nPR_HEAD=topic\nPR_HEAD_SHA_BEFORE=${source}\nPREP_BRANCH=prep\nPREP_STARTED_AT=2026-09-07T00:00:00Z\n`,
  );
  writeFileSync(
    join(local, "gates.env"),
    `PR_NUMBER=4242\nGATES_MODE=full\nLAST_VERIFIED_HEAD_SHA=${candidate}\n`,
  );
  writeFileSync(join(local, "prep.md"), "# Prepare\n");
  writeFileSync(join(local, "events"), "");
  return { repoDir, remote, local, env, git, base, source, candidate, sameTree, advance };
}

function runPublisher(
  f: ReturnType<typeof makePublisherRepo>,
  command = "prepare_sync_head 4242",
  setup: string[] = [],
) {
  return runGatesBash(
    [
      `remote='${f.remote}'`,
      `enter_worktree() { PR_MAIN_SHA=${f.base}; }`,
      'resolve_head_push_url() { printf "%s\\n" "$remote"; }',
      'resolve_contributor_coauthor_email() { printf "fixture@example.invalid\\n"; }',
      'remote_head() { command git --git-dir="$remote" rev-parse refs/heads/topic; }',
      "gh() {",
      '  case "$*" in',
      '    *headRefName*) printf \'{"headRefName":"topic"}\\n\';;',
      "    *headRefOid*) remote_head;;",
      '    *) echo "unexpected GitHub request" >&2; return 98;;',
      "  esac",
      "}",
      'wait_for_pr_head_sha() { test "$(remote_head)" = "$2"; }',
      "run_prepare_push_retry_gates() { echo retry-gates >> .local/events; }",
      "git() {",
      '  case "$1" in',
      "    push) echo push >> .local/events;;",
      "    rebase) echo rebase >> .local/events;;",
      "  esac",
      '  command git "$@"',
      "}",
      "gh_plain() {",
      "  echo graphql >> .local/events",
      "  local payload expected hosted",
      '  test "$4" != "-" && test -f "$4" || return 1',
      '  payload=$(cat "$4") || return $?',
      "  expected=$(printf '%s' \"$payload\" | jq -r .variables.input.expectedHeadOid)",
      '  test "$expected" = "$(remote_head)" || return 75',
      '  hosted=$(command git commit-tree HEAD^{tree} -p "$expected" -m "Hosted verified commit")',
      '  command git push -q "$remote" "$hosted:refs/heads/topic" || return $?',
      '  printf \'{"data":{"createCommitOnBranch":{"commit":{"oid":"%s"}}}}\\n\' "$hosted"',
      "}",
      ...setup,
      command,
    ].join("\n"),
    { cwd: f.repoDir, env: f.env, sourcePrepareCore: true, sourcePush: true },
  );
}

describe("PR publication ownership", () => {
  it.each(
    ["prepare_push", "prepare_sync_head"].flatMap((operation) =>
      ["advance", "rewind", "same-tree"].map((movement) => ({ operation, movement })),
    ),
  )(
    "$operation refuses a foreign $movement observed before publication",
    ({ operation, movement }) => {
      const f = makePublisherRepo();
      const foreign =
        movement === "advance" ? f.advance : movement === "rewind" ? f.base : f.sameTree;
      f.git("push", "-q", "origin", `${foreign}:refs/heads/foreign`);
      f.git("--git-dir", f.remote, "update-ref", "refs/heads/topic", foreign);
      const before = readFileSync(join(f.local, "prep.md"), "utf8");
      const result = runPublisher(f, `${operation} 4242`);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(foreign);
      expect(f.git("rev-parse", "HEAD")).toBe(f.candidate);
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe("");
      expect(readFileSync(join(f.local, "prep.md"), "utf8")).toBe(before);
      expect(existsSync(join(f.local, "prep.env"))).toBe(false);
      expect(existsSync(join(f.local, "prepare-sync-result.env"))).toBe(false);
      expect(existsSync(join(f.local, "prepare-push-result.env"))).toBe(false);
    },
  );

  it.each(["advance", "rewind", "same-tree"] as const)(
    "keeps the original lease when a foreign %s races the push",
    (movement) => {
      const f = makePublisherRepo();
      const foreign =
        movement === "advance" ? f.advance : movement === "rewind" ? f.base : f.sameTree;
      f.git("push", "-q", "origin", `${foreign}:refs/heads/foreign`);
      const result = runPublisher(f, "prepare_push 4242", [
        "git() {",
        '  if [ "$1" = push ]; then',
        "    echo push >> .local/events",
        `    command git --git-dir="$remote" update-ref refs/heads/topic ${foreign}`,
        '  elif [ "$1" = rebase ]; then echo rebase >> .local/events; fi',
        '  command git "$@"',
        "}",
      ]);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(foreign);
      expect(f.git("rev-parse", "HEAD")).toBe(f.candidate);
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe("push\n");
      expect(existsSync(join(f.local, "prep.env"))).toBe(false);
      expect(existsSync(join(f.local, "prepare-push-result.env"))).toBe(false);
      expect(readFileSync(join(f.local, "gates.env"), "utf8")).toContain(
        `LAST_VERIFIED_HEAD_SHA=${f.candidate}`,
      );
    },
  );

  it.each(["readback", "fetch"] as const)(
    "does not stamp a same-tree replacement at the post-publication %s",
    (boundary) => {
      const f = makePublisherRepo();
      f.git("push", "-q", "origin", `${f.sameTree}:refs/heads/foreign`);
      const result = runPublisher(
        f,
        "prepare_sync_head 4242",
        boundary === "readback"
          ? [
              "wait_for_pr_head_sha() {",
              '  test "$(remote_head)" = "$2" || return 1',
              `  command git --git-dir="$remote" update-ref refs/heads/topic ${f.sameTree}`,
              "}",
            ]
          : [
              "git() {",
              '  if [ "$1" = push ]; then echo push >> .local/events; fi',
              '  if [ "$1" = fetch ]; then',
              `    command git --git-dir="$remote" update-ref refs/heads/topic ${f.sameTree}`,
              "  fi",
              '  command git "$@"',
              "}",
            ],
      );
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(f.sameTree);
      expect(f.git("rev-parse", "HEAD")).toBe(f.candidate);
      expect(existsSync(join(f.local, "prep.env"))).toBe(false);
      expect(existsSync(join(f.local, "prepare-sync-result.env"))).toBe(false);
    },
  );

  it("propagates the actual Git failure when invoked in a conditional", () => {
    const f = makePublisherRepo();
    const result = runPublisher(
      f,
      [
        `PRHEAD_REMOTE_URL='${f.remote}'`,
        'git() { if [ "$1" = push ]; then echo "transport failed" >&2; return 73; fi; command git "$@"; }',
        `if oid=$(push_prep_head_once topic ${f.source} ${f.candidate}); then exit 99; else status=$?; fi`,
        'test -z "$oid"',
        'exit "$status"',
      ].join("\n"),
    );
    expect(result.status, result.stdout + result.stderr).toBe(73);
    expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(f.source);
  });

  it("publishes appended fixups repeatedly using its own prior publication", () => {
    const f = makePublisherRepo();
    for (const command of ["prepare_push 4242", "prepare_sync_head 4242"]) {
      const result = runPublisher(f, command);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const published = f.git("rev-parse", "HEAD");
      expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(published);
      expect(readFileSync(join(f.local, "prep.env"), "utf8")).toContain(
        `PREP_HEAD_SHA=${published}\n`,
      );
      f.git("commit", "-qm", "another reviewed fixup", "--allow-empty");
    }
    expect(readFileSync(join(f.local, "events"), "utf8")).toBe("push\npush\n");
    expect(f.git("merge-base", f.source, "HEAD")).toBe(f.source);
  });

  it("accepts the exact candidate already published without another push", () => {
    const f = makePublisherRepo();
    f.git("--git-dir", f.remote, "update-ref", "refs/heads/topic", f.candidate);
    const result = runPublisher(f);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(join(f.local, "events"), "utf8")).toBe("");
    expect(readFileSync(join(f.local, "prep.env"), "utf8")).toContain(
      `PREP_HEAD_SHA=${f.candidate}\n`,
    );
  });

  it.each(["prepare_push", "prepare_sync_head"])(
    "%s rejects a same-tree no-op that lost reviewed ancestry",
    (operation) => {
      const f = makePublisherRepo();
      const foreign = f.git(
        "commit-tree",
        `${f.candidate}^{tree}`,
        "-p",
        f.base,
        "-m",
        "replaced reviewed ancestry",
      );
      f.git("checkout", "-B", "prep", foreign);
      f.git("push", "-q", "origin", `${foreign}:refs/heads/foreign`);
      f.git("--git-dir", f.remote, "update-ref", "refs/heads/topic", foreign);
      const before = readFileSync(join(f.local, "prep.md"), "utf8");
      const result = runPublisher(f, `${operation} 4242`);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(f.git("rev-parse", "HEAD")).toBe(foreign);
      expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(foreign);
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe("");
      expect(readFileSync(join(f.local, "prep.md"), "utf8")).toBe(before);
      expect(existsSync(join(f.local, "prep.env"))).toBe(false);
      expect(existsSync(join(f.local, "prepare-sync-result.env"))).toBe(false);
      expect(existsSync(join(f.local, "prepare-push-result.env"))).toBe(false);
    },
  );

  it("accepts the returned GraphQL OID but requires later fixups to extend it", () => {
    const f = makePublisherRepo();
    const graphql = [
      "PR_HEAD_OWNER=fixture",
      "PR_HEAD_REPO_NAME=repo",
      "OPENCLAW_PR_PUSH_MODE=graphql",
    ];
    const first = runPublisher(f, "prepare_sync_head 4242", graphql);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const hosted = f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic");
    expect(hosted).not.toBe(f.candidate);
    expect(f.git("rev-parse", `${hosted}^{tree}`)).toBe(f.git("rev-parse", "HEAD^{tree}"));
    let receipt = readFileSync(join(f.local, "prep.env"), "utf8");
    expect(receipt).toContain(`PREP_HEAD_SHA=${hosted}\n`);
    expect(receipt).toContain(`LOCAL_PREP_HEAD_SHA=${f.candidate}\n`);
    const noop = runPublisher(f, "prepare_sync_head 4242", graphql);
    expect(noop.status, noop.stdout + noop.stderr).toBe(0);
    expect(readFileSync(join(f.local, "events"), "utf8")).toBe("graphql\n");
    receipt = readFileSync(join(f.local, "prep.env"), "utf8");
    f.git("commit", "-qm", "fixup on the unhosted local commit", "--allow-empty");
    const rejected = runPublisher(f, "prepare_sync_head 4242", graphql);
    expect(rejected.status, rejected.stdout + rejected.stderr).not.toBe(0);
    expect(readFileSync(join(f.local, "prep.env"), "utf8")).toBe(receipt);
    f.git("checkout", "-B", "prep", hosted);
    f.git("commit", "-qm", "fixup on the hosted commit", "--allow-empty");
    const accepted = runPublisher(f, "prepare_sync_head 4242", graphql);
    expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
    expect(readFileSync(join(f.local, "events"), "utf8")).toBe("graphql\ngraphql\n");
  });

  it.each(["git-permission", "git-failure", "graphql-permission"] as const)(
    "limits transport fallback for %s",
    (failure) => {
      const f = makePublisherRepo();
      const result = runPublisher(f, "prepare_sync_head 4242", [
        "PR_HEAD_OWNER=fixture",
        "PR_HEAD_REPO_NAME=repo",
        ...(failure === "graphql-permission"
          ? [
              "OPENCLAW_PR_PUSH_MODE=graphql",
              'gh_plain() { echo graphql >> .local/events; echo "403 forbidden" >&2; return 74; }',
            ]
          : [
              "git() {",
              '  if [ "$1" = push ]; then',
              "    echo push >> .local/events",
              failure === "git-permission"
                ? '    echo "403 permission denied" >&2'
                : '    echo "transport failed" >&2',
              "    return 73",
              "  fi",
              '  command git "$@"',
              "}",
            ]),
      ]);
      if (failure === "git-permission") {
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(readFileSync(join(f.local, "events"), "utf8")).toBe("push\ngraphql\n");
      } else {
        expect(result.status, result.stdout + result.stderr).not.toBe(0);
        expect(readFileSync(join(f.local, "events"), "utf8")).toBe(
          failure === "git-failure" ? "push\n" : "graphql\n",
        );
        expect(existsSync(join(f.local, "prep.env"))).toBe(false);
      }
    },
  );

  it.each(["number", "branch", "source", "local-tree"] as const)(
    "rejects a prior receipt with mismatched %s provenance",
    (mismatch) => {
      const f = makePublisherRepo();
      const first = runPublisher(f);
      expect(first.status, first.stdout + first.stderr).toBe(0);
      const path = join(f.local, "prep.env");
      const before = readFileSync(path, "utf8");
      const changes = {
        number: ["PR_NUMBER=4242", "PR_NUMBER=4243"],
        branch: ["PR_HEAD=topic", "PR_HEAD=other"],
        source: [`PR_HEAD_SHA_BEFORE=${f.source}`, `PR_HEAD_SHA_BEFORE=${f.base}`],
        "local-tree": [`LOCAL_PREP_HEAD_SHA=${f.candidate}`, `LOCAL_PREP_HEAD_SHA=${f.source}`],
      } as const;
      const [from, to] = changes[mismatch];
      const changed = before.replace(from, to);
      expect(changed).not.toBe(before);
      writeFileSync(path, changed);
      f.git("commit", "-qm", "appended fixup", "--allow-empty");
      const result = runPublisher(f);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(readFileSync(path, "utf8")).toBe(changed);
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe("push\n");
      expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(f.candidate);
    },
  );
});

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

  it("records only trusted publisher metadata after synchronous success", () => {
    const dir = tempDirs.make("openclaw-pr-gates-aws-publisher-");
    const workDir = join(dir, "work");
    mkdirSync(workDir);
    mkdirSync(join(workDir, ".local"));
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    const runUrl = "https://github.com/openclaw/openclaw/actions/runs/99";

    const result = runGatesBash(
      [
        "require_active_org_admin_for_crabbox_gate() { :; }",
        `read_crabbox_gate_pr_binding() { printf '%s\\n' '${base}'; }`,
        "ci_dispatch() {",
        `  printf '%s\\n' '${JSON.stringify({
          actionsRunUrl: runUrl,
          backend: "crabbox",
          baseSha: base,
          headSha: head,
          leaseId: "cbx_stub",
          provider: "aws",
          runId: "run_stub",
          target: "linux",
        })}'`,
        "}",
        `finalize_remote_crabbox_aws_gate 424242 '${head}'`,
        "cat .local/gates.env",
      ].join("\n"),
      { cwd: workDir },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("GATES_MODE=remote_crabbox_aws");
    expect(result.stdout).toContain(`FULL_GATES_HEAD_SHA=${head}`);
    expect(result.stdout).toContain("REMOTE_GATES_PROVIDER=aws");
    expect(result.stdout).toContain("REMOTE_GATES_RUN_ID=run_stub");
    expect(result.stdout).toContain("REMOTE_GATES_LEASE_ID=cbx_stub");
    expect(result.stdout).toContain(`REMOTE_GATES_RUN_URL=${runUrl}`);
  });

  it("keeps pending evidence when the protected publisher fails", () => {
    const workDir = join(tempDirs.make("openclaw-pr-gates-aws-failure-"), "work");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(join(workDir, ".local"));
    writeFileSync(join(workDir, ".local/gates.env"), "GATES_MODE=remote_crabbox_aws_pending\n");
    const result = runGatesBash(
      [
        "require_active_org_admin_for_crabbox_gate() { :; }",
        `read_crabbox_gate_pr_binding() { printf '%s\\n' '${"a".repeat(40)}'; }`,
        "ci_dispatch() { return 1; }",
        `finalize_remote_crabbox_aws_gate 424242 '${"b".repeat(40)}'`,
      ].join("\n"),
      { cwd: workDir },
    );
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(workDir, ".local/gates.env"), "utf8")).toBe(
      "GATES_MODE=remote_crabbox_aws_pending\n",
    );
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
        `PR_MAIN_SHA=${"a".repeat(40)}`,
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
        `PR_MAIN_SHA=${"a".repeat(40)}`,
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
        "PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false corepack pnpm test",
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

describe("prepare author access snapshot", () => {
  it.each([
    ["admin", "maintainer"],
    ["write", "maintainer"],
    ["read", "external"],
    ["none", "external"],
    ["maintain", "unknown"],
  ])("maps GitHub permission %s to %s", (permission, expected) => {
    const result = runGatesBash(
      [
        "gh() {",
        '  if [ "$1 $2" = "repo view" ]; then printf "fixture/repo\\n";',
        `  else printf '{"permission":"${permission}"}\\n'; fi`,
        "}",
        "resolve_pr_author_access_at_prepare fixture",
      ].join("\n"),
      { sourcePrepareCore: true },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  it.each(["error", "malformed"])("maps %s permission evidence to unknown", (mode) => {
    const result = runGatesBash(
      [
        "gh() {",
        '  if [ "$1 $2" = "repo view" ]; then printf "fixture/repo\\n";',
        mode === "error" ? "  else return 1; fi" : "  else printf '{}\\n'; fi",
        "}",
        "resolve_pr_author_access_at_prepare fixture",
      ].join("\n"),
      { sourcePrepareCore: true },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("unknown");
  });
});

describe("prepare sync-head transitions", () => {
  it("publishes only appended fixups when main advances", () => {
    const repoDir = makeSyncRepo({ needsRebase: true });
    const contextPath = join(repoDir, ".local", "prep-context.env");
    writeFileSync(
      contextPath,
      `${readFileSync(contextPath, "utf8")}PR_AUTHOR_ACCESS_AT_PREP=external\n`,
    );
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
        "grep -F 'PREP_REPLACED_HOSTED_ANCESTRY=false' .local/prep.env",
        "grep -F 'PREP_AUTHOR_ACCESS=external' .local/prep.env",
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
        "refresh_main_snapshot() { PR_MAIN_SHA=$(git rev-parse --verify refs/remotes/origin/main); }",
        "enter_worktree() { refresh_main_snapshot; }",
        `reviewed_head='${reviewedHead}'`,
        'gh() { printf "%s\\n" "$reviewed_head"; }',
        "verify_pr_head_branch_matches_expected() { :; }",
        "prepare_gates() {",
        "  touch .local/gates-reran",
        "  printf 'DOCS_ONLY=false\\nGATES_MODE=fresh\\n' > .local/gates.env",
        "}",
        "push_prep_head_to_pr_branch() {",
        '  local result_env="$5"',
        '  printf \'PUSH_PREP_HEAD_SHA=%q\\nPUSH_LOCAL_PREP_HEAD_SHA=%q\\nPUSHED_FROM_SHA=%q\\nPUSH_REPLACED_HOSTED_ANCESTRY=false\\nPR_HEAD_SHA_AFTER_PUSH=%q\\n\' "$3" "$3" "$reviewed_head" "$3" > "$result_env"',
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
  it("classifies appended and replaced hosted ancestry without tree heuristics", () => {
    const { repoDir, headSha } = makeRetryRepo();
    spawnSync("git", ["commit", "-qm", "appended", "--allow-empty"], { cwd: repoDir });
    const appendedHead = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();
    const tree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();
    const replacedHead = spawnSync("git", ["-c", "commit.gpgsign=false", "commit-tree", tree], {
      cwd: repoDir,
      input: "replacement\n",
      encoding: "utf8",
    }).stdout.trim();

    const result = runGatesBash(
      [
        `test "$(classify_replaced_hosted_ancestry ${headSha} ${appendedHead})" = false`,
        `test "$(classify_replaced_hosted_ancestry ${headSha} ${replacedHead})" = true`,
        `! classify_replaced_hosted_ancestry ${headSha} deadbeef 2>.local/ancestry-error`,
        "grep -F 're-run prepare-init' .local/ancestry-error",
      ].join("\n"),
      { cwd: repoDir, sourcePush: true },
    );

    expect(result.status, result.stderr).toBe(0);
  });

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
        'gh_plain() { cp "$4" .local/graphql-payload.json; printf \'%s\\n\' \'{"data":{"createCommitOnBranch":{"commit":{"oid":"signed-head","url":"https://example.test/commit"}}}}\'; }',
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
        "PR_MAIN_SHA=$(git rev-parse HEAD)",
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
        "PR_MAIN_SHA=$(git rev-parse HEAD)",
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
        "PR_MAIN_SHA=$(git rev-parse HEAD)",
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
        "enter_worktree() { PR_MAIN_SHA=$(git rev-parse --verify refs/remotes/origin/main); }",
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
        "enter_worktree() { PR_MAIN_SHA=$(git rev-parse --verify refs/remotes/origin/main); }",
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
