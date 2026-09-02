import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const scripts = join(process.cwd(), "scripts");
const describePosix = process.platform === "win32" ? describe.skip : describe;
type Capture = "empty" | "populated" | "symlink";

function fixture() {
  const root = realpathSync(temps.make("pr-worktree-evidence-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: home,
    TMPDIR: root,
    LC_ALL: "C",
    TZ: "UTC0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TEMPLATE_DIR: home,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "commit.gpgSign",
    GIT_CONFIG_VALUE_1: "false",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Evidence Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Evidence Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    FIXTURE_REPO: repo,
    FIXTURE_ROOT: root,
    FIXTURE_SCRIPTS: scripts,
  };
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd: repo, env, input, encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["commit", "-q", "--allow-empty", "-m", "Synthetic fixture"]);
  git(["remote", "add", "origin", repo]);
  const head = git(["rev-parse", "HEAD"]);
  const branches = () => git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]);
  const outcomes = () =>
    git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/openclaw/pr-merge-outcomes/"]);
  const worktrees = () => git(["worktree", "list", "--porcelain"]);
  const add = (
    pr: number,
    capture?: Capture,
    registered = true,
    captureName = "merge-output.log",
  ) => {
    const dir = join(repo, ".worktrees", `pr-${pr}`);
    if (registered) {
      git(["worktree", "add", "-q", "-b", `temp/pr-${pr}`, dir]);
    } else {
      git(["branch", `temp/pr-${pr}`]);
    }
    git(["branch", `pr-${pr}`]);
    git(["branch", `pr-${pr}-prep`]);
    mkdirSync(join(dir, ".local"), { recursive: true });
    writeFileSync(join(dir, ".local", "prep.env"), "synthetic metadata\n");
    if (capture === "symlink") {
      symlinkSync("missing-capture", join(dir, ".local", captureName));
    } else if (capture) {
      writeFileSync(
        join(dir, ".local", captureName),
        capture === "empty" ? "" : "Synthetic response\n",
      );
    }
    return dir;
  };
  const run = (commands: string[], state = "CLOSED") => {
    const shell = join(root, "invoke.sh");
    writeFileSync(
      shell,
      `#!/usr/bin/env bash
set -euo pipefail
script_parent_dir="$FIXTURE_REPO"
source "$FIXTURE_SCRIPTS/pr-lib/worktree.sh"
source "$FIXTURE_SCRIPTS/pr-lib/operation-lock.sh"
source "$FIXTURE_SCRIPTS/pr-lib/common.sh"
source "$FIXTURE_SCRIPTS/pr-lib/merge-outcome.sh"
test "$(repo_root)" = "$FIXTURE_REPO"
gh() {
  if [ "$#" = 7 ] && [ "$1 $2" = 'pr view' ] && [ "$4 $5 $6 $7" = '--json state --jq .state' ]; then
    git show-ref --verify --quiet "refs/openclaw/pr-operation-locks/$3" || exit 97
    printf '%s\\n' "$*" >> "$FIXTURE_ROOT/gh-calls"
    printf '%s\\n' "$FIXTURE_STATE"
  else
    echo "Unexpected GitHub call: $*" >&2; exit 97
  fi
}
gh_plain() {
  if [ "$*" = 'api graphql -f query=query { viewer { login } } --include' ]; then
    printf 'HTTP/2.0 200 OK\\n\\n{"data":{"viewer":{"login":"fixture-user"}}}\\n'
  else
    echo "Unexpected direct GitHub call: $*" >&2; exit 97
  fi
}
trash() {
  case "$1" in "$FIXTURE_REPO"/.worktrees/pr-*|.worktrees/pr-*) ;; *) exit 97 ;; esac
  mkdir -p "$FIXTURE_ROOT/trash"
  mv "$1" "$FIXTURE_ROOT/trash/"
}
${commands.join("\n")}
`,
    );
    chmodSync(shell, 0o755);
    const result = spawnSync(
      process.execPath,
      [join(scripts, "pr-lib/process-group-runner.mjs"), repo, shell],
      {
        cwd: repo,
        env: { ...env, FIXTURE_STATE: state },
        encoding: "utf8",
      },
    );
    return { ...result, output: result.stdout + result.stderr };
  };
  const record = (pr: number, phase = "intent") => {
    const value = {
      version: 1,
      repo: {
        id: "fixture-repo",
        nameWithOwner: "fixture/repo",
        url: "https://example.invalid/fixture/repo",
      },
      pr,
      prId: `fixture-pr-${pr}`,
      base: "main",
      head,
      main: head,
      attempt: "11111111-1111-4111-8111-111111111111",
      method: "squash",
      route: "immediate",
      phase,
      accepted: false,
      landed: phase === "intent" ? null : head,
    };
    const file = join(root, "outcome-input.json");
    writeFileSync(file, JSON.stringify(value));
    const result = run([
      `acquire_pr_operation_lock ${pr}`,
      `MERGE_OUTCOME_REF=refs/openclaw/pr-merge-outcomes/${pr}`,
      'MERGE_OUTCOME_OID=""',
      'merge_outcome_write "$(cat "$FIXTURE_ROOT/outcome-input.json")"',
      "release_pr_operation_lock",
    ]);
    expect(result.status, result.output).toBe(0);
    return `refs/openclaw/pr-merge-outcomes/${pr}`;
  };
  return { root, repo, head, git, add, run, record, branches, outcomes, worktrees };
}

function evidence(dir: string, captureName = "merge-output.log") {
  const capture = join(dir, ".local", captureName);
  const stat = lstatSync(capture);
  return {
    inode: stat.ino,
    mode: stat.mode,
    mtime: stat.mtimeMs,
    contents: stat.isSymbolicLink() ? readlinkSync(capture) : readFileSync(capture, "utf8"),
    metadata: readFileSync(join(dir, ".local/prep.env"), "utf8"),
  };
}

describePosix("native worktree cleanup preserves merge evidence", () => {
  it.each(
    ["CLOSED", "MERGED"].flatMap((state) =>
      ["merge-output.log", "merge-output.11111111-1111-4111-8111-111111111111.log"].map(
        (captureName) => ({ state, captureName }),
      ),
    ),
  )(
    "preserves registered captures during dry-run and actual GC for %j",
    ({ state, captureName }) => {
      const f = fixture();
      const protectedDirs = ["empty", "populated", "symlink"].map((shape, index) =>
        f.add(910001 + index, shape as Capture, true, captureName),
      );
      const eligible = f.add(910009);
      const before = protectedDirs.map((dir) => evidence(dir, captureName));
      const branches = f.branches();
      const registrations = f.worktrees();
      const dry = f.run(["gc_pr_worktrees true"], state);
      expect(dry.status, dry.output).toBe(0);
      expect.soft(dry.output).toContain("would remove .worktrees/pr-910009");
      for (const pr of [910001, 910002, 910003]) {
        expect.soft(dry.output).not.toContain(`would remove .worktrees/pr-${pr}`);
      }
      expect(f.branches()).toBe(branches);
      expect(f.worktrees()).toBe(registrations);
      const actual = f.run(["gc_pr_worktrees false"], state);
      expect(actual.status, actual.output).toBe(0);
      // Check the original path first: moving evidence to Trash also violates recovery.
      for (const [index, dir] of protectedDirs.entries()) {
        expect.soft(existsSync(join(dir, ".local")), actual.output).toBe(true);
        if (existsSync(join(dir, ".local"))) {
          expect(evidence(dir, captureName)).toEqual(before[index]);
        }
        expect.soft(actual.output).not.toContain(`removed .worktrees/pr-${910001 + index}`);
        expect.soft(f.worktrees()).toContain(`worktree ${dir}\n`);
        for (const branch of [
          `temp/pr-${910001 + index}`,
          `pr-${910001 + index}`,
          `pr-${910001 + index}-prep`,
        ]) {
          expect.soft(f.branches()).toContain(`refs/heads/${branch} ${f.head}`);
        }
      }
      expect(actual.output).toContain("reconcile the earlier request manually");
      expect(existsSync(eligible)).toBe(false);
      expect(actual.output).toContain("removed .worktrees/pr-910009");
      expect(f.outcomes()).toBe("");
      expect(
        f.git(["for-each-ref", "--format=%(refname)", "refs/openclaw/pr-operation-locks/"]),
      ).toBe("");
      expect(existsSync(join(f.root, "trash"))).toBe(false);
    },
  );

  it.each([false, true])(
    "preserves orphan entry before pruning/provisioning (stale registration=%s)",
    (stale) => {
      const f = fixture();
      const dir = f.add(910001, "empty", stale);
      if (stale) {
        const gitdir = readFileSync(join(dir, ".git"), "utf8").trim().slice(8);
        writeFileSync(join(gitdir, "gitdir"), `${dir}-missing/.git\n`);
        rmSync(join(dir, ".git"));
      }
      const before = evidence(dir);
      const branches = f.branches();
      const registrations = f.worktrees();
      const result = f.run([
        "acquire_pr_operation_lock 910001",
        "begin_pr_operation_validation_phase",
        "enter_worktree 910001 false || exit $?",
        "echo unexpected-entry-completed",
      ]);
      expect.soft(existsSync(join(dir, ".local/merge-output.log")), result.output).toBe(true);
      if (existsSync(join(dir, ".local/merge-output.log"))) {
        expect(evidence(dir)).toEqual(before);
      }
      expect.soft(f.worktrees()).toBe(registrations);
      expect(f.branches()).toBe(branches);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).not.toContain("unexpected-entry-completed");
      expect(result.output).toContain("reconcile the earlier request manually");
      expect(existsSync(join(f.root, "trash"))).toBe(false);
      expect(f.outcomes()).toBe("");
    },
  );

  it.each(["corrupt", "symbolic", "wrong-pr", "unretained"])(
    "refuses GC with %s outcome",
    (fault) => {
      const f = fixture();
      const dir = f.add(910001, "populated");
      const ref = f.record(910001);
      if (fault === "corrupt") {
        f.git(["update-ref", ref, f.git(["hash-object", "-w", "--stdin"], "bad")]);
      }
      if (fault === "symbolic") {
        f.git(["update-ref", "refs/fixture/retained", f.git(["rev-parse", ref])]);
        f.git(["symbolic-ref", ref, "refs/fixture/retained"]);
      }
      if (fault === "wrong-pr") {
        const other = f.record(910002);
        f.git(["update-ref", ref, f.git(["rev-parse", other])]);
      }
      if (fault === "unretained") {
        const tree = f.git(["rev-parse", `${ref}^{tree}`]);
        f.git(["update-ref", ref, f.git(["commit-tree", tree], "Unretained fixture\n")]);
      }
      const before = evidence(dir);
      const branches = f.branches();
      const outcomes = f.outcomes();
      const result = f.run(["gc_pr_worktrees false"]);
      expect(result.status, result.output).toBe(0);
      expect(existsSync(join(dir, ".local/merge-output.log")), result.output).toBe(true);
      expect(evidence(dir)).toEqual(before);
      expect(f.branches()).toBe(branches);
      expect(f.outcomes()).toBe(outcomes);
      expect(result.output).toContain("No merged/closed PR worktrees removed.");
      expect(result.output).toContain("reconcile the earlier request manually");
    },
  );

  it.each([true, false])("shared removal refuses capture (registered=%s)", (registered) => {
    const f = fixture();
    const dir = f.add(910001, "populated", registered);
    const before = evidence(dir);
    const branches = f.branches();
    const registrations = f.worktrees();
    const result = f.run([
      "acquire_pr_operation_lock 910001",
      "begin_pr_operation_validation_phase",
      'remove_worktree_if_present ".worktrees/pr-910001" || exit $?',
      "echo unexpected-removal-completed",
    ]);
    expect(existsSync(join(dir, ".local/merge-output.log")), result.output).toBe(true);
    expect(evidence(dir)).toEqual(before);
    expect(f.branches()).toBe(branches);
    expect(f.worktrees()).toBe(registrations);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).not.toContain("unexpected-removal-completed");
    expect(existsSync(join(f.root, "trash"))).toBe(false);
  });

  it.each(["intent", "complete"])("allows cleanup with a valid retained %s outcome", (phase) => {
    const f = fixture();
    const dir = f.add(910001, "populated");
    const ref = f.record(910001, phase);
    const before = f.outcomes();
    const result = f.run(["gc_pr_worktrees false"]);
    expect(result.status, result.output).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(result.output).toContain("removed .worktrees/pr-910001");
    expect(f.outcomes()).toBe(before);
    expect(JSON.parse(f.git(["show", `${ref}:outcome.json`])).phase).toBe(phase);
    expect(
      f.git(["for-each-ref", "--format=%(refname)", "refs/openclaw/pr-operation-locks/"]),
    ).toBe("");
  });
});
