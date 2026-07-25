// PR wrapper tests cover maintainer helper command delegation.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

function readScript(path: string): string {
  return readFileSync(path, "utf8");
}

const canonicalMismatchMessage = (repo: string) =>
  [
    "scripts/pr implementation differs between this worktree and the canonical checkout, and does not match origin/main.",
    `Refusing to silently substitute canonical wrapper code from: ${repo}`,
    "Run scripts/pr from a checkout whose wrapper matches the canonical checkout or a fetched origin/main.",
    "",
  ].join("\n");

function makeMismatchedWrapperRepo() {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "openclaw-pr-dev-wrapper-")));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const canonicalPath = join(root, "canonical");
  const linkedPath = join(root, "linked");
  const originPath = join(root, "origin.git");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(bin, "rg"), "#!/usr/bin/env sh\nexit 0\n");
  chmodSync(join(bin, "rg"), 0o755);

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
  writeFileSync(
    join(canonical, "scripts", "lib", "plain-gh.sh"),
    "resolve_plain_gh_bin() { printf '/usr/bin/true\\n'; }\ngh_plain() { :; }\n",
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
    canonical,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    env: fixtureEnv,
    linked,
    localRevision,
  };
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
    expect(script).toContain("gh_plain");
    expect(script).toContain("scripts/pr review-init <PR>");
    expect(script).toContain("scripts/pr prepare-run <PR>");
    expect(script).toContain("scripts/pr ci-dispatch <PR>");
    expect(script).toContain("scripts/pr merge-run <PR>");
    expect(script).toContain('review_init "$pr"');
    expect(script).toContain('prepare_run "$pr"');
    expect(script).toContain('ci_dispatch "$pr"');
    expect(script).toContain('merge_run "$pr"');
    expect(script).toContain('require_main_target_pr "${1-}"');
    expect(script).toContain("only support PRs targeting main");
  });

  it("classifies every dispatched subcommand", () => {
    const script = readScript("scripts/pr");
    const classifications = parseSubcommandClassifications(script);
    const dispatched = parseDispatchedSubcommands(script);

    expect([...classifications.keys()].sort()).toEqual([...dispatched, "lock-recover"].sort());
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

  it("keeps the existing mismatch refusal for advisory commands without opt-in", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: fixture.env,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(canonicalMismatchMessage(fixture.canonical));
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses developer opt-in for a mismatched landing command", () => {
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
      expect(result.stderr).toContain(canonicalMismatchMessage(fixture.canonical).trim());
      expect(result.stdout).not.toContain("local wrapper executed");
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
    expect(script).toContain('echo "Merged via $merge_label."');
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

    writeFileSync(join(linked, "scripts", "pr-lib", "merge.sh"), "# dirty linked\n");
    const dirtyLinkedResult = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
      cwd: linked,
      encoding: "utf8",
    });
    expect(dirtyLinkedResult.status).toBe(1);
    expect(dirtyLinkedResult.stderr).toContain("scripts/pr wrapper files have uncommitted changes");
    expect(git(linked, ["restore", "scripts/pr-lib/merge.sh"]).status).toBe(0);

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

    writeFileSync(join(linked, "scripts", "pr-lib", "merge.sh"), "# linked\n");
    expect(git(linked, ["add", "scripts/pr-lib/merge.sh"]).status).toBe(0);
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
  });

  it("runs the local wrapper when it matches origin/main and the canonical checkout is parked elsewhere", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-pr-wrapper-anchor-"));
    const repo = join(dir, "repo");
    const linked = join(dir, "linked");
    mkdirSync(join(repo, "scripts", "lib"), { recursive: true });
    mkdirSync(join(repo, "scripts", "pr-lib"), { recursive: true });
    writeFileSync(join(repo, "scripts", "pr"), readScript("scripts/pr"));
    writeFileSync(join(repo, "scripts", "lib", "plain-gh.sh"), "# canonical\n");
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
});
