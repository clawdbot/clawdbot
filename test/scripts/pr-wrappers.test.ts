// PR wrapper tests cover maintainer helper command delegation.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REVIEWED_HEAD,
  REVIEWED_PR,
  validReview,
  writeReviewArtifacts,
} from "./pr-review-artifact-fixture.js";
import { copyPrWrapperSources } from "./pr-wrapper.test-support.js";

function readScript(path: string): string {
  return readFileSync(path, "utf8");
}

const anchorSubstitutionNotice = (repo: string) =>
  `scripts/pr wrapper in this worktree differs from origin/main; running the canonical checkout's wrapper (matches the origin/main trust anchor): ${repo}`;
const itPosix = process.platform === "win32" ? it.skip : it;

function isolatedWrapperEnv(root: string) {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: home,
    PATH: `${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}`,
    TMPDIR: root,
    XDG_CONFIG_HOME: join(home, ".config"),
    GH_CONFIG_DIR: join(home, "gh"),
  };
}

function makeMismatchedWrapperRepo({
  realModules = false,
  dispatchBody = 'echo "canonical wrapper executed";',
} = {}) {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "openclaw-pr-dev-wrapper-")));
  const bin = join(root, "bin");
  const canonicalPath = join(root, "canonical");
  const linkedPath = join(root, "linked");
  const originPath = join(root, "origin.git");
  mkdirSync(bin, { recursive: true });
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
    '#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then\n  printf \'{"baseRefName":"not-main"}\\n\'\n  exit 0\nfi\necho "Unexpected gh call: $*" >&2\nexit 99\n',
  );
  chmodSync(ghStub, 0o755);

  const fixtureEnv = isolatedWrapperEnv(root);
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
  copyPrWrapperSources(canonical);
  // Marker stub committed to main (the origin/main anchor), so tests can tell
  // an anchor-substituted canonical run apart from a local wrapper run.
  if (!realModules)
    writeFileSync(
      join(canonical, "scripts", "pr-lib", "gates.sh"),
      `ci_dispatch() { ${dispatchBody} }\n`,
    );
  chmodSync(join(canonical, "scripts", "pr"), 0o755);

  git(canonical, ["config", "user.name", "OpenClaw Test"]);
  git(canonical, ["config", "user.email", "test@example.invalid"]);
  git(canonical, ["config", "commit.gpgSign", "false"]);
  git(canonical, ["config", "core.hooksPath", "/dev/null"]);
  git(canonical, ["remote", "add", "origin", origin]);
  git(canonical, ["add", "."]);
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

  if (realModules) {
    mkdirSync(join(canonical, "node_modules"));
    // Use installed third-party packages only, never workspace source or loader mocks.
    for (const dependency of ["tsx", "zod", "minimatch", "yaml"]) {
      symlinkSync(
        realpathSync(join("node_modules", dependency)),
        join(canonical, "node_modules", dependency),
      );
    }
  }

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
    expect(script).toContain("for cmd in git gh jq rg pnpm node");
    expect(script).not.toContain("gh() {");
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

  itPosix("preserves the caller's gh route environment through startup", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      cpSync("scripts/lib/plain-gh.sh", join(fixture.canonical, "scripts/lib/plain-gh.sh"));
      writeFileSync(
        join(fixture.canonical, "scripts/pr-lib/worktree.sh"),
        `list_pr_worktrees() { /bin/sh -c 'printf "%s\\n" "\${OPENCLAW_GH_BIN-absent}"'; }\n`,
      );
      for (const override of [undefined, "", join(fixture.bin, "gh")]) {
        const result = spawnSync(join(fixture.canonical, "scripts/pr"), ["ls"], {
          cwd: fixture.canonical,
          encoding: "utf8",
          env: { ...fixture.env, OPENCLAW_GH_BIN: override },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(`${override ?? "absent"}\n`);
      }
    } finally {
      fixture.cleanup();
    }
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
    expect(review).toContain('gh_plain pr edit "$pr" --add-assignee "$reviewer"');
    expect(push).toContain('gh_plain api graphql --input - <<< "$payload"');
    expect(merge).toContain('gh_plain pr merge "$pr"');
    expect(merge).toContain('"repos/$repo_nwo/issues/$pr/comments"');
    expect(merge).toContain("--jq '.html_url // empty'");
    expect(merge).toContain('git push --force-with-lease="refs/heads/$head_ref:$PREP_HEAD_SHA"');
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

  itPosix("requires a separate operator confirmation for merge recovery", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      for (const args of [
        ["123", "a".repeat(40)],
        ["123", "", "--confirmed-operator-recovery"],
        ["123", "not-an-outcome", "--confirmed-operator-recovery"],
        ["123", "a".repeat(40), "--confirmed-no-running-tools"],
        ["123", "a".repeat(40), "--confirmed-operator-recovery", "--auto-merge"],
      ]) {
        const result = spawnSync(
          join(fixture.canonical, "scripts", "pr"),
          ["merge-recover", ...args],
          { cwd: fixture.canonical, encoding: "utf8", env: fixture.env },
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
        expect(result.stdout).toContain("Usage:");
        expect(result.stderr).not.toContain("only support PRs targeting main");
      }
    } finally {
      fixture.cleanup();
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

  it.each(["prepare-run", "merge-recover"])(
    "routes mismatched %s to the canonical wrapper despite opt-in",
    (command) => {
      const fixture = makeMismatchedWrapperRepo();
      try {
        const result = spawnSync(
          join(fixture.linked, "scripts", "pr"),
          [
            "--dev-wrapper",
            command,
            "123",
            ...(command === "merge-recover"
              ? ["a".repeat(40), "--confirmed-operator-recovery"]
              : []),
          ],
          { cwd: fixture.linked, encoding: "utf8", env: fixture.env },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          `subcommand '${command}' is classified landing; dev-wrapper opt-in is unavailable.`,
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
    },
  );

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

  // Parks the canonical checkout on a diverging branch so neither the linked
  // worktree nor canonical matches the fetched origin/main anchor — the shape
  // that previously refused and forced a rebase.
  function parkCanonicalOffAnchor(fixture: ReturnType<typeof makeMismatchedWrapperRepo>) {
    fixture.git(fixture.canonical, ["checkout", "-b", "parked"]);
    writeFileSync(
      join(fixture.canonical, "scripts", "pr-lib", "gates.sh"),
      'ci_dispatch() { echo "parked canonical executed"; }\n',
    );
    fixture.git(fixture.canonical, ["add", "scripts/pr-lib/gates.sh"]);
    fixture.git(fixture.canonical, ["commit", "-m", "test: parked canonical wrapper"]);
  }

  function materializeAnchor(fixture: ReturnType<typeof makeMismatchedWrapperRepo>) {
    const materialized = spawnSync(join(fixture.linked, "scripts/pr"), ["unknown-command"], {
      cwd: fixture.linked,
      encoding: "utf8",
      env: fixture.env,
    });
    expect(materialized.status, materialized.stderr).toBe(2);
    expect(materialized.stderr).toContain("running wrapper code materialized from");
    const anchors = readdirSync(fixture.root).filter((name) =>
      name.startsWith("openclaw-pr-anchor."),
    );
    expect(anchors).toHaveLength(1);
    const anchor = join(fixture.root, anchors[0]!);
    expect(statSync(anchor).mode & 0o777).toBe(0o700);
    return anchor;
  }

  function advanceAnchorReviewDependency(fixture: ReturnType<typeof makeMismatchedWrapperRepo>) {
    const dependency = "scripts/lib/anchor-review-record.mjs";
    cpSync("scripts/lib/record-shared.mjs", join(fixture.canonical, dependency));
    const inventory = "scripts/pr-lib/wrapper-components.txt";
    writeFileSync(
      join(fixture.canonical, inventory),
      `${readScript(join(fixture.canonical, inventory))}${dependency}\n`,
    );
    const helper = join(fixture.canonical, "scripts/pr-lib/review-artifacts.mjs");
    writeFileSync(
      helper,
      readScript(helper).replace("../lib/record-shared.mjs", "../lib/anchor-review-record.mjs"),
    );
    fixture.git(fixture.canonical, [
      "add",
      inventory,
      dependency,
      "scripts/pr-lib/review-artifacts.mjs",
    ]);
    fixture.git(fixture.canonical, ["commit", "-m", "test: anchor-only review dependency"]);
    fixture.git(fixture.canonical, ["push", "origin", "main"]);
  }

  it("materializes the origin/main anchor wrapper when canonical is parked elsewhere", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      parkCanonicalOffAnchor(fixture);
      const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: fixture.env,
      });
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      // The anchor (pushed main) marker proves materialized anchor code ran,
      // not the linked worktree's wrapper and not the parked canonical one.
      expect(result.stdout).toContain("canonical wrapper executed");
      expect(result.stdout).not.toContain("local wrapper executed");
      expect(result.stdout).not.toContain("parked canonical executed");
      expect(result.stderr).toContain(
        "running wrapper code materialized from the refs/remotes/origin/main trust anchor",
      );
      expect(result.stderr).not.toContain("Refusing to silently substitute");
    } finally {
      fixture.cleanup();
    }
  });

  itPosix("executes extracted helpers through a symlinked temporary root", () => {
    const fixture = makeMismatchedWrapperRepo({ realModules: true });
    try {
      // Exercise the wrapper's own helper path, not a physical path reconstructed by the test.
      writeFileSync(
        join(fixture.canonical, "scripts/pr-lib/gates.sh"),
        `ci_dispatch() { node "$(review_artifacts_helper_path)" template "$1" "${REVIEWED_HEAD}"; }\n`,
      );
      fixture.git(fixture.canonical, ["add", "scripts/pr-lib/gates.sh"]);
      fixture.git(fixture.canonical, ["commit", "-m", "test: real anchor helper dispatch"]);
      fixture.git(fixture.canonical, ["push", "origin", "main"]);
      parkCanonicalOffAnchor(fixture);
      const temporaryAlias = join(fixture.root, "temporary-alias");
      symlinkSync(fixture.root, temporaryAlias, "dir");
      const result = spawnSync(
        join(fixture.linked, "scripts/pr"),
        ["ci-dispatch", String(REVIEWED_PR)],
        {
          cwd: fixture.linked,
          encoding: "utf8",
          env: { ...fixture.env, TMPDIR: temporaryAlias },
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain("running wrapper code materialized from");
      expect(result.stdout, "the extracted helper must not silently skip its entrypoint").toContain(
        REVIEWED_HEAD,
      );
      expect(JSON.parse(result.stdout).pr).toEqual({ number: REVIEWED_PR, headSha: REVIEWED_HEAD });
    } finally {
      fixture.cleanup();
    }
  });

  itPosix.each(["parked", "dirty added dependency"])(
    "executes review artifacts from the extracted anchor dependency closure with canonical %s",
    (canonicalState) => {
      const fixture = makeMismatchedWrapperRepo({ realModules: true });
      try {
        advanceAnchorReviewDependency(fixture);
        if (canonicalState === "parked") {
          parkCanonicalOffAnchor(fixture);
        } else {
          writeFileSync(
            join(fixture.canonical, "scripts/lib/anchor-review-record.mjs"),
            "throw new Error('unreviewed dependency');\n",
          );
        }
        const anchor = materializeAnchor(fixture);
        writeFileSync(join(fixture.bin, "gh"), "#!/bin/sh\necho forbidden-gh >&2\nexit 99\n");
        writeReviewArtifacts(fixture.linked, validReview());
        const result = spawnSync(
          "bash",
          [
            "-c",
            [
              "set -euo pipefail",
              'script_parent_dir="$1/scripts"',
              'source "$script_parent_dir/pr-lib/review.sh"',
              'node "$(review_artifacts_helper_path)" template "$2" "$3"',
              'node "$(review_artifacts_helper_path)" validate .local/review.json .local/review.md .local/pr-meta.json',
            ].join("\n"),
            "anchor-review",
            anchor,
            String(REVIEWED_PR),
            REVIEWED_HEAD,
          ],
          {
            cwd: fixture.linked,
            encoding: "utf8",
            env: fixture.env,
          },
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(JSON.parse(result.stdout).pr).toEqual({
          number: REVIEWED_PR,
          headSha: REVIEWED_HEAD,
        });
      } finally {
        fixture.cleanup();
      }
    },
  );

  itPosix(
    "executes tooling and publisher code from the extracted anchor dependency closure",
    () => {
      const fixture = makeMismatchedWrapperRepo({ realModules: true });
      try {
        parkCanonicalOffAnchor(fixture);
        const anchor = materializeAnchor(fixture);
        writeFileSync(join(fixture.bin, "gh"), "#!/bin/sh\necho forbidden-gh >&2\nexit 99\n");
        const run = (args: string[]) =>
          spawnSync(process.execPath, args, {
            cwd: anchor,
            encoding: "utf8",
            env: fixture.env,
          });
        // These .mjs files launch children at import time. Execute the real shims
        // with invalid arguments so their .mts owners reject before any GitHub IO.
        for (const [entry, exitCode, message] of [
          ["watch-pr-ci.mjs", 2, "Usage: node scripts/watch-pr-ci.mjs"],
          ["verify-pr-hosted-gates.mjs", 1, "Usage: node scripts/verify-pr-hosted-gates.mjs"],
          ["pr-lib/ci-dispatch.mjs", 2, "Usage: ci-dispatch.mjs"],
        ] as const) {
          const result = run([join(anchor, "scripts", entry)]);
          expect.soft(result.status, `${entry}\n${result.stdout}\n${result.stderr}`).toBe(exitCode);
          expect.soft(result.stderr, entry).toContain(message);
        }
        const attribution = run([
          "scripts/check-changelog-attributions.mjs",
          "--is-forbidden-handle",
          "fixture[bot]",
        ]);
        expect.soft(attribution.status, attribution.stderr).toBe(0);
        const bypass = run([
          "--input-type=module",
          "-e",
          "await import('./scripts/pr-lib/crabbox-merge-bypass.mjs')",
        ]);
        expect.soft(bypass.status, bypass.stderr).toBe(0);

        const plan = {
          version: 1,
          baseSha: "a".repeat(40),
          headSha: REVIEWED_HEAD,
          changedPaths: [{ path: "docs/example.md", status: "M" }],
          targets: [],
        };
        const planFile = join(fixture.root, "plan.json");
        writeFileSync(planFile, JSON.stringify(plan));
        const publisher = run([
          "scripts/pr-crabbox-gate-publisher.mjs",
          "--print-command",
          planFile,
          "c".repeat(64),
        ]);
        expect.soft(publisher.status, publisher.stderr).toBe(0);
        expect.soft(publisher.stdout).toContain(`OPENCLAW_CRABBOX_GATE_HEAD=${REVIEWED_HEAD}`);
        expect.soft(publisher.stdout).toContain("OPENCLAW_CRABBOX_GATE_TARGET_COUNT=0");
        expect.soft(publisher.stdout).toContain("pnpm build");
        expect.soft(publisher.stdout).toContain("pnpm check");

        // The trusted planner reads candidate sources without executing them. A
        // non-sibling importer exercises its real source-scanning child as well.
        mkdirSync(join(fixture.linked, "src"));
        mkdirSync(join(fixture.linked, "test/probe"), { recursive: true });
        writeFileSync(join(fixture.linked, "src/anchor-value.ts"), "export const value = 1;\n");
        writeFileSync(
          join(fixture.linked, "test/probe/anchor.test.ts"),
          'import { value } from "../../src/anchor-value.js";\nvoid value;\n',
        );
        fixture.git(fixture.linked, ["add", "src", "test/probe"]);
        fixture.git(fixture.linked, ["commit", "-m", "test: candidate import graph"]);
        const base = fixture.git(fixture.linked, ["rev-parse", "HEAD"]).stdout.trim();
        writeFileSync(join(fixture.linked, "src/anchor-value.ts"), "export const value = 2;\n");
        fixture.git(fixture.linked, ["add", "src/anchor-value.ts"]);
        fixture.git(fixture.linked, ["commit", "-m", "test: candidate change"]);
        const head = fixture.git(fixture.linked, ["rev-parse", "HEAD"]).stdout.trim();
        const planned = spawnSync(
          process.execPath,
          [join(anchor, "scripts/pr-lib/crabbox-gate-plan.mts"), "--base", base, "--head", head],
          {
            cwd: fixture.linked,
            encoding: "utf8",
            env: fixture.env,
          },
        );
        expect(planned.status, planned.stderr).toBe(0);
        expect(JSON.parse(planned.stdout)).toMatchObject({
          baseSha: base,
          headSha: head,
          changedPaths: [{ path: "src/anchor-value.ts", status: "M" }],
          targets: ["test/probe/anchor.test.ts"],
        });
      } finally {
        fixture.cleanup();
      }
    },
  );

  itPosix("refuses an extracted anchor with a tampered dependency", () => {
    const fixture = makeMismatchedWrapperRepo({ realModules: true });
    try {
      advanceAnchorReviewDependency(fixture);
      parkCanonicalOffAnchor(fixture);
      const tar = join(fixture.bin, "tar");
      writeFileSync(
        tar,
        `#!/bin/sh
"$OPENCLAW_TEST_TAR" "$@" || exit
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then
    printf '\\n// tampered\\n' >> "$2/scripts/lib/anchor-review-record.mjs"
    exit
  fi
  shift
done
exit 99
`,
      );
      chmodSync(tar, 0o755);
      const result = spawnSync(join(fixture.linked, "scripts/pr"), ["unknown-command"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: { ...fixture.env, OPENCLAW_TEST_TAR: resolveCommand("tar") },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain("Refusing to silently substitute");
      expect(result.stderr).not.toContain("running wrapper code materialized from");
      expect(
        readdirSync(fixture.root).filter((name) => name.startsWith("openclaw-pr-anchor.")),
      ).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("routes a mismatched landing subcommand through the materialized anchor", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      parkCanonicalOffAnchor(fixture);
      const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["prepare-run", "123"], {
        cwd: fixture.linked,
        encoding: "utf8",
        env: fixture.env,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "running wrapper code materialized from the refs/remotes/origin/main trust anchor",
      );
      // The stubbed gh reports a non-main base: reaching this gate proves the
      // materialized anchor wrapper ran the landing subcommand.
      expect(result.stderr).toContain(
        "scripts/pr prepare and merge commands only support PRs targeting main; PR #123 targets not-main.",
      );
      expect(result.stderr).not.toContain("Refusing to silently substitute");
    } finally {
      fixture.cleanup();
    }
  });

  it("initializes stamped review artifacts through the materialized anchor", () => {
    const fixture = makeMismatchedWrapperRepo();
    try {
      writeFileSync(
        join(fixture.bin, "gh"),
        `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  printf 'fixture-user\\n'
  exit 0
fi
echo "Unexpected gh call: $*" >&2
exit 99
`,
      );
      const reviewRoot = join(fixture.canonical, ".worktrees", "pr-123");
      fixture.git(fixture.canonical, [
        "worktree",
        "add",
        "--detach",
        reviewRoot,
        fixture.localRevision,
      ]);
      mkdirSync(join(reviewRoot, ".local"));
      writeFileSync(join(reviewRoot, ".local", "pr-meta.env"), "PR_NUMBER=123\n");
      writeFileSync(
        join(reviewRoot, ".local", "pr-meta.json"),
        JSON.stringify({ number: 123, headRefOid: fixture.localRevision, files: [] }),
      );
      parkCanonicalOffAnchor(fixture);
      const result = spawnSync(
        join(fixture.linked, "scripts", "pr"),
        ["review-artifacts-init", "123"],
        {
          cwd: fixture.linked,
          encoding: "utf8",
          env: { ...fixture.env, TMPDIR: fixture.root },
        },
      );
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(result.stderr).toContain("running wrapper code materialized from");
      expect(JSON.parse(readScript(join(reviewRoot, ".local", "review.json"))).pr).toEqual({
        number: 123,
        headSha: fixture.localRevision,
      });
      expect(readScript(join(reviewRoot, ".local", "review.md")).split("\n")[0]).toBe(
        `Review artifact for PR #123 at ${fixture.localRevision}`,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    {
      script: "verify-pr-hosted-gates.mjs",
      args: "--anchor-proof",
      status: 1,
      output: "Unknown option: --anchor-proof",
      dependency: "minimatch",
      binding: "minimatch",
    },
    {
      script: "watch-pr-ci.mjs",
      args: "--help",
      status: 2,
      output: "Usage:",
      dependency: "zod",
      binding: "z",
    },
    {
      script: "check-changelog-attributions.mjs",
      args: "--is-forbidden-handle codex",
      status: 0,
      output: "",
      dependency: undefined,
      binding: undefined,
    },
  ])(
    "loads $script from the materialized anchor without caller-owned aliases",
    ({ script, args, status, output, dependency, binding }) => {
      const fixture = makeMismatchedWrapperRepo({
        dispatchBody: `node "$script_parent_dir/${script}" ${args};`,
      });
      try {
        if (dependency) {
          symlinkSync(
            realpathSync("node_modules"),
            join(fixture.canonical, "node_modules"),
            process.platform === "win32" ? "junction" : "dir",
          );
          writeFileSync(
            join(fixture.linked, "caller-dependency.mts"),
            `export const ${binding} = null;\nthrow new Error("caller workspace dependency executed");\n`,
          );
          writeFileSync(
            join(fixture.linked, "tsconfig.json"),
            JSON.stringify({
              compilerOptions: {
                paths: {
                  [dependency]: ["./caller-dependency.mts"],
                  "@openclaw/normalization-core/record-coerce": [
                    "./packages/normalization-core/src/record-coerce.ts",
                  ],
                },
              },
            }),
          );
          fixture.git(fixture.linked, ["add", "caller-dependency.mts", "tsconfig.json"]);
          fixture.git(fixture.linked, ["commit", "-m", "test: caller-owned dependency aliases"]);
        }
        if (script === "verify-pr-hosted-gates.mjs") {
          const recordPath = "packages/normalization-core/src/record-coerce.ts";
          writeFileSync(
            join(fixture.linked, recordPath),
            `throw new Error("caller workspace normalization executed");\n${readScript(recordPath)}`,
          );
          fixture.git(fixture.linked, ["add", recordPath]);
          fixture.git(fixture.linked, ["commit", "-m", "test: caller-owned normalization"]);
        }
        parkCanonicalOffAnchor(fixture);
        const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
          cwd: fixture.linked,
          encoding: "utf8",
          env: { ...fixture.env, TMPDIR: fixture.root },
        });
        expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(status);
        expect(result.stderr).toContain("running wrapper code materialized from");
        if (output) {
          expect(`${result.stdout}${result.stderr}`).toContain(output);
        }
        expect(`${result.stdout}${result.stderr}`).not.toContain("Cannot find module");
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.each([
    { script: "watch-pr-ci.mjs", dependency: "zod" },
    { script: "verify-pr-hosted-gates.mjs", dependency: "minimatch" },
  ])(
    "reports the missing $dependency toolchain without installing dependencies",
    ({ script, dependency }) => {
      const fixture = makeMismatchedWrapperRepo({
        dispatchBody: `node "$script_parent_dir/${script}" --help;`,
      });
      try {
        writeFileSync(
          join(fixture.bin, "pnpm"),
          `#!/bin/sh\ntouch "${join(fixture.root, "installed")}"\nexit 1\n`,
        );
        parkCanonicalOffAnchor(fixture);
        const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
          cwd: fixture.linked,
          encoding: "utf8",
          env: { ...fixture.env, TMPDIR: fixture.root },
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`Cannot find package '${dependency}'`);
        expect(existsSync(join(fixture.root, "installed"))).toBe(false);
        expect(existsSync(join(fixture.canonical, "node_modules"))).toBe(false);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.each(["handoff", "inventory"])(
    "keeps the refusal when the anchor lacks its %s",
    (contract) => {
      const fixture = makeMismatchedWrapperRepo();
      try {
        fixture.git(fixture.canonical, ["checkout", "main"]);
        if (contract === "handoff") {
          const legacy = readScript(join(fixture.canonical, "scripts/pr")).replaceAll(
            "OPENCLAW_PR_ANCHOR_REPO_ROOT",
            "OPENCLAW_PR_LEGACY_UNSUPPORTED",
          );
          writeFileSync(join(fixture.canonical, "scripts/pr"), legacy);
        } else {
          rmSync(join(fixture.canonical, "scripts/pr-lib/wrapper-components.txt"));
        }
        fixture.git(fixture.canonical, ["add", "-u", "scripts/pr", "scripts/pr-lib"]);
        fixture.git(fixture.canonical, ["commit", "-m", "test: legacy anchor wrapper"]);
        fixture.git(fixture.canonical, ["push", "origin", "main"]);
        fixture.git(fixture.linked, ["fetch", "origin", "main"]);
        parkCanonicalOffAnchor(fixture);
        const result = spawnSync(join(fixture.linked, "scripts", "pr"), ["ci-dispatch", "123"], {
          cwd: fixture.linked,
          encoding: "utf8",
          env: fixture.env,
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Refusing to silently substitute");
        expect(result.stdout).not.toContain("canonical wrapper executed");
        expect(result.stdout).not.toContain("local wrapper executed");
      } finally {
        fixture.cleanup();
      }
    },
  );

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
    copyPrWrapperSources(repo);
    const env = isolatedWrapperEnv(dir);
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/gh"), "#!/bin/sh\nexit 99\n");
    chmodSync(join(dir, "bin/gh"), 0o755);
    const git = (cwd: string, args: string[]) =>
      spawnSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" });
    expect(git(repo, ["init", "-b", "main"]).status).toBe(0);
    expect(git(repo, ["config", "user.name", "OpenClaw Test"]).status).toBe(0);
    expect(git(repo, ["config", "user.email", "test@example.invalid"]).status).toBe(0);
    expect(git(repo, ["add", "."]).status).toBe(0);
    expect(git(repo, ["commit", "-m", "test: canonical wrapper"]).status).toBe(0);
    expect(git(repo, ["worktree", "add", "-b", "feature", linked]).status).toBe(0);

    for (const component of [
      "scripts/pr-lib/wrapper-components.txt",
      "scripts/pr-lib/merge.sh",
      "scripts/watch-pr-ci.mts",
      "scripts/verify-pr-hosted-gates.mts",
      "scripts/lib/local-check-runtime.mts",
    ]) {
      writeFileSync(join(linked, component), "# dirty linked\n");
      const dirtyResult = spawnSync(join(linked, "scripts", "pr"), ["ls"], {
        cwd: linked,
        encoding: "utf8",
        env,
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
      env,
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
      env,
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
      env,
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
    copyPrWrapperSources(repo);
    const env = isolatedWrapperEnv(dir);
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/gh"), "#!/bin/sh\nexit 99\n");
    chmodSync(join(dir, "bin/gh"), 0o755);
    const git = (cwd: string, args: string[]) =>
      spawnSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" });
    expect(git(repo, ["init", "-b", "main"]).status).toBe(0);
    expect(git(repo, ["config", "user.name", "OpenClaw Test"]).status).toBe(0);
    expect(git(repo, ["config", "user.email", "test@example.invalid"]).status).toBe(0);
    expect(git(repo, ["add", "."]).status).toBe(0);
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
      env,
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
      env,
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
        env: { ...isolatedWrapperEnv(dir), OPENCLAW_GH_BIN: gh, GH_TOKEN: "synthetic-token" },
        encoding: "utf8",
      },
    );
    rmSync(dir, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it.each(["default", "override"])(
    "resolves review writer identity through the selected protected gh (%s)",
    (route) => {
      const dir = mkdtempSync(join(tmpdir(), "openclaw-pr-review-writer-"));
      const bin = join(dir, "bin");
      const calls = join(dir, "calls.log");
      mkdirSync(bin);
      const protectedGh = `#!/bin/sh
printf '%s\\n' "$*" >> "$OPENCLAW_TEST_CALLS"
case "$1 $2" in
  "api user") printf 'relay-reader\\n' ;;
  "api graphql") printf 'writer-maintainer\\n' ;;
  "pr edit") [ "$5" = writer-maintainer ] ;;
  *) exit 19 ;;
esac
`;
      const pathGh = join(bin, "gh");
      const overrideGh = join(dir, "selected-gh");
      writeFileSync(pathGh, route === "default" ? protectedGh : "#!/bin/sh\nexit 19\n");
      writeFileSync(overrideGh, protectedGh);
      chmodSync(pathGh, 0o755);
      chmodSync(overrideGh, 0o755);
      try {
        const result = spawnSync(
          "bash",
          [
            "-c",
            [
              "source scripts/lib/plain-gh.sh",
              "source scripts/pr-lib/common.sh",
              "source scripts/pr-lib/review.sh",
              'enter_worktree() { cd "$OPENCLAW_TEST_ROOT"; mkdir -p .local; }',
              "review_claim 42",
            ].join("\n"),
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env: {
              HOME: dir,
              GH_TOKEN: "synthetic-writer-token",
              OPENCLAW_GH_BIN: route === "override" ? overrideGh : "",
              OPENCLAW_TEST_CALLS: calls,
              OPENCLAW_TEST_ROOT: dir,
              PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
            },
          },
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("@writer-maintainer assigned to PR #42");
        expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
          expect.stringContaining("api graphql -f query=query { viewer { login } }"),
          "pr edit 42 --add-assignee writer-maintainer",
        ]);
        expect(readFileSync(join(dir, ".local/review-claim-user-attempt-1.log"), "utf8")).toBe(
          "writer-maintainer\n",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
