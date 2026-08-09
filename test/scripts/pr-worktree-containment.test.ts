import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
        "set_review_mode() { :; }",
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
});
