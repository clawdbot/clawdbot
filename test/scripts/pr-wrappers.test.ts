// PR wrapper tests cover maintainer helper command delegation.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

function readScript(path: string): string {
  return readFileSync(path, "utf8");
}

const anchorSubstitutionNotice = (repo: string) =>
  `scripts/pr wrapper in this worktree differs from origin/main; running the canonical checkout's wrapper (matches the origin/main trust anchor): ${repo}`;
const itPosix = process.platform === "win32" ? it.skip : it;

function makeMismatchedWrapperRepo() {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "openclaw-pr-dev-wrapper-")));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const canonicalPath = join(root, "canonical");
  const linkedPath = join(root, "linked");
  const originPath = join(root, "origin.git");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  // This fixture exercises wrapper trust routing, not the host command inventory.
  for (const command of ["pnpm", "rg"]) {
    const commandPath = join(bin, command);
    writeFileSync(commandPath, "#!/bin/sh\nexit 0\n");
    chmodSync(commandPath, 0o755);
  }
  // Deterministic gh stub: main-only subcommands fail fast on the base-branch
  // gate instead of reaching the network, proving which wrapper actually ran.
  const ghStub = join(bin, "gh");
  writeFileSync(
    ghStub,
    '#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then\n  printf \'{"baseRefName":"not-main"}\\n\'\n  exit 0\nfi\nexit 0\n',
  );
  chmodSync(ghStub, 0o755);

  const fixtureEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: home,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: join(home, ".config"),
  };
  const git = (cwd: string, args: string[]) => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: fixtureEnv,
      stdio: "pipe",
    });
    expect(result.status, `git ${args.join(" ")}\n${result.stderr}`).toBe(0);
    return result;
  };

  git(root, ["init", "--bare", "-b", "main", originPath]);
  git(root, ["init", "-b", "main", canonicalPath]);
  const canonical = realpathSync(canonicalPath);
  const origin = realpathSync(originPath);
  mkdirSync(join(canonical, "scripts", "lib"), { recursive: true });
  cpSync("scripts/pr-lib", join(canonical, "scripts", "pr-lib"), { recursive: true });
  writeFileSync(join(canonical, "scripts", "pr"), readScript("scripts/pr"));
  cpSync("scripts/watch-pr-ci.mjs", join(canonical, "scripts", "watch-pr-ci.mjs"));
  cpSync("scripts/watch-pr-ci.mts", join(canonical, "scripts", "watch-pr-ci.mts"));
  cpSync(
    "scripts/verify-pr-hosted-gates.mjs",
    join(canonical, "scripts", "verify-pr-hosted-gates.mjs"),
  );
  cpSync(
    "scripts/verify-pr-hosted-gates.mts",
    join(canonical, "scripts", "verify-pr-hosted-gates.mts"),
  );
  cpSync("scripts/lib/plain-gh.mjs", join(canonical, "scripts", "lib", "plain-gh.mjs"));
  cpSync("scripts/lib/direct-run.mjs", join(canonical, "scripts", "lib", "direct-run.mjs"));
  cpSync("scripts/lib/tsx-cli-shim.mjs", join(canonical, "scripts", "lib", "tsx-cli-shim.mjs"));
  cpSync(
    "scripts/lib/local-check-runtime.mts",
    join(canonical, "scripts", "lib", "local-check-runtime.mts"),
  );
  cpSync("scripts/tsx.mjs", join(canonical, "scripts", "tsx.mjs"));
  writeFileSync(
    join(canonical, "scripts", "lib", "plain-gh.sh"),
    "resolve_plain_gh_bin() { printf '/usr/bin/true\\n'; }\ngh_plain() { :; }\n",
  );
  // Marker stub committed to main (the origin/main anchor), so tests can tell
  // an anchor-substituted canonical run apart from a local wrapper run.
  writeFileSync(
    join(canonical, "scripts", "pr-lib", "gates.sh"),
    'ci_dispatch() { echo "canonical wrapper executed"; }\n',
  );
  chmodSync(join(canonical, "scripts", "pr"), 0o755);

  git(canonical, ["config", "user.name", "OpenClaw Test"]);
  git(canonical, ["config", "user.email", "test@example.invalid"]);
  git(canonical, ["config", "commit.gpgSign", "false"]);
  git(canonical, ["config", "core.hooksPath", "/dev/null"]);
  git(canonical, ["remote", "add", "origin", origin]);
  git(canonical, ["add", "scripts"]);
  git(canonical, ["commit", "-m", "test: canonical wrapper"]);
  git(canonical, ["push", "-u", "origin", "main"]);
  git(canonical, ["worktree", "add", "-b", "feature", linkedPath, "main"]);

  const linked = realpathSync(linkedPath);
  git(linked, ["config", "user.name", "OpenClaw Test"]);
  git(linked, ["config", "user.email", "test@example.invalid"]);
  git(linked, ["config", "commit.gpgSign", "false"]);
  expect(git(linked, ["rev-parse", "refs/remotes/origin/main"]).stdout.trim()).toBe(
    git(canonical, ["rev-parse", "main"]).stdout.trim(),
  );

  writeFileSync(
    join(linked, "scripts", "pr-lib", "gates.sh"),
    'ci_dispatch() { echo "local wrapper executed"; }\n',
  );
  git(linked, ["add", "scripts/pr-lib/gates.sh"]);
  git(linked, ["commit", "-m", "test: local wrapper"]);
  const localRevision = git(linked, ["rev-parse", "HEAD"]).stdout.trim();

  return {
    bin,
    canonical,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    env: fixtureEnv,
    git,
    linked,
    localRevision,
    root,
  };
}

function resolveCommand(command: string): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) {
      return realpathSync(candidate);
    }
  }
  throw new Error(`command not found in test PATH: ${command}`);
}

function parseSubcommandClassifications(script: string): Map<string, string> {
  const start = script.indexOf("# PR_SUBCOMMAND_CLASSIFICATIONS_BEGIN");
  const end = script.indexOf("# PR_SUBCOMMAND_CLASSIFICATIONS_END");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const table = script.slice(start, end);
  const classifications = new Map<string, string>();
  const armPattern = /^\s+([^\n)]+)\)\s*\n\s+printf '(landing|advisory)\\n'/gm;
  for (const match of table.matchAll(armPattern)) {
    const commandGroup = match[1];
    const classification = match[2];
    if (commandGroup === undefined || classification === undefined) {
      throw new Error("classification regexp returned incomplete captures");
    }
    for (const command of commandGroup.split("|").map((value) => value.trim())) {
      classifications.set(command, classification);
    }
  }
  return classifications;
}

function parseDispatchedSubcommands(script: string): string[] {
  const start = script.lastIndexOf('  case "$cmd" in');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = script.indexOf("\n  esac", start);
  expect(end).toBeGreaterThan(start);
  const commands: string[] = [];
  const armPattern = /^\s{4}([^\n)]+)\)/gm;
  for (const match of script.slice(start, end).matchAll(armPattern)) {
    const commandGroup = match[1];
    if (commandGroup === undefined) {
      throw new Error("dispatch regexp returned an incomplete capture");
    }
    commands.push(...commandGroup.split("|").map((value) => value.trim()));
  }
  return commands.filter((command) => command !== "*");
}

describe("scripts/pr wrappers", () => {
  it("keeps the main PR helper usage and command table aligned", () => {
    const script = readScript("scripts/pr");

    expect(script).toContain("export NO_COLOR=1");
    expect(script).toContain("unset COLORTERM");
    expect(script).toContain('source "$script_parent_dir/lib/plain-gh.sh"');
    expect(script).toContain("OPENCLAW_GH_BIN=");
    expect(script).toContain("for cmd in git gh jq rg pnpm node");
    expect(script).toContain('missing+=("real-gh")');
    expect(script).not.toContain("gh() {");
    expect(script).toContain("scripts/watch-pr-ci.mjs");
    expect(script).toContain("scripts/watch-pr-ci.mts");
    expect(script).toContain("scripts/verify-pr-hosted-gates.mjs");
    expect(script).toContain("scripts/verify-pr-hosted-gates.mts");
    expect(script).toContain("scripts/lib/tsx-cli-shim.mjs");
    expect(script).toContain("scripts/tsx.mjs");
    expect(script).toContain("scripts/lib/plain-gh.mjs");
    expect(script).toContain("scripts/lib/direct-run.mjs");
    expect(script).toContain("scripts/pr review-init <PR>");
    expect(script).toContain("scripts/pr prepare-run <PR>");
    expect(script).toContain("scripts/pr ci-dispatch <PR>");
    expect(script).toContain("scripts/pr merge-run <PR> [--auto-merge]");
    expect(script).toContain("OPENCLAW_PR_AUTO_MERGE=1 is equivalent");
    expect(script).toContain("Required commands: git, gh, jq, rg (ripgrep), pnpm, node.");
    expect(script).toContain('review_init "$pr"');
    expect(script).toContain('prepare_run "$pr"');
    expect(script).toContain('ci_dispatch "$pr"');
    expect(script).toContain('merge_run "$pr" "$auto_merge"');
    expect(script).toContain('require_main_target_pr "${1-}"');
    expect(script).toContain("only support PRs targeting main");
  });

  it("routes cached reads and writer-sensitive operations through their owning gh seams", () => {
    const script = readScript("scripts/pr");
    const common = readScript("scripts/pr-lib/common.sh");
    const worktree = readScript("scripts/pr-lib/worktree.sh");
    const review = readScript("scripts/pr-lib/review.sh");
    const push = readScript("scripts/pr-lib/push.sh");
    const merge = readScript("scripts/pr-lib/merge.sh");

    expect(script).toContain('base_json=$(read_pr_view_json "$pr" "baseRefName")');
    expect(common).toContain('gh pr view "$pr" --json "$fields"');
    expect(worktree).toContain('metadata=$(read_pr_view_json "$pr"');
    expect(worktree).toContain('gh_plain api --paginate "repos/{owner}/{repo}/pulls/$pr/files');
    expect(review).toContain("reviewer=$(gh_plain api user --jq .login");
    expect(review).toContain('gh_plain pr edit "$pr" --add-assignee "$reviewer"');
    expect(push).toContain('gh_plain api graphql --input - <<< "$payload"');
    expect(merge).toContain('gh_plain pr merge "$pr"');
    expect(merge).toContain('"repos/{owner}/{repo}/issues/$pr/comments"');
    expect(merge).toContain("--jq '.html_url // empty'");
    expect(merge).toContain("gh_plain api -X DELETE");
  });

  itPosix("fails loudly at preflight when ripgrep is unavailable", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      rmSync(join(fixture.bin, "rg"));
      for (const command of ["bash", "basename", "dirname", "git", "gh", "jq", "pnpm", "node"]) {
        rmSync(join(fixture.bin, command), { force: true });
        symlinkSync(resolveCommand(command), join(fixture.bin, command));
      }

      const result = spawnSync(join(fixture.canonical, "scripts", "pr"), ["ls"], {
        cwd: fixture.canonical,
        encoding: "utf8",
        env: {
          ...fixture.env,
          PATH: fixture.bin,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Missing required command(s): rg");
      expect(result.stderr).toContain("Install ripgrep and retry:");
    } finally {
      fixture.cleanup();
    }
  });

  it("classifies every dispatched subcommand", () => {
    const script = readScript("scripts/pr");
    const classifications = parseSubcommandClassifications(script);
    const dispatched = parseDispatchedSubcommands(script);

    expect([...classifications.keys()].toSorted()).toEqual(
      [...dispatched, "lock-recover"].toSorted(),
    );
    expect(classifications.get("ls")).toBe("advisory");
    expect(classifications.get("ci-dispatch")).toBe("advisory");
    for (const command of dispatched.filter((value) => !["ls", "ci-dispatch"].includes(value))) {
      expect(classifications.get(command), command).toBe("landing");
    }
  });

  it("runs a mismatched advisory wrapper locally with an explicit developer opt-in", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      const cliResult = spawnSync(
        join(fixture.linked, "scripts", "pr"),
        ["--dev-wrapper", "ci-dispatch", "123"],
        {
          cwd: fixture.linked,
          encoding: "utf8",
          env: fixture.env,
        },
      );
      expect(cliResult.status, `${cliResult.stderr}\n${cliResult.stdout}`).toBe(0);
      expect(cliResult.stdout).toContain("local wrapper executed");
      expect(cliResult.stderr).toContain(
        `WARNING: running local scripts/pr revision ${fixture.localRevision} via dev-wrapper opt-in.`,
      );
      expect(cliResult.stderr).toContain("subcommand 'ci-dispatch' is classified advisory.");
      expect(cliResult.stderr).toContain("landing subcommands remain refused");

      const envResult = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: { ...fixture.env, OPENCLAW_PR_DEV_WRAPPER: "1" },
      });
      expect(envResult.status, `${envResult.stderr}\n${envResult.stdout}`).toBe(0);
      expect(envResult.stdout).toContain("local wrapper executed");
      expect(envResult.stderr).toContain("subcommand 'ci-dispatch' is classified advisory.");
    } finally {
      fixture.cleanup();
    }
  });

  it("substitutes the anchor-matching canonical wrapper for a mismatched worktree without opt-in", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: fixture.env,
      });
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(result.stdout).toContain("canonical wrapper executed");
      expect(result.stdout).not.toContain("local wrapper executed");
      expect(result.stderr).toContain(anchorSubstitutionNotice(fixture.canonical));
      expect(result.stderr).not.toContain("Refusing to silently substitute");
    } finally {
      fixture.cleanup();
    }
  });

  it("routes a mismatched landing command to the anchor-matching canonical wrapper despite opt-in", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      const result = spawnSync(
        join(fixture.linked, "scripts", "pr"),
        ["--dev-wrapper", "prepare-run", "123"],
        { cwd: fixture.linked, encoding: "utf8", env: fixture.env },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "subcommand 'prepare-run' is classified landing; dev-wrapper opt-in is unavailable.",
      );
      expect(result.stderr).toContain(anchorSubstitutionNotice(fixture.canonical));
      // The stubbed gh reports a non-main base: reaching this gate proves the
      // canonical wrapper ran instead of the mismatched local one.
      expect(result.stderr).toContain(
        "scripts/pr prepare and merge commands only support PRs targeting main; PR #123 targets not-main.",
      );
      expect(result.stdout).not.toContain("local wrapper executed");
    } finally {
      fixture.cleanup();
    }
  });

  it("substitutes the canonical wrapper for a stale-base worktree once main moves the wrapper", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      // Stale worktree: created at the pushed main base, no local wrapper edits.
      const stale = join(fixture.root, "stale");
      const baseline = fixture.git(fixture.canonical, ["rev-parse", "main"]).stdout.trim();
      fixture.git(fixture.canonical, ["worktree", "add", "-b", "stale-feature", stale, baseline]);

      // main's wrapper then advances and the canonical checkout tracks it.
      writeFileSync(
        join(fixture.canonical, "scripts", "pr-lib", "gates.sh"),
        'ci_dispatch() { echo "canonical v2 executed"; }\n',
      );
      fixture.git(fixture.canonical, ["add", "scripts/pr-lib/gates.sh"]);
      fixture.git(fixture.canonical, ["commit", "-m", "test: wrapper v2"]);
      fixture.git(fixture.canonical, ["push", "origin", "main"]);

      const result = spawnSync(join(stale, "scripts", "pr"), ["ci-dispatch", "123"], {
        cwd: stale,
        encoding: "utf8",
        env: fixture.env,
      });
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(result.stdout).toContain("canonical v2 executed");
      expect(result.stderr).toContain(anchorSubstitutionNotice(fixture.canonical));
      expect(result.stderr).not.toContain("Refusing to silently substitute");
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps merge wrapper modes delegated to the main PR helper", () => {
    const script = readScript("scripts/pr-merge");

    expect(script).toContain("scripts/pr-merge <PR>");
    expect(script).toContain('exec "$base" merge-verify "$1"');
    expect(script).toContain('exec "$base" merge-verify "$pr"');
    expect(script).toContain('exec "$base" merge-run "$pr"');
  });

  it("defaults to squash and allows commit-preserving merge methods", () => {
    const script = readScript("scripts/pr-lib/merge.sh");

    expect(script).toContain("OPENCLAW_PR_MERGE_METHOD:-squash");
    expect(script).toContain("--squash");
    expect(script).toContain("--merge");
    expect(script).toContain("--rebase");
    expect(script).toContain("'Merged via %s.");
    expect(script).toContain("--auto");
    expect(script).toContain('--match-head-commit "$PREP_HEAD_SHA"');
  });

  it("keeps prepare wrapper modes delegated to the main PR helper", () => {
    const script = readScript("scripts/pr-prepare");

    expect(script).toContain("scripts/pr-prepare <init|validate-commit|gates|push|run> <PR>");
    for (const mode of ["init", "validate-commit", "gates", "push", "run"]) {
      expect(script).toContain(`${mode})`);
    }
    expect(script).toContain('exec "$base" prepare-init "$pr"');
    expect(script).toContain('exec "$base" prepare-validate-commit "$pr"');
    expect(script).toContain('exec "$base" prepare-gates "$pr"');
    expect(script).toContain('exec "$base" prepare-push "$pr"');
    expect(script).toContain('exec "$base" prepare-run "$pr"');
  });

  it("keeps review wrapper delegated to review-init", () => {
    const script = readScript("scripts/pr-review");

    expect(script).toContain('base="$script_dir/pr"');
    expect(script).toContain('exec "$base" review-init "$@"');
  });

  it("refuses to substitute a different canonical wrapper implementation", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-pr-wrapper-revision-"));
    const repo = join(dir, "repo");
    const linked = join(dir, "linked");
    mkdirSync(join(repo, "scripts", "lib"), { recursive: true });
    mkdirSync(join(repo, "scripts", "pr-lib"), { recursive: true });
    writeFileSync(join(repo, "scripts", "pr"), readScript("scripts/pr"));
    writeFileSync(join(repo, "scripts", "lib", "plain-gh.sh"), "# canonical\n");
    writeFileSync(join(repo, "scripts", "lib", "plain-gh.mjs"), "// canonical\n");
    writeFileSync(join(repo, "scripts", "lib", "direct-run.mjs"), "// canonical\n");
    writeFileSync(join(repo, "scripts", "lib", "tsx-cli-shim.mjs"), "// canonical\n");
    writeFileSync(join(repo, "scripts", "lib", "local-check-runtime.mts"), "// canonical\n");
    writeFileSync(join(repo, "scripts", "tsx.mjs"), "// canonical\n");
    writeFileSync(join(repo, "scripts", "watch-pr-ci.mjs"), "// canonical\n");
    writeFileSync(join(repo, "scripts", "watch-pr-ci.mts"), "// canonical\n");
    writeFileSync(join(repo, "scripts", "verify-pr-hosted-gates.mjs"), "// canonical\n");
    writeFileSync(join(repo, "scripts", "verify-pr-hosted-gates.mts"), "// canonical\n");
    writeFileSync(join(repo, "scripts", "pr-lib", "merge.sh"), "# canonical\n");
    chmodSync(join(repo, "scripts", "pr"), 0o755);

    const git = (cwd: string, args: string[]) =>
      spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    expect(git(repo, ["init", "-b", "main"]).status).toBe(0);
    expect(git(repo, ["config", "user.name", "OpenClaw Test"]).status).toBe(0);
    expect(git(repo, ["config", "user.email", "test@example.invalid"]).status).toBe(0);
    expect(git(repo, ["add", "scripts"]).status).toBe(0);
    expect(git(repo, ["commit", "-m", "test: canonical wrapper"]).status).toBe(0);
    expect(git(repo, ["worktree", "add", "-b", "feature", linked]).status).toBe(0);

    for (const component of [
      "scripts/pr-lib/merge.sh",
      "scripts/watch-pr-ci.mts",
      "scripts/verify-pr-hosted-gates.mts",
      "scripts/lib/local-check-runtime.mts",
    ]) {
      writeFileSync(join(linked, component), "# dirty linked\n");
      const dirtyResult = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
        cwd: linked,
        encoding: "utf8",
      });
      expect(dirtyResult.status, component).toBe(1);
      expect(dirtyResult.stderr, component).toContain(
        "scripts/pr wrapper files have uncommitted changes",
      );
      expect(git(linked, ["restore", component]).status).toBe(0);
    }

    writeFileSync(join(linked, "scripts", "tsx.mjs"), "// dirty preloader\n");
    const dirtyPreloaderResult = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
      cwd: linked,
      encoding: "utf8",
    });
    expect(dirtyPreloaderResult.status).toBe(1);
    expect(dirtyPreloaderResult.stderr).toContain(
      "scripts/pr wrapper files have uncommitted changes",
    );
    expect(git(linked, ["restore", "scripts/tsx.mjs"]).status).toBe(0);

    // A dirty canonical checkout no longer blocks a linked worktree whose
    // committed wrapper matches the origin/main trust anchor; without that
    // anchor it must still refuse.
    writeFileSync(join(repo, "scripts", "pr-lib", "merge.sh"), "# dirty canonical\n");
    const dirtyResult = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
      cwd: linked,
      encoding: "utf8",
    });
    expect(dirtyResult.status).toBe(1);
    expect(dirtyResult.stderr).toContain(
      "scripts/pr implementation differs between this worktree and the canonical checkout",
    );
    expect(git(repo, ["restore", "scripts/pr-lib/merge.sh"]).status).toBe(0);

    writeFileSync(join(linked, "scripts", "lib", "local-check-runtime.mts"), "// linked\n");
    expect(git(linked, ["add", "scripts/lib/local-check-runtime.mts"]).status).toBe(0);
    expect(git(linked, ["commit", "-m", "test: linked wrapper"]).status).toBe(0);

    const result = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
      cwd: linked,
      encoding: "utf8",
    });
    rmSync(dir, { recursive: true, force: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "scripts/pr implementation differs between this worktree and the canonical checkout",
    );
    expect(result.stderr).toContain("scripts/lib/local-check-runtime.mts");
  });

  it("runs the local wrapper when it matches origin/main and the canonical checkout is parked elsewhere", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-pr-wrapper-anchor-"));
    const repo = join(dir, "repo");
    const linked = join(dir, "linked");
    mkdirSync(join(repo, "scripts", "lib"), { recursive: true });
    mkdirSync(join(repo, "scripts", "pr-lib"), { recursive: true });
    writeFileSync(join(repo, "scripts", "pr"), readScript("scripts/pr"));
    writeFileSync(join(repo, "scripts", "lib", "plain-gh.sh"), "# canonical\n");
    writeFileSync(join(repo, "scripts", "lib", "plain-gh.mjs"), "// canonical\n");
    writeFileSync(join(repo, "scripts", "lib", "direct-run.mjs"), "// canonical\n");
    writeFileSync(join(repo, "scripts", "lib", "tsx-cli-shim.mjs"), "// canonical\n");
    writeFileSync(join(repo, "scripts", "lib", "local-check-runtime.mts"), "// canonical\n");
    writeFileSync(join(repo, "scripts", "tsx.mjs"), "// canonical\n");
    writeFileSync(join(repo, "scripts", "watch-pr-ci.mjs"), "// canonical\n");
    writeFileSync(join(repo, "scripts", "watch-pr-ci.mts"), "// canonical\n");
    writeFileSync(join(repo, "scripts", "verify-pr-hosted-gates.mjs"), "// canonical\n");
    writeFileSync(join(repo, "scripts", "verify-pr-hosted-gates.mts"), "// canonical\n");
    writeFileSync(join(repo, "scripts", "pr-lib", "merge.sh"), "# canonical\n");
    chmodSync(join(repo, "scripts", "pr"), 0o755);

    const git = (cwd: string, args: string[]) =>
      spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    expect(git(repo, ["init", "-b", "main"]).status).toBe(0);
    expect(git(repo, ["config", "user.name", "OpenClaw Test"]).status).toBe(0);
    expect(git(repo, ["config", "user.email", "test@example.invalid"]).status).toBe(0);
    expect(git(repo, ["add", "scripts"]).status).toBe(0);
    expect(git(repo, ["commit", "-m", "test: canonical wrapper"]).status).toBe(0);
    // The linked worktree keeps main's wrapper; origin/main anchors trust.
    expect(git(repo, ["update-ref", "refs/remotes/origin/main", "main"]).status).toBe(0);
    expect(git(repo, ["worktree", "add", "-b", "feature", linked]).status).toBe(0);

    // Park the canonical checkout on a release-style branch with a different
    // wrapper revision, the exact contention that used to block landings.
    expect(git(repo, ["switch", "-c", "release/test-train"]).status).toBe(0);
    writeFileSync(join(repo, "scripts", "pr-lib", "merge.sh"), "# release drift\n");
    expect(git(repo, ["add", "scripts/pr-lib/merge.sh"]).status).toBe(0);
    expect(git(repo, ["commit", "-m", "test: release drift"]).status).toBe(0);

    const result = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
      cwd: linked,
      encoding: "utf8",
    });

    expect(result.stderr).not.toContain("Refusing to silently substitute");
    expect(result.stderr).not.toContain("scripts/pr implementation differs");
    expect(result.stderr).not.toContain("differing wrapper components vs origin/main");
    expect(result.stderr).not.toContain("uncommitted changes");

    // A local branch literally named "origin/main" must not spoof the trust
    // anchor: only the remote-tracking ref counts.
    expect(git(repo, ["update-ref", "-d", "refs/remotes/origin/main"]).status).toBe(0);
    expect(git(repo, ["update-ref", "refs/heads/origin/main", "main"]).status).toBe(0);
    const spoofed = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
      cwd: linked,
      encoding: "utf8",
    });
    rmSync(dir, { recursive: true, force: true });

    expect(spoofed.status).toBe(1);
    expect(spoofed.stderr).toContain(
      "scripts/pr implementation differs between this worktree and the canonical checkout",
    );
  });

  it("verifies local GitHub auth through GraphQL when REST quota is unavailable", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-pr-auth-"));
    const gh = join(dir, "gh");
    writeFileSync(
      gh,
      `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  printf 'monalisa\\n'
  exit 0
fi
exit 1
`,
    );
    chmodSync(gh, 0o755);

    const result = spawnSync(
      "bash",
      [
        "-c",
        "source scripts/lib/plain-gh.sh; source scripts/pr-lib/worktree.sh; ensure_gh_api_auth",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, OPENCLAW_GH_BIN: gh },
        encoding: "utf8",
      },
    );
    rmSync(dir, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("resolves review writer identity and assignment through the real GitHub CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-pr-review-writer-"));
    const bin = join(dir, "bin");
    const pathCalls = join(dir, "path-calls.log");
    const realCalls = join(dir, "real-calls.log");
    const realGh = join(dir, "real-gh");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh
printf '%s\n' "$*" >> "$OPENCLAW_TEST_PATH_CALLS"
exit 9
`,
    );
    writeFileSync(
      realGh,
      `#!/bin/sh
printf '%s\n' "$*" >> "$OPENCLAW_TEST_REAL_CALLS"
case "$1 $2" in
  "api user") printf 'maintainer\n' ;;
  "pr edit") exit 0 ;;
  *) exit 2 ;;
esac
`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    chmodSync(realGh, 0o755);

    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "source scripts/lib/plain-gh.sh",
          "source scripts/pr-lib/review.sh",
          'enter_worktree() { cd "$OPENCLAW_TEST_ROOT"; mkdir -p .local; }',
          "mark_pr_operation_side_effects_started() { :; }",
          "print_relevant_log_excerpt() { :; }",
          "review_claim 42",
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_GH_BIN: realGh,
          OPENCLAW_TEST_PATH_CALLS: pathCalls,
          OPENCLAW_TEST_REAL_CALLS: realCalls,
          OPENCLAW_TEST_ROOT: dir,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );
    const realInvocations = readFileSync(realCalls, "utf8");
    rmSync(dir, { recursive: true, force: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(realInvocations).toContain("api user --jq .login");
    expect(realInvocations).toContain("pr edit 42 --add-assignee maintainer");
    expect(existsSync(pathCalls)).toBe(false);
  });
});
