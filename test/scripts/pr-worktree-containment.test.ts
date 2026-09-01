import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  chmodSync,
  constants as fsConstants,
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const templateDirs = useAutoCleanupTempDirTracker(afterAll);
let fixtureTemplate: ReturnType<typeof createFixtureTemplate> | undefined;
let reviewFixtureTemplate: ReturnType<typeof createReviewFixtureTemplate> | undefined;
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

function createFixtureTemplate() {
  const root = templateDirs.make("openclaw-pr-worktree-containment-template-");
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "OpenClaw Test");
  git(root, "config", "user.email", "test@openclaw.invalid");
  writeFileSync(join(root, "fixture.txt"), "main\n");
  git(root, "add", "fixture.txt");
  git(root, "commit", "-m", "main fixture");
  const mainSha = git(root, "rev-parse", "HEAD");
  return { root, mainSha };
}

function createFixture(): Fixture {
  const template = (fixtureTemplate ??= createFixtureTemplate());
  const root = tempDirs.make("openclaw-pr-worktree-containment-");
  // Copy complete history before worktrees exist; each case owns its fetch and refs.
  cpSync(template.root, root, { recursive: true, mode: fsConstants.COPYFILE_FICLONE });
  const { mainSha } = template;
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

function createReviewFixtureTemplate() {
  const root = templateDirs.make("openclaw-pr-review-transition-template-");
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
  writeFileSync(join(root, "pr-only.txt"), "removed on main\n");
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
  return { root, mainSha, prASha, prBSha };
}

function createReviewFixture(): ReviewFixture {
  const template = (reviewFixtureTemplate ??= createReviewFixtureTemplate());
  const root = tempDirs.make("openclaw-pr-review-transition-");
  cpSync(template.root, root, { recursive: true, mode: fsConstants.COPYFILE_FICLONE });
  const { mainSha, prASha, prBSha } = template;
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

function runShell(fixture: Fixture, commands: string[], env?: NodeJS.ProcessEnv) {
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
        'script_parent_dir="$fixture_root"',
        "gh_plain() { :; }",
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
    { cwd: fixture.root, encoding: "utf8", env: { ...process.env, ...env } },
  );
}

function expectCanonicalCheckoutUnchanged(fixture: Fixture) {
  expect(git(fixture.root, "branch", "--show-current")).toBe(fixture.siblingBranch);
  expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.siblingSha);
}

function traceEntryCommands(failure: string, code = 73) {
  return [
    "trace_command() {",
    '  printf "%s\\n" "$*" >> "$fixture_root/commands.log"',
    `  if ${failure}; then`,
    '    printf "FAIL %s\\n" "$*" >> "$fixture_root/commands.log"',
    '    if [ "$1" = pwd ]; then command "$@"; fi',
    `    return ${code}`,
    "  fi",
    "}",
    ...["git", "cd", "pwd", "mkdir", "rm", "mv", "trash"].map(
      (name) => `${name}() { trace_command ${name} "$@" || return $?; command ${name} "$@"; }`,
    ),
    'gh_plain() { trace_command gh_plain "$@"; }',
  ];
}

function expectEntryStopped(fixture: Fixture, result: ReturnType<typeof runShell>) {
  const commands = readFileSync(join(fixture.root, "commands.log"), "utf8").trim().split("\n");
  const failure = commands.findIndex((command) => command.startsWith("FAIL "));
  expect(failure, commands.join("\n")).toBeGreaterThanOrEqual(0);
  expect.soft(commands.slice(failure + 1), commands.join("\n")).toEqual([]);
  expect.soft(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
  expectCanonicalCheckoutUnchanged(fixture);
}

function reviewState(worktree: string) {
  return {
    head: git(worktree, "rev-parse", "HEAD"),
    branch: git(worktree, "branch", "--show-current"),
    index: git(worktree, "write-tree"),
    status: git(worktree, "status", "--porcelain=v1"),
    diff: git(worktree, "diff", "HEAD"),
    journal: existsSync(join(worktree, ".local", "review-transition.json"))
      ? readFileSync(join(worktree, ".local", "review-transition.json"), "utf8")
      : null,
  };
}

describePosix("scripts/pr worktree containment", () => {
  it("refreshes warm and cold PRs concurrently while another Git transaction owns shared main", async () => {
    const fixture = createFixture();
    git(fixture.root, "worktree", "add", "--detach", ".worktrees/pr-42", fixture.mainSha);
    git(fixture.root, "update-ref", "refs/heads/main", fixture.siblingSha);
    const fetchHead = join(fixture.root, ".git", "FETCH_HEAD");
    const previousFetch = readFileSync(fetchHead, "utf8");
    const writer = spawn("git", ["update-ref", "--stdin"], { cwd: fixture.root });
    let writerOutput = "";
    writer.stderr.on("data", (chunk) => {
      writerOutput += chunk;
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      writer.once("error", reject);
      writer.once("close", resolve);
    });
    const prepared = new Promise<void>((resolve) => {
      writer.stdout.on("data", (chunk) => {
        writerOutput += chunk;
        if (writerOutput.includes("prepare: ok\n")) resolve();
      });
    });
    writer.stdin.write(
      `start\nupdate refs/remotes/origin/main ${fixture.siblingSha} ${fixture.mainSha}\nprepare\n`,
    );
    try {
      await Promise.race([
        prepared,
        closed.then((code) => {
          throw new Error(
            `Shared ref transaction exited before preparation: ${code}\n${writerOutput}`,
          );
        }),
      ]);
      const results = await Promise.all(
        [42, 43].map(
          (pr) =>
            new Promise<{ code: number | null; output: string }>((resolve, reject) => {
              const child = spawn(
                "bash",
                [
                  "-c",
                  'set -euo pipefail\nsource "$1"\nsource "$2"\nsource "$3"\nscript_parent_dir="$4"\ngh_plain() { :; }\nmark_pr_operation_side_effects_started() { :; }\nreview_checkout_main "$5"',
                  "pr-concurrency",
                  commonScript,
                  worktreeScript,
                  reviewScript,
                  fixture.root,
                  String(pr),
                ],
                { cwd: fixture.root, stdio: ["ignore", "pipe", "pipe"] },
              );
              let output = "";
              child.stdout.on("data", (chunk) => {
                output += chunk;
              });
              child.stderr.on("data", (chunk) => {
                output += chunk;
              });
              child.once("error", reject);
              child.once("close", (code) => {
                resolve({ code, output });
              });
            }),
        ),
      );
      for (const result of results) expect.soft(result.code, result.output).toBe(0);
      expect(writer.exitCode).toBeNull();
      expect(readFileSync(fetchHead, "utf8")).toBe(previousFetch);
      expect(git(fixture.root, "rev-parse", "refs/remotes/origin/main")).toBe(fixture.mainSha);
      for (const pr of [42, 43]) {
        const worktree = join(fixture.root, ".worktrees", `pr-${pr}`);
        expect(git(worktree, "rev-parse", "HEAD")).toBe(fixture.siblingSha);
        expect(git(worktree, "status", "--porcelain", "--untracked-files=no")).toBe("");
      }
      expectCanonicalCheckoutUnchanged(fixture);
    } finally {
      writer.stdin.end("abort\n");
      await closed;
    }
  });

  for (const caller of ["enter_worktree 42 true || exit $?", "review_init 42"] as const) {
    it.each([
      {
        name: "private fetch interrupted",
        failure: '[[ "$*" == *" fetch "* ]] && [ "$PWD" = "$fixture_root/.worktrees/pr-42" ]',
        code: 130,
      },
      {
        name: "private fetch Git error",
        failure: '[[ "$*" == *" fetch "* ]] && [ "$PWD" = "$fixture_root/.worktrees/pr-42" ]',
        code: 128,
      },
      { name: "GitHub auth failure", failure: '[ "$1" = gh_plain ]', code: 1 },
    ])(`stops on $name without replaying a pending transition (${caller})`, ({ failure, code }) => {
      const fixture = createReviewFixture();
      const worktree = join(fixture.root, ".worktrees", "pr-42");
      const setup = runShell(fixture, [
        "review_init 42",
        "review_checkout_pr 42",
        "git checkout -B temp/pr-42",
        `write_review_transition_journal 42 ${fixture.prASha} ${fixture.mainSha} branch temp/pr-42`,
        `git restore --source=${fixture.mainSha} --staged --worktree -- transition-a.txt`,
      ]);
      expect(setup.status, `${setup.stdout}\n${setup.stderr}`).toBe(0);
      const before = reviewState(worktree);
      const result = runShell(fixture, [...traceEntryCommands(failure, code), caller]);

      expectEntryStopped(fixture, result);
      expect(reviewState(worktree)).toEqual(before);
      if (failure.includes("gh_plain")) {
        expect(result.stderr).toContain("GitHub CLI auth is not usable");
      }
    });
  }

  it.each([
    {
      name: "first fetch",
      failure: '[[ "$*" == *" fetch "* ]] && [ "$PWD" = "$fixture_root" ]',
      provisioned: false,
    },
    {
      name: "second fetch",
      failure: '[[ "$*" == *" fetch "* ]] && [ "$PWD" = "$fixture_root/.worktrees/pr-42" ]',
      provisioned: true,
    },
    { name: "auth", failure: '[ "$1" = gh_plain ]', provisioned: false },
  ])(
    "stops cold entry on $name failure, retaining only completed provisioning",
    ({ failure, provisioned }) => {
      const fixture = createFixture();
      const worktree = join(fixture.root, ".worktrees", "pr-42");
      const result = runShell(fixture, [
        ...traceEntryCommands(failure, 130),
        "enter_worktree 42 true || exit $?",
      ]);
      expectEntryStopped(fixture, result);
      expect(existsSync(worktree)).toBe(provisioned);
      expect(existsSync(join(worktree, ".local"))).toBe(false);
      if (provisioned) {
        expect(git(worktree, "rev-parse", "HEAD")).toBe(fixture.mainSha);
        expect(git(worktree, "branch", "--show-current")).toBe("temp/pr-42");
      }
    },
  );

  it.each([
    {
      name: "root resolution",
      failure: '[ "$*" = "pwd" ] && [ "$PWD" = "$fixture_root" ]',
      setup: [],
    },
    {
      name: "canonical cd",
      failure: '[ "$*" = "cd $fixture_root" ] && [ "$BASH_SUBSHELL" = 0 ]',
      setup: [],
    },
    {
      name: "stale registration prune",
      failure: '[ "$*" = "git -C $fixture_root worktree prune" ]',
      setup: [
        "git worktree add .worktrees/pr-42 -b temp/pr-42 origin/main",
        "rm -rf .worktrees/pr-42",
      ],
    },
    {
      name: "worktree add",
      failure: '[[ "$*" == "git -C $fixture_root worktree add "* ]]',
      setup: [],
    },
    {
      name: "post-add parent resolution",
      failure: '[ "$*" = "pwd -P" ] && [ "$PWD" = "$fixture_root/.worktrees" ]',
      setup: [],
    },
    {
      name: "worktree cd",
      failure: '[ "$*" = "cd $fixture_root/.worktrees/pr-42" ] && [ "$BASH_SUBSHELL" = 0 ]',
      setup: [],
    },
    {
      name: "sparse conversion",
      failure: '[ "$*" = "git sparse-checkout disable" ]',
      setup: [
        "git sparse-checkout init --no-cone",
        "git sparse-checkout set --no-cone fixture.txt",
      ],
    },
    {
      name: "sparse config read",
      failure: '[ "$*" = "git config --bool core.sparseCheckout" ]',
      setup: [],
    },
    { name: "artifact directory", failure: '[ "$*" = "mkdir -p .local" ]', setup: [] },
  ])("stops required entry steps on $name failure in an OR list", ({ failure, setup }) => {
    const fixture = createFixture();
    const result = runShell(fixture, [
      ...setup,
      ...traceEntryCommands(failure),
      "enter_worktree 42 false || exit $?",
    ]);
    expectEntryStopped(fixture, result);
    expect(existsSync(join(fixture.root, ".worktrees", "pr-42", ".local"))).toBe(false);
  });

  it("refuses provisioning when best-effort cleanup leaves the stale directory", () => {
    const fixture = createFixture();
    makeStaleWorktreeDir(fixture);
    const marker = join(fixture.root, ".worktrees", "pr-42", "foreign-note");
    writeFileSync(marker, "preserve me\n");
    const result = runShell(fixture, [
      ...traceEntryCommands('[ "$1" = trash ]'),
      "enter_worktree 42 true || exit $?",
    ]);
    expectEntryStopped(fixture, result);
    expect(result.stdout).toContain("failed to trash orphaned worktree dir");
    expect(result.stderr).toContain("could not be cleared");
    expect(readFileSync(marker, "utf8")).toBe("preserve me\n");
  });

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

  it.each(["cold", "warm"])("enters a %s PR worktree and fetches in its Git context", (state) => {
    const fixture = createFixture();
    const expectedWorktree = join(fixture.root, ".worktrees", "pr-42");
    if (state === "warm") {
      git(fixture.root, "worktree", "add", expectedWorktree, "-b", "temp/pr-42", "origin/main");
    }

    const result = runShell(fixture, [
      "enter_worktree 42 false || exit $?",
      'printf "cwd=%s\\n" "$PWD"',
      'printf "branch=%s\\n" "$(git branch --show-current)"',
      'printf "head=%s\\n" "$(git rev-parse HEAD)"',
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`cwd=${realpathSync(expectedWorktree)}`);
    expect(result.stdout).toContain("branch=temp/pr-42");
    expect(result.stdout).toContain(`head=${fixture.mainSha}`);
    const fetchHead = git(
      expectedWorktree,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "FETCH_HEAD",
    );
    expect(fetchHead).not.toBe(
      git(fixture.root, "rev-parse", "--path-format=absolute", "--git-path", "FETCH_HEAD"),
    );
    expect(readFileSync(fetchHead, "utf8")).toContain(fixture.mainSha);
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

  for (const mode of ["branch", "detached"] as const) {
    it.each([
      {
        name: "partially restored index",
        setup: ['git restore --source="$target_sha" --staged --worktree -- pr-only.txt'],
      },
      {
        name: "fully restored index",
        setup: ['git restore --source="$target_sha" --staged --worktree -- .'],
      },
      {
        name: "interrupted recovery checkout",
        setup: [
          'git() { if [ "${1:-}" = checkout ]; then return 73; fi; command git "$@"; }',
          "if recover_review_transition 42; then exit 1; fi",
          "unset -f git",
          'git diff --cached --quiet "$target_sha"',
        ],
      },
    ])(`recovers completed deletions after $name (${mode})`, ({ setup }) => {
      const fixture = createReviewFixture();
      const worktree = join(fixture.root, ".worktrees", "pr-42");
      const result = runShell(fixture, [
        "review_init 42",
        "review_checkout_pr 42",
        'printf "preserve me\\n" > .local/review-note',
        "source_sha=$(git rev-parse HEAD)",
        "target_sha=$(git rev-parse origin/main)",
        `write_review_transition_journal 42 "$source_sha" "$target_sha" ${mode} temp/pr-42`,
        ...setup,
        "test ! -e pr-only.txt",
        'test "$(git rev-parse HEAD)" = "$source_sha"',
        "test -f .local/review-transition.json",
        "recover_review_transition 42",
      ]);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(git(worktree, "rev-parse", "HEAD")).toBe(fixture.mainSha);
      expect(git(worktree, "branch", "--show-current")).toBe(mode === "branch" ? "temp/pr-42" : "");
      expect(git(worktree, "status", "--porcelain=v1", "--untracked-files=no")).toBe("");
      expect(existsSync(join(worktree, "pr-only.txt"))).toBe(false);
      expect(readFileSync(join(worktree, ".local", "review-note"), "utf8")).toBe("preserve me\n");
      expect(existsSync(join(worktree, ".local", "review-transition.json"))).toBe(false);
      expectCanonicalCheckoutUnchanged(fixture);
    });
  }

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

  it("allows a missing transition path that merely matches an ignore rule", () => {
    const fixture = createReviewFixture();
    const result = runShell(fixture, [
      "review_init 42",
      "review_checkout_pr 42",
      'printf "main-only.txt\\n" >> "$(git rev-parse --git-path info/exclude)"',
      "git check-ignore -q main-only.txt",
      "test ! -e main-only.txt",
      "review_checkout_main 42",
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(join(fixture.root, ".worktrees", "pr-42", "main-only.txt"), "utf8")).toBe(
      "main-only\n",
    );
    expectCanonicalCheckoutUnchanged(fixture);
  });

  it("checks every transition target for ignored collisions with bounded Git queries", () => {
    const fixture = createReviewFixture();
    git(fixture.root, "checkout", "review/pr");
    for (let index = 0; index < 32; index += 1) {
      writeFileSync(join(fixture.root, `transition-batch-${index}.txt`), `${index}\n`);
    }
    const literalPath = "transition-[literal]*?.txt";
    writeFileSync(join(fixture.root, literalPath), "literal path\n");
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-m", "add transition batch");
    git(fixture.root, "update-ref", "refs/pull/42/head", "HEAD");
    git(fixture.root, "checkout", fixture.siblingBranch);

    const tools = join(fixture.root, "tools");
    const commandLog = join(fixture.root, "git-commands.log");
    mkdirSync(tools);
    const realGit = spawnSync("bash", ["-lc", "command -v git"], {
      encoding: "utf8",
    }).stdout.trim();
    writeFileSync(
      join(tools, "git"),
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$*" >> "$GIT_COMMAND_LOG"',
        'if [[ ( "${1:-}" == "restore" || "${2:-}" == "restore" ) && "$#" -gt 12 ]]; then',
        '  printf "%s\\n" "Argument list too long" >&2',
        "  exit 126",
        "fi",
        'exec "$REAL_GIT" "$@"',
      ].join("\n"),
    );
    chmodSync(join(tools, "git"), 0o755);

    const result = runShell(fixture, ["review_checkout_pr 42"], {
      GIT_COMMAND_LOG: commandLog,
      PATH: `${tools}:${process.env.PATH ?? ""}`,
      REAL_GIT: realGit,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const commands = readFileSync(commandLog, "utf8").trim().split("\n");
    // checkout validates once before journaling and again while recovering it.
    expect(commands.filter((command) => command.startsWith("check-ignore "))).toHaveLength(2);
    expect(
      commands.filter((command) => command.startsWith("ls-files --others --ignored ")),
    ).toHaveLength(0);
    expect(readFileSync(join(fixture.root, ".worktrees", "pr-42", literalPath), "utf8")).toBe(
      "literal path\n",
    );
    expectCanonicalCheckoutUnchanged(fixture);
  });
});
