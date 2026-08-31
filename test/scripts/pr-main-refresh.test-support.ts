import { spawnSync } from "node:child_process";
import {
  chmodSync,
  constants as fsConstants,
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const templateDirs = useAutoCleanupTempDirTracker(afterAll);
let fixtureTemplate: ReturnType<typeof createMainRefreshTemplate> | undefined;

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function createFixtureGit(root: string) {
  const home = join(root, "home");
  mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    XDG_CONFIG_HOME: join(home, ".config"),
  };
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  function git(cwd: string, ...args: string[]) {
    const result = spawnSync(realGit, args, { cwd, env, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    }
    return result.stdout.trim();
  }
  return { env, realGit, git };
}

function createMainRefreshTemplate(directory: string) {
  const root = realpathSync(directory);
  const canonical = join(root, "canonical");
  const origin = join(root, "origin.git");
  const { git } = createFixtureGit(root);
  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "init", "-b", "main", canonical);
  git(canonical, "config", "user.name", "OpenClaw Test");
  git(canonical, "config", "user.email", "test@example.invalid");
  git(canonical, "config", "core.hooksPath", "/dev/null");
  git(canonical, "config", "extensions.worktreeConfig", "true");
  mkdirSync(join(canonical, "scripts"));
  for (const item of [
    "pr",
    "pr-lib",
    "lib",
    "tsx.mjs",
    "verify-pr-hosted-gates.mjs",
    "verify-pr-hosted-gates.mts",
    "watch-pr-ci.mjs",
    "watch-pr-ci.mts",
    "crabbox-untrusted-bootstrap.sh",
    "pr-crabbox-gate-publisher.mjs",
  ]) {
    cpSync(join(process.cwd(), "scripts", item), join(canonical, "scripts", item), {
      recursive: true,
    });
  }
  cpSync(join(process.cwd(), ".github", "workflows"), join(canonical, ".github", "workflows"), {
    recursive: true,
  });
  writeFileSync(join(canonical, "package.json"), '{"type":"module"}\n');
  cpSync(join(process.cwd(), "tsconfig.json"), join(canonical, "tsconfig.json"));
  cpSync(
    join(process.cwd(), "packages", "normalization-core"),
    join(canonical, "packages", "normalization-core"),
    { recursive: true },
  );
  writeFileSync(join(canonical, ".gitignore"), ".worktrees/\n.local/\nnode_modules\n");
  mkdirSync(join(canonical, "src"));
  writeFileSync(join(canonical, "src", "subject.ts"), "export const subject = 'base';\n");
  git(canonical, "add", ".");
  git(canonical, "commit", "-qm", "test: trusted native wrapper");
  const main = git(canonical, "rev-parse", "HEAD");
  git(canonical, "remote", "add", "origin", "../origin.git");
  git(canonical, "push", "origin", "main");
  git(canonical, "checkout", "-qb", "topic");
  writeFileSync(join(canonical, "src", "subject.ts"), "export const subject = 'reviewed';\n");
  git(canonical, "commit", "-qam", "test: reviewed change");
  const head = git(canonical, "rev-parse", "HEAD");
  git(canonical, "commit", "--allow-empty", "-qm", "test: different commit with identical tree");
  const sameTreeHead = git(canonical, "rev-parse", "HEAD");
  git(canonical, "update-ref", "refs/heads/topic", head);
  git(canonical, "push", "origin", "topic", `${head}:refs/pull/42/head`);
  git(canonical, "checkout", "-q", "main");
  writeFileSync(join(canonical, "src", "subject.ts"), "export const subject = 'main moved';\n");
  git(canonical, "commit", "-qam", "test: main movement");
  const movedMain = git(canonical, "rev-parse", "HEAD");
  git(canonical, "commit", "--allow-empty", "-qm", "test: publication checkpoint movement");
  const gateMain = git(canonical, "rev-parse", "HEAD");
  git(canonical, "push", "origin", `${gateMain}:refs/heads/gate-movement`);
  git(canonical, "push", "origin", `${movedMain}:refs/heads/movement`);
  git(canonical, "checkout", "--detach", main);
  return { canonical, origin, main, head, sameTreeHead, movedMain, gateMain };
}

// Keep the complete wrapper/lock/entry/gate owners. Command resolution, Git
// transport faults, and GitHub responses are synthetic.
export function createMainRefreshFixture(directory: string) {
  const template = (fixtureTemplate ??= createMainRefreshTemplate(
    templateDirs.make("openclaw-pr-main-refresh-template-"),
  ));
  const root = realpathSync(directory);
  const canonical = join(root, "canonical");
  const origin = join(root, "origin.git");
  const worktree = join(canonical, ".worktrees", "pr-42");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const { env, realGit, git } = createFixtureGit(root);
  const { main, head, sameTreeHead, movedMain, gateMain } = template;
  // Copy complete object stores (including sameTreeHead), never shared refs or
  // hardlinks. Create worktrees afterward so their absolute back-links stay local.
  const copyOptions = { recursive: true, mode: fsConstants.COPYFILE_FICLONE };
  cpSync(template.canonical, canonical, copyOptions);
  cpSync(template.origin, origin, copyOptions);
  git(canonical, "remote", "set-url", "origin", origin);
  git(canonical, "config", `url.${origin}.insteadOf`, "https://github.com/fixture/repo");
  git(
    canonical,
    "config",
    "--add",
    `url.${origin}.insteadOf`,
    "https://github.com/fixture/repo.git",
  );
  git(canonical, "worktree", "add", "--detach", worktree, head);
  symlinkSync(join(process.cwd(), "node_modules"), join(canonical, "node_modules"), "dir");
  const local = join(worktree, ".local");
  mkdirSync(local);
  const metadata = {
    id: "fixture-pr",
    number: 42,
    title: "Synthetic reviewed change",
    url: "https://github.com/fixture/repo/pull/42",
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    mergeCommit: null,
    autoMergeRequest: null,
    isInMergeQueue: false,
    isMergeQueueEnabled: false,
    isDraft: false,
    isCrossRepository: false,
    author: { login: "fixture" },
    baseRefName: "main",
    baseRefOid: main,
    headRefName: "topic",
    headRefOid: head,
    headRepository: { name: "repo", nameWithOwner: "fixture/repo", url: origin },
    headRepositoryOwner: { login: "fixture" },
    changedFiles: 1,
    additions: 1,
    deletions: 1,
    files: [{ path: "src/subject.ts", additions: 1, deletions: 1, changeType: "MODIFIED" }],
  };
  writeFileSync(join(local, "pr-meta.json"), JSON.stringify(metadata));
  writeFileSync(
    join(local, "pr-meta.env"),
    `PR_NUMBER=42\nPR_URL=https://example.invalid/pr/42\nPR_AUTHOR=fixture\nPR_BASE=main\nPR_HEAD=topic\nPR_HEAD_SHA=${head}\nPR_HEAD_REPO_URL=${origin}\n`,
  );
  writeFileSync(join(local, "review-mode.env"), "REVIEW_MODE=pr\n");
  writeFileSync(
    join(local, "review.md"),
    [
      `Review artifact for PR #42 at ${head}`,
      ..."ABCDEFGHIJ".split("").map((letter) => `${letter}) Synthetic evidence.`),
    ].join("\n"),
  );
  writeFileSync(
    join(local, "review.json"),
    JSON.stringify({
      pr: { number: 42, headSha: head },
      recommendation: "READY FOR /prepare-pr",
      findings: [],
      nitSweep: { performed: true, status: "none", summary: "No optional nits." },
      behavioralSweep: {
        performed: true,
        status: "pass",
        summary: "Synthetic tooling fixture.",
        silentDropRisk: "none",
        branches: [
          {
            path: "src/subject.ts",
            decision: "synthetic change",
            outcome: "reviewed fixture value",
          },
        ],
      },
      issueValidation: {
        performed: true,
        source: "pr_body",
        status: "valid",
        summary: "Synthetic fixture.",
      },
      tests: { ran: ["synthetic local proof"], gaps: [], result: "pass" },
      docs: "not_applicable",
      changelog: "not_required",
    }),
  );
  const controlFile = join(root, "control.json");
  const eventsFile = join(root, "events.jsonl");
  const control = {
    metadata,
    authorPermission: "write",
    failFetch: false,
    failFetchAt: 0,
    pauseFetchAt: 0,
    failAuth: false,
    moveAfterFirstFetch: false,
    moveAtGate: false,
    moveAtChecks: false,
    moveAtCi: false,
    moveSharedAfterFetch: false,
    remoteOnlyBase: "",
    hostedCi: "scheduled" as
      | "scheduled"
      | "release"
      | "missing"
      | "stale"
      | "failed"
      | "wrong-head"
      | "unmarked"
      | "wrong-workflow"
      | "scheduled-failure"
      | "api-error",
    requiredChecks: "pass" as "pass" | "fail" | "pending" | "api-error",
  };
  writeFileSync(controlFile, JSON.stringify(control));
  writeFileSync(eventsFile, "");
  const prelude = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const controlFile = ${JSON.stringify(controlFile)};
const eventsFile = ${JSON.stringify(eventsFile)};
const control = JSON.parse(readFileSync(controlFile, 'utf8'));
const args = process.argv.slice(2);
const git = ${JSON.stringify(realGit)};
const origin = ${JSON.stringify(origin)};
const canonical = ${JSON.stringify(canonical)};
const movedMain = ${JSON.stringify(movedMain)};

function event(value) {
  appendFileSync(eventsFile, JSON.stringify(value) + '\\n');
}

function runGit(args, input) {
  const result = spawnSync(git, args, { encoding: 'utf8', input });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
`;
  const instrumentedGit = join(bin, "git-instrumented.mjs");
  writeFileSync(
    instrumentedGit,
    prelude +
      `
const mainFetch = args.includes('fetch') && args.some(arg =>
  arg === 'main' || arg.startsWith('+refs/heads/main:') || arg === 'refs/heads/main'
);
if (mainFetch) {
  event({ kind: 'main-fetch', cwd: process.cwd(), args });
  const count = readFileSync(eventsFile, 'utf8').trim().split('\\n')
    .filter(line => JSON.parse(line).kind === 'main-fetch').length;
  if (control.failFetch || control.failFetchAt === count) {
    console.error('fatal: injected main fetch failure');
    process.exit(128);
  }
  if (control.pauseFetchAt === count) {
    args.splice(args.indexOf('fetch') + 1, 0,
      ${JSON.stringify(`--upload-pack=${join(root, "hold-upload-pack")}`)});
  }
}
if (args.some(arg => ['merge-base', 'diff', 'checkout', 'update-ref'].includes(arg))) {
  event({ kind: 'git-decision', args });
}
if (args.includes('push')) {
  const cleanup = ['push', '--force-with-lease=refs/heads/topic:' + control.metadata.headRefOid,
    'https://github.com/fixture/repo.git', ':refs/heads/topic'];
  if (JSON.stringify(args) !== JSON.stringify(cleanup)) {
    event({ kind: 'unexpected-push', args });
    process.exit(98);
  }
  event({ kind: 'leased-cleanup', args });
}
const result = spawnSync(git, args, { stdio: 'inherit' });
if (mainFetch && result.status === 0) {
  const prefix = args.slice(0, args.indexOf('fetch'));
  const fetched = runGit([...prefix, 'rev-parse', 'FETCH_HEAD']);
  if (control.moveSharedAfterFetch) {
    runGit(['-C', canonical, 'update-ref', 'refs/remotes/origin/main', movedMain]);
  }
  if (control.moveAfterFirstFetch) {
    runGit(['-C', origin, 'update-ref', 'refs/heads/main', movedMain]);
    control.moveAfterFirstFetch = false;
    writeFileSync(controlFile, JSON.stringify(control));
  }
  event({
    kind: 'fetched',
    sha: fetched,
    shared: runGit(['-C', canonical, 'rev-parse', 'refs/remotes/origin/main']),
  });
}
process.exit(result.status ?? 1);
`,
  );
  // Scan every argument like the Node shim, including values after -C/-c prefixes.
  // Unobserved queries can execute real Git directly without starting another Node process.
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    fetch|merge-base|diff|checkout|update-ref|push)
      exec ${shellQuote(process.execPath)} ${shellQuote(instrumentedGit)} "$@" ;;
  esac
done
exec ${shellQuote(realGit)} "$@"
`,
  );
  writeFileSync(
    join(bin, "gh"),
    prelude +
      `
event({ kind: 'gh', args });
let value;
if (args[0] === 'auth') process.exit(1);
if (args[0] === 'pr' && args[1] === 'view') {
  value = control.metadata;
} else if (args[0] === 'pr' && args[1] === 'merge') {
  if (!args.includes('--match-head-commit') || !args.includes(control.metadata.headRefOid)) {
    throw new Error('Unpinned synthetic merge');
  }
  const parent = runGit(['-C', origin, 'rev-parse', 'refs/heads/main']);
  const tree = runGit(['-C', origin, 'merge-tree', '--write-tree', parent, control.metadata.headRefOid]);
  const landed = runGit(['-C', origin, '-c', 'user.name=Fixture', '-c',
    'user.email=fixture@example.invalid', 'commit-tree', tree, '-p', parent], 'Fixture squash\\n');
  runGit(['-C', origin, 'update-ref', 'refs/heads/main', landed, parent]);
  control.metadata.state = 'MERGED';
  control.metadata.mergeCommit = { oid: landed };
  writeFileSync(controlFile, JSON.stringify(control));
  value = {};
} else if (args[0] === 'pr' && args[1] === 'checks') {
  if (control.moveAtChecks) {
    runGit(['-C', origin, 'update-ref', 'refs/heads/main', movedMain]);
  }
  event({ kind: 'required-checks' });
  if (control.requiredChecks === 'api-error') {
    console.error('GitHub API unavailable');
    process.exit(1);
  }
  value = [{ name: 'openclaw/ci-gate', bucket: 'pass', state: 'SUCCESS' }];
  if (control.requiredChecks !== 'pass') value.push({
    name: 'independent required check', bucket: control.requiredChecks,
    state: control.requiredChecks === 'pending' ? 'IN_PROGRESS' : 'FAILURE',
  });
} else if (args[0] === 'repo' && args[1] === 'view') {
  value = { id: 'fixture-repo', nameWithOwner: 'fixture/repo', url: 'https://github.com/fixture/repo' };
} else if (args[0] === 'run' && args[1] === 'view') {
  if (control.moveAtCi) {
    runGit(['-C', origin, 'update-ref', 'refs/heads/main', movedMain]);
  }
  event({ kind: 'ci-completed' });
  value = control.hostedCi === 'scheduled'
    ? { status: 'completed', conclusion: 'success' }
    : { status: 'in_progress', conclusion: null };
} else if (args[0] === 'run' && args[1] === 'list') {
  value = [];
} else if (args[0] === 'api') {
  const endpoint = args.find((arg, index) => index > 0 &&
    (arg === 'graphql' || arg === 'users/fixture' || arg.startsWith('repos/')));
  if (endpoint === 'graphql') {
    if (control.failAuth) process.exit(1);
    if (args.some(arg => arg.includes('viewer { login }'))) {
      value = { data: { viewer: { login: 'fixture' } } };
    } else if (args.some(arg => arg.includes('ref(qualifiedName:'))) {
      value = { data: { repository: {
        id: 'fixture-repo', nameWithOwner: 'fixture/repo', url: 'https://github.com/fixture/repo',
        ref: { target: { oid: runGit(['-C', origin, 'rev-parse', 'refs/heads/main']) } },
        pullRequest: control.metadata,
      } } };
    } else {
      throw new Error('Unexpected GraphQL request');
    }
  } else if (endpoint === 'users/fixture') {
    value = { id: 123 };
  } else if (endpoint === 'repos/fixture/repo/collaborators/fixture/permission') {
    if (control.authorPermission === 'error') process.exit(1);
    value = { permission: control.authorPermission };
  } else if (endpoint === 'repos/fixture/repo/issues/42/comments' && args.includes('POST')) {
    value = { html_url: 'https://example.invalid/pr/42#completion' };
  } else if (endpoint === 'repos/fixture/repo/pulls/42') {
    let baseSha = control.metadata.baseRefOid;
    if (control.remoteOnlyBase) {
      baseSha = control.remoteOnlyBase;
      runGit(['-C', origin, 'update-ref', 'refs/heads/main', baseSha]);
      const localObject = spawnSync(git, ['-C', canonical, 'cat-file', '-e', baseSha]);
      event({ kind: 'remote-only-base', sha: baseSha, localObject: localObject.status === 0 });
    }
    value = {
      head: { sha: control.metadata.headRefOid, ref: 'topic', repo: { full_name: 'fixture/repo' } },
      base: { sha: baseSha },
    };
  } else if (endpoint.endsWith('/actions/workflows/ci.yml/runs')) {
    event({ kind: 'ci-watched' });
    value = { workflow_runs: [{ id: 1, conclusion: null }] };
  } else if (endpoint.includes('/actions/runs/1/attempts/1/jobs?')) {
    value = { total_count: 2, jobs: ['macos-node', 'macos-swift'].map(name => ({
      name, run_id: 1, run_attempt: 1, status: 'queued', conclusion: null,
      runner_id: null, steps: [],
    })) };
  } else if (endpoint === 'repos/fixture/repo/actions/runs/1') {
    value = { run_attempt: 1, status: 'in_progress', conclusion: null };
  } else if (/^repos\\/(fixture\\/repo|openclaw\\/openclaw)\\/actions\\/runs\\?/.test(endpoint)) {
    if (control.moveAtGate) {
      runGit(['-C', origin, 'update-ref', 'refs/heads/main', ${JSON.stringify(gateMain)}]);
    }
    event({ kind: 'hosted-gate' });
    if (control.hostedCi === 'api-error') throw new Error('Hosted API unavailable');
    const workflows = [
      'CI', 'Blacksmith Testbox', 'Blacksmith ARM Testbox',
      'Blacksmith Build Artifacts Testbox', 'Workflow Sanity',
    ];
    value = {
      total_count: workflows.length,
      workflow_runs: workflows.map((name, index) => ({
        id: index + 1,
        name,
        event: 'pull_request',
        head_sha: control.metadata.headRefOid,
        status: 'completed',
        conclusion: 'success',
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      })),
    };
    if (control.hostedCi !== 'scheduled') {
      Object.assign(value.workflow_runs[0], {
        status: control.hostedCi === 'scheduled-failure' ? 'completed' : 'in_progress',
        conclusion: control.hostedCi === 'scheduled-failure' ? 'failure' : null,
      });
      if (control.hostedCi !== 'missing') value.workflow_runs.push({
        id: 6, run_number: 6, name: 'CI', event: 'workflow_dispatch',
        head_sha: control.hostedCi === 'wrong-head' ? ${JSON.stringify(main)} : control.metadata.headRefOid,
        path: control.hostedCi === 'wrong-workflow' ? '.github/workflows/other.yml' : '.github/workflows/ci.yml',
        display_title: control.hostedCi === 'unmarked' ? 'CI' : 'CI release gate ' + control.metadata.headRefOid,
        status: 'completed', conclusion: control.hostedCi === 'failed' ? 'failure' : 'success',
        updated_at: new Date(Date.now() - (control.hostedCi === 'stale' ? 25 * 3600_000 : 0)).toISOString(),
        created_at: new Date().toISOString(),
      });
      value.total_count = value.workflow_runs.length;
    }
  } else {
    throw new Error('Unexpected GitHub API endpoint ' + endpoint);
  }
} else {
  throw new Error('Unexpected GitHub command ' + args.join(' '));
}
const jqIndex = args.indexOf('--jq');
if (jqIndex >= 0) {
  const result = spawnSync('jq', ['-r', args[jqIndex + 1]], {
    input: JSON.stringify(value),
    encoding: 'utf8',
  });
  process.stdout.write(result.stdout);
  process.exit(result.status ?? 1);
}
console.log(JSON.stringify(value));
    `,
  );
  writeFileSync(
    join(bin, "rg"),
    `#!/bin/sh
exec grep "$@"
`,
  );
  for (const command of ["git", "gh", "rg"]) {
    chmodSync(join(bin, command), 0o755);
  }
  env.PATH = `${bin}${delimiter}${env.PATH ?? ""}`;
  env.OPENCLAW_GH_BIN = join(bin, "gh");
  env.OPENCLAW_TESTBOX = "1";
  // Advance only the real watcher's polling clock, so a stuck CI fixture
  // reaches its normal deadline without an hour-long regression test.
  const clock = join(root, "watch-clock.mjs");
  writeFileSync(
    clock,
    `
import { syncBuiltinESMExports } from 'node:module';
import timers from 'node:timers/promises';
if (process.argv[1]?.endsWith('/watch-pr-ci.mts')) {
  const realNow = Date.now;
  let waited = 0;
  Date.now = () => realNow() + waited;
  timers.setTimeout = async milliseconds => { waited += milliseconds; };
  syncBuiltinESMExports();
}
`,
  );
  return {
    root,
    canonical,
    origin,
    worktree,
    local,
    head,
    sameTreeHead,
    main,
    movedMain,
    gateMain,
    env,
    git,
    metadata,
    configure(update: Partial<typeof control>) {
      Object.assign(control, update);
      if (control.hostedCi === "scheduled") delete env.NODE_OPTIONS;
      else env.NODE_OPTIONS = `--import=${clock}`;
      writeFileSync(controlFile, JSON.stringify(control));
    },
    events() {
      return readFileSync(eventsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (
            line,
          ): {
            kind: string;
            sha?: string;
            shared?: string;
            args?: string[];
            localObject?: boolean;
          } => JSON.parse(line),
        );
    },
    run(command: string | string[], bash = "bash", from = canonical) {
      const args = typeof command === "string" ? [command, "42"] : command;
      return spawnSync(bash, [join(from, "scripts", "pr"), ...args], {
        cwd: from,
        env,
        encoding: "utf8",
      });
    },
    shell(command: string, bash = "bash") {
      return spawnSync(
        bash,
        [
          "-c",
          `set -euo pipefail\nscript_parent_dir="$1/scripts"\nsource "$script_parent_dir/lib/plain-gh.sh"\nfor library in worktree operation-lock common changelog gates push review prepare-core merge; do source "$script_parent_dir/pr-lib/$library.sh"; done\n${command}`,
          "fixture",
          canonical,
        ],
        { cwd: canonical, env, encoding: "utf8" },
      );
    },
  };
}
