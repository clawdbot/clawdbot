import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = process.cwd();
const commonScript = join(repoRoot, "scripts/pr-lib/common.sh");
const worktreeScript = join(repoRoot, "scripts/pr-lib/worktree.sh");
const reviewScript = join(repoRoot, "scripts/pr-lib/review.sh");
const describePosix = process.platform === "win32" ? describe.skip : describe;

type Fixture = {
  root: string;
  mainSha: string;
  siblingBranch: string;
  siblingSha: string;
};

type ReviewFixture = Fixture & {
  prASha: string;
  prBSha: string;
};

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function createFixture(): Fixture {
  const root = tempDirs.make("openclaw-pr-worktree-containment-");
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "OpenClaw Test");
  git(root, "config", "user.email", "test@openclaw.invalid");
  writeFileSync(join(root, "fixture.txt"), "main\n");
  git(root, "add", "fixture.txt");
  git(root, "commit", "-m", "main fixture");
  const mainSha = git(root, "rev-parse", "HEAD");
  git(root, "remote", "add", "origin", root);
  git(root, "fetch", "origin");
  git(root, "checkout", "-b", "sibling/work");
  writeFileSync(join(root, "fixture.txt"), "sibling\n");
  git(root, "commit", "-am", "sibling fixture");
  return {
    root,
    mainSha,
    siblingBranch: git(root, "branch", "--show-current"),
    siblingSha: git(root, "rev-parse", "HEAD"),
  };
}

function createReviewFixture(): ReviewFixture {
  const root = tempDirs.make("openclaw-pr-review-transition-");
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "OpenClaw Test");
  git(root, "config", "user.email", "test@openclaw.invalid");
  writeFileSync(join(root, "transition-a.txt"), "base-a\n");
  writeFileSync(join(root, "transition-b.txt"), "base-b\n");
  writeFileSync(join(root, "overlap.txt"), "base-overlap\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "base fixture");
  const baseSha = git(root, "rev-parse", "HEAD");

  git(root, "checkout", "-b", "review/pr", baseSha);
  writeFileSync(join(root, "transition-a.txt"), "pr-a\n");
  writeFileSync(join(root, "transition-b.txt"), "pr-b\n");
  writeFileSync(join(root, "overlap.txt"), "pr-a-overlap\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "PR head A");
  const prASha = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "overlap.txt"), "pr-b-overlap\n");
  git(root, "commit", "-am", "PR head B");
  const prBSha = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/pull/42/head", prASha);

  git(root, "checkout", "main");
  writeFileSync(join(root, "main-only.txt"), "main-only\n");
  git(root, "add", "main-only.txt");
  git(root, "commit", "-m", "advance main fixture");
  const mainSha = git(root, "rev-parse", "HEAD");
  git(root, "remote", "add", "origin", root);
  git(root, "fetch", "origin");

  git(root, "checkout", "-b", "sibling/work");
  writeFileSync(join(root, "sibling.txt"), "sibling\n");
  git(root, "add", "sibling.txt");
  git(root, "commit", "-m", "sibling fixture");
  return {
    root,
    mainSha,
    prASha,
    prBSha,
    siblingBranch: git(root, "branch", "--show-current"),
    siblingSha: git(root, "rev-parse", "HEAD"),
  };
}

function makeStaleWorktreeDir(fixture: Fixture) {
  mkdirSync(join(fixture.root, ".worktrees", "pr-42"), { recursive: true });
}

function runShell(fixture: Fixture, commands: string[]) {
  return spawnSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        'source "$1"',
        'source "$2"',
        'source "$3"',
        'fixture_root="$4"',
        'repo_root() { printf "%s\\n" "$fixture_root"; }',
        "ensure_gh_api_auth() { :; }",
        "mark_pr_operation_side_effects_started() { :; }",
        'pr_meta_json() { local head; head=$(git rev-parse refs/pull/42/head); jq -cn --arg head "$head" \'{number:42,title:"fixture",url:"https://example.invalid/42",state:"OPEN",isDraft:false,author:{login:"fixture"},baseRefName:"main",headRefName:"review/pr",headRefOid:$head,headRepository:{nameWithOwner:"fixture/repo",url:""},headRepositoryOwner:{login:"fixture"},additions:1,deletions:0,changedFiles:3}\'; }',
        ...commands,
      ].join("\n"),
      "pr-worktree-containment",
      commonScript,
      worktreeScript,
      reviewScript,
      fixture.root,
    ],
    { cwd: fixture.root, encoding: "utf8" },
  );
}

function expectCanonicalCheckoutUnchanged(fixture: Fixture) {
  expect(git(fixture.root, "branch", "--show-current")).toBe(fixture.siblingBranch);
  expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.siblingSha);
}

describePosix("scripts/pr worktree containment", () => {
  it("stale .worktrees/pr-<N> directory does not clobber the canonical checkout", () => {
    const fixture = createFixture();
    makeStaleWorktreeDir(fixture);

    runShell(fixture, ["enter_worktree 42 true"]);

    expectCanonicalCheckoutUnchanged(fixture);
  });

  it("review_checkout_main cannot detach the canonical checkout", () => {
    const fixture = createFixture();
    makeStaleWorktreeDir(fixture);

    const result = runShell(fixture, ["review_checkout_main 42"]);

    expectCanonicalCheckoutUnchanged(fixture);
    if (result.status !== 0) {
      expect(result.stderr).toContain("scripts/pr refuses to mutate the shared canonical checkout");
    }
  });

  it("failure midway leaves the canonical checkout untouched", () => {
    const fixture = createFixture();
    const brokenWorktree = join(fixture.root, ".worktrees", "pr-42");
    git(fixture.root, "worktree", "add", brokenWorktree, "-b", "temp/pr-42", "origin/main");
    rmSync(join(brokenWorktree, ".git"));

    const result = runShell(fixture, [
      "enter_worktree 42 false",
      "git checkout --detach origin/main",
      "exit 1",
    ]);

    expect(result.status).not.toBe(0);
    expectCanonicalCheckoutUnchanged(fixture);
  });

  it("refuses a symlink alias pointing at another PR's worktree", () => {
    const fixture = createFixture();
    const worktrees = join(fixture.root, ".worktrees");
    mkdirSync(worktrees, { recursive: true });
    git(
      fixture.root,
      "worktree",
      "add",
      join(worktrees, "pr-99"),
      "-b",
      "temp/pr-99",
      "origin/main",
    );
    symlinkSync("pr-99", join(worktrees, "pr-42"), "dir");

    const result = runShell(fixture, ["enter_worktree 42 true"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refuses to mutate the shared canonical checkout");
    expect(git(join(worktrees, "pr-99"), "branch", "--show-current")).toBe("temp/pr-99");
    expectCanonicalCheckoutUnchanged(fixture);
  });

  it("reuses a properly registered PR worktree", () => {
    const fixture = createFixture();
    const expectedWorktree = join(fixture.root, ".worktrees", "pr-42");
    git(fixture.root, "worktree", "add", expectedWorktree, "-b", "temp/pr-42", "origin/main");

    const result = runShell(fixture, [
      "enter_worktree 42 false",
      'printf "cwd=%s\\n" "$PWD"',
      'printf "branch=%s\\n" "$(git branch --show-current)"',
      'printf "head=%s\\n" "$(git rev-parse HEAD)"',
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`cwd=${realpathSync(expectedWorktree)}`);
    expect(result.stdout).toContain("branch=temp/pr-42");
    expect(result.stdout).toContain(`head=${fixture.mainSha}`);
    expectCanonicalCheckoutUnchanged(fixture);
  });

  it("recovers an interrupted transition before repeated init, main, and PR checkout", () => {
    const fixture = createReviewFixture();
    const artifact = join(fixture.root, ".worktrees", "pr-42", ".local", "review-note");

    const result = runShell(fixture, [
      "review_init 42",
      "review_checkout_main 42",
      "review_checkout_pr 42",
      'printf "preserve me\\n" > .local/review-note',
      "source_sha=$(git rev-parse HEAD)",
      "target_sha=$(git rev-parse origin/main)",
      'jq -cn --arg source "$source_sha" --arg target "$target_sha" \'{version:1,pr:42,source:$source,target:$target,mode:"detached",branch:null}\' > .local/review-transition.json',
      'git restore --source="$target_sha" --staged --worktree -- transition-a.txt main-only.txt',
      'git update-ref --no-deref HEAD "$target_sha" "$source_sha"',
      `git -C "$fixture_root" update-ref refs/pull/42/head ${fixture.prBSha}`,
      "review_init 42",
      "review_checkout_main 42",
      "review_checkout_pr 42",
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(git(join(fixture.root, ".worktrees", "pr-42"), "rev-parse", "HEAD")).toBe(
      fixture.prBSha,
    );
    expect(
      git(join(fixture.root, ".worktrees", "pr-42"), "status", "--short", "--untracked-files=no"),
    ).toBe("");
    expect(readFileSync(artifact, "utf8")).toBe("preserve me\n");
    expect(
      existsSync(join(fixture.root, ".worktrees", "pr-42", ".local", "review-transition.json")),
    ).toBe(false);
    expectCanonicalCheckoutUnchanged(fixture);
  });

  for (const testCase of [
    {
      name: "staged",
      setup: ['printf "foreign staged\\n" > overlap.txt', "git add overlap.txt"],
      expectedStatus: "M  overlap.txt",
      dirtyFile: "overlap.txt",
      dirtyContent: "foreign staged\n",
    },
    {
      name: "unstaged",
      setup: ['printf "foreign unstaged\\n" > overlap.txt'],
      expectedStatus: "M overlap.txt",
      dirtyFile: "overlap.txt",
      dirtyContent: "foreign unstaged\n",
    },
    {
      name: "untracked",
      setup: ['printf "foreign untracked\\n" > foreign.txt'],
      expectedStatus: "?? foreign.txt",
      dirtyFile: "foreign.txt",
      dirtyContent: "foreign untracked\n",
    },
  ]) {
    it(`refuses and preserves ${testCase.name} foreign state`, () => {
      const fixture = createReviewFixture();
      const worktree = join(fixture.root, ".worktrees", "pr-42");
      const result = runShell(fixture, [
        "review_init 42",
        "review_checkout_pr 42",
        "source_sha=$(git rev-parse HEAD)",
        "target_sha=$(git rev-parse origin/main)",
        'jq -cn --arg source "$source_sha" --arg target "$target_sha" \'{version:1,pr:42,source:$source,target:$target,mode:"detached",branch:null}\' > .local/review-transition.json',
        'git restore --source="$target_sha" --staged --worktree -- transition-a.txt',
        ...testCase.setup,
        "git status --porcelain=v1 > .local/expected-status",
        "review_init 42",
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Refusing scripts/pr transition for PR #42");
      expect(git(worktree, "rev-parse", "HEAD")).toBe(fixture.prASha);
      expect(git(worktree, "status", "--porcelain=v1")).toBe(
        readFileSync(join(worktree, ".local", "expected-status"), "utf8").trim(),
      );
      expect(git(worktree, "status", "--short")).toContain(testCase.expectedStatus);
      expect(readFileSync(join(worktree, testCase.dirtyFile), "utf8")).toBe(testCase.dirtyContent);
      expect(existsSync(join(worktree, ".local", "review-transition.json"))).toBe(true);
      expectCanonicalCheckoutUnchanged(fixture);
    });
  }

  it("refuses and preserves an ignored file colliding with the transition target", () => {
    const fixture = createReviewFixture();
    const worktree = join(fixture.root, ".worktrees", "pr-42");
    const result = runShell(fixture, [
      "review_init 42",
      "review_checkout_pr 42",
      "source_sha=$(git rev-parse HEAD)",
      "target_sha=$(git rev-parse origin/main)",
      'jq -cn --arg source "$source_sha" --arg target "$target_sha" \'{version:1,pr:42,source:$source,target:$target,mode:"detached",branch:null}\' > .local/review-transition.json',
      'git restore --source="$target_sha" --staged --worktree -- transition-a.txt',
      'printf "main-only.txt\\n" >> "$(git rev-parse --git-path info/exclude)"',
      'printf "foreign ignored\\n" > main-only.txt',
      "git check-ignore -q main-only.txt",
      "review_init 42",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ignored file 'main-only.txt' would be overwritten");
    expect(git(worktree, "rev-parse", "HEAD")).toBe(fixture.prASha);
    expect(git(worktree, "status", "--short", "--ignored", "--", "main-only.txt")).toBe(
      "!! main-only.txt",
    );
    expect(readFileSync(join(worktree, "main-only.txt"), "utf8")).toBe("foreign ignored\n");
    expect(existsSync(join(worktree, ".local", "review-transition.json"))).toBe(true);
    expectCanonicalCheckoutUnchanged(fixture);
  });
});
