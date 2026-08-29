// Git hook tests validate pre-commit hook behavior and scripts.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "./helpers/temp-dir.js";

const baseGitEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "user.name",
  GIT_CONFIG_VALUE_0: "Hook Test",
  GIT_CONFIG_KEY_1: "user.email",
  GIT_CONFIG_VALUE_1: "hook@example.invalid",
  GIT_CONFIG_KEY_2: "commit.gpgSign",
  GIT_CONFIG_VALUE_2: "false",
};
const baseRunEnv: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  ...baseGitEnv,
};
const rulePath = ".git/private rules.txt";
const ruleSetting = "hooks.blockedLiteralsFile";
const literals = ["GUARD_SYNTHETIC_ALPHA", "GUARD_SYNTHETIC_BETA_[x].*42"] as const;
const tempDirs: string[] = [];

const run = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) => {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: env ? { ...baseRunEnv, ...env } : baseRunEnv,
  }).trim();
};

type FailedCommand = {
  status: number;
  stderr: string;
  stdout: string;
};

const runFailure = (
  cwd: string,
  cmd: string,
  args: string[] = [],
  env?: NodeJS.ProcessEnv,
): FailedCommand => {
  try {
    run(cwd, cmd, args, env);
  } catch (error) {
    if (error instanceof Error && "status" in error) {
      const failure = error as Error & { status?: number; stderr?: string; stdout?: string };
      return {
        status: failure.status ?? 1,
        stderr: failure.stderr ?? "",
        stdout: failure.stdout ?? "",
      };
    }
    throw error;
  }

  throw new Error("expected command to fail");
};

function writeExecutable(dir: string, name: string, contents: string): void {
  writeFileSync(path.join(dir, name), contents, {
    encoding: "utf8",
    mode: 0o755,
  });
}

function installPreCommitFixture(dir: string): string {
  mkdirSync(path.join(dir, "git-hooks"), { recursive: true });
  mkdirSync(path.join(dir, "scripts", "pre-commit"), { recursive: true });
  symlinkSync(
    path.join(process.cwd(), "git-hooks", "pre-commit"),
    path.join(dir, "git-hooks", "pre-commit"),
  );
  for (const name of [
    "run-node-tool.sh",
    "filter-staged-files.mjs",
    "guard-staged-content.mjs",
    "format-staged.sh",
  ]) {
    copyFileSync(
      path.join(process.cwd(), "scripts/pre-commit", name),
      path.join(dir, "scripts/pre-commit", name),
    );
  }
  writeFileSync(path.join(dir, rulePath), `${literals.join("\n")}\n`, { mode: 0o600 });
  run(dir, "git", ["config", "--local", ruleSetting, path.join(dir, rulePath)]);
  mkdirSync(path.join(dir, "node_modules/.bin"), { recursive: true });
  writeExecutable(path.join(dir, "node_modules/.bin"), "oxfmt", "#!/bin/sh\nexit 0\n");

  const fakeBinDir = path.join(dir, "bin");
  mkdirSync(fakeBinDir, { recursive: true });
  return fakeBinDir;
}

function installFormattingRecorder(dir: string, body = ""): string {
  const logPath = path.join(dir, "hook-tool.log");
  writeExecutable(
    path.join(dir, "node_modules/.bin"),
    "oxfmt",
    `#!/usr/bin/env bash
set -euo pipefail
printf 'oxfmt %s\n' "$*" >> hook-tool.log
${body}
`,
  );
  return logPath;
}

function installRunNodeToolFixture(dir: string): void {
  mkdirSync(path.join(dir, "scripts", "pre-commit"), { recursive: true });
  symlinkSync(
    path.join(process.cwd(), "scripts", "pre-commit", "run-node-tool.sh"),
    path.join(dir, "scripts", "pre-commit", "run-node-tool.sh"),
  );
}

function splitNonEmptyLines(output: string): string[] {
  const lines: string[] = [];
  for (const line of output.split("\n")) {
    if (line) {
      lines.push(line);
    }
  }
  return lines;
}

function readFormatterLog(logPath: string): string[] {
  if (!existsSync(logPath)) {
    return [];
  }
  return splitNonEmptyLines(readFileSync(logPath, "utf8"));
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("git-hooks/pre-commit (integration)", () => {
  it("does not treat staged filenames as git-add flags (e.g. --all)", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);

    // Use the real hook script and lightweight helper stubs.
    const fakeBinDir = installPreCommitFixture(dir);
    // Create an untracked file that should NOT be staged by the hook.
    writeFileSync(path.join(dir, "secret.txt"), "do-not-stage\n", "utf8");

    // Stage a maliciously-named file. Older hooks using `xargs git add` could run `git add --all`.
    writeFileSync(path.join(dir, "--all"), "flag\n", "utf8");
    run(dir, "git", ["add", "--", "--all"]);

    // Run the hook directly (same logic as when installed via core.hooksPath).
    run(dir, "bash", ["git-hooks/pre-commit"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    });

    const staged = splitNonEmptyLines(run(dir, "git", ["diff", "--cached", "--name-only"]));
    expect(staged).toEqual(["--all"]);
  });

  it("skips formatting staged files while a merge commit is in progress", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-merge-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);
    installPreCommitFixture(dir);
    const logPath = installFormattingRecorder(dir);

    writeFileSync(path.join(dir, "changed.ts"), "export const value = 1;\n", "utf8");
    run(dir, "git", ["add", "--", "changed.ts"]);
    run(dir, "git", [
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-q",
      "-m",
      "initial",
    ]);
    run(dir, "git", ["checkout", "-q", "-b", "side"]);
    writeFileSync(path.join(dir, "changed.ts"), "export const value = 2;\n", "utf8");
    run(dir, "git", ["add", "--", "changed.ts"]);
    run(dir, "git", [
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-q",
      "-m",
      "side change",
    ]);
    run(dir, "git", ["checkout", "-q", "main"]);
    run(dir, "git", [
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.invalid",
      "merge",
      "--no-commit",
      "--no-ff",
      "side",
    ]);

    expect(existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(true);
    expect(run(dir, "git", ["diff", "--cached", "--name-only"])).toBe("changed.ts");

    run(dir, "bash", ["git-hooks/pre-commit"]);

    expect(readFormatterLog(logPath)).toEqual([]);

    writeFileSync(path.join(dir, "changed.ts"), literals[0]);
    run(dir, "git", ["add", "--", "changed.ts"]);
    expect(runFailure(dir, "bash", ["git-hooks/pre-commit"]).stderr).toContain(
      "Blocked staged content",
    );
    expect(readFormatterLog(logPath)).toEqual([]);
  });

  it.each([
    ["cherry-pick", "CHERRY_PICK_HEAD", "file"],
    ["revert", "REVERT_HEAD", "file"],
    ["rebase head", "REBASE_HEAD", "file"],
    ["merge rebase state", "rebase-merge", "dir"],
    ["apply rebase state", "rebase-apply", "dir"],
  ])("skips formatting staged files while %s metadata is present", (_label, gitPath, kind) => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-sequencer-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);
    installPreCommitFixture(dir);
    const logPath = installFormattingRecorder(dir);

    writeFileSync(path.join(dir, "changed.ts"), "export const value = 1;\n", "utf8");
    run(dir, "git", ["add", "--", "changed.ts"]);

    const metadataPath = path.join(dir, ".git", gitPath);
    if (kind === "dir") {
      mkdirSync(metadataPath, { recursive: true });
    } else {
      writeFileSync(metadataPath, "sequencer state\n", "utf8");
    }

    run(dir, "bash", ["git-hooks/pre-commit"]);

    expect(readFormatterLog(logPath)).toEqual([]);

    writeFileSync(path.join(dir, "changed.ts"), literals[1]);
    run(dir, "git", ["add", "--", "changed.ts"]);
    expect(runFailure(dir, "bash", ["git-hooks/pre-commit"]).stderr).toContain(
      "Blocked staged content",
    );
    expect(readFormatterLog(logPath)).toEqual([]);
  });

  it.each(["configured", "unconfigured", "external"])(
    "formats staged files with %s private rules",
    (mode) => {
      const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-normal-");
      run(dir, "git", ["init", "-q", "--initial-branch=main"]);
      const fakeBinDir = installPreCommitFixture(dir);
      const logPath = installFormattingRecorder(dir);
      if (mode === "unconfigured") {
        run(dir, "git", ["config", "--local", "--unset", ruleSetting]);
        unlinkSync(path.join(dir, rulePath));
      } else if (mode === "external") {
        const privateDir = makeTempRepoRoot(tempDirs, "openclaw-private-rules-");
        const privatePath = path.join(privateDir, "private rules.txt");
        copyFileSync(path.join(dir, rulePath), privatePath);
        unlinkSync(path.join(dir, rulePath));
        run(dir, "git", ["config", "--local", ruleSetting, privatePath]);
        expect(run(dir, "git", ["config", "--path", "--get", ruleSetting])).toBe(privatePath);
      }

      writeFileSync(
        path.join(dir, "changed.ts"),
        mode === "unconfigured" ? literals[0] : "export const value = 1;\n",
        "utf8",
      );
      run(dir, "git", ["add", "--", "changed.ts"]);

      run(dir, "bash", ["git-hooks/pre-commit"], {
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      });

      expect(readFormatterLog(logPath)).toEqual([
        "oxfmt --write --no-error-on-unmatched-pattern changed.ts",
      ]);
      if (mode === "external") {
        writeFileSync(path.join(dir, "changed.ts"), literals[0]);
        run(dir, "git", ["add", "--", "changed.ts"]);
        expect(runFailure(dir, "bash", ["git-hooks/pre-commit"]).stderr).toContain(
          "Blocked staged content",
        );
      }
    },
  );

  it("does not run the changed-scope check for non-doc staged changes", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-no-check-changed-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);

    const fakeBinDir = installPreCommitFixture(dir);
    writeFileSync(path.join(dir, "package.json"), '{"name":"tmp"}\n', "utf8");
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeExecutable(
      fakeBinDir,
      "pnpm",
      "#!/usr/bin/env bash\necho 'pnpm should not run from pre-commit' >&2\nexit 99\n",
    );

    writeFileSync(path.join(dir, "tracked.txt"), "hello\n", "utf8");
    run(dir, "git", ["add", "--", "tracked.txt"]);

    run(dir, "bash", ["git-hooks/pre-commit"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    });

    expect(run(dir, "git", ["diff", "--cached", "--name-only"])).toBe("tracked.txt");
  });

  it("does not re-add staged paths that are ignored by the current .gitignore", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-ignored-staged-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);

    const fakeBinDir = installPreCommitFixture(dir);
    mkdirSync(path.join(dir, ".agents", "skills", "discord-clawd"), { recursive: true });
    writeFileSync(path.join(dir, ".gitignore"), ".agents/skills/discord-clawd/\n", "utf8");
    writeFileSync(
      path.join(dir, ".agents", "skills", "discord-clawd", "SKILL.md"),
      "# Discord Clawd\n",
      "utf8",
    );

    run(dir, "git", ["add", "--", ".gitignore"]);
    run(dir, "git", ["add", "-f", "--", ".agents/skills/discord-clawd/SKILL.md"]);

    run(dir, "bash", ["git-hooks/pre-commit"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    });

    const staged = splitNonEmptyLines(run(dir, "git", ["diff", "--cached", "--name-only"]));
    expect(staged).toEqual([".agents/skills/discord-clawd/SKILL.md", ".gitignore"]);
  });

  it("does not invoke pnpm when FAST_COMMIT is set", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-fast-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);

    const fakeBinDir = installPreCommitFixture(dir);
    writeFileSync(path.join(dir, "package.json"), '{"name":"tmp"}\n', "utf8");
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    writeExecutable(
      fakeBinDir,
      "pnpm",
      "#!/usr/bin/env bash\necho 'pnpm should not run when FAST_COMMIT is enabled' >&2\nexit 99\n",
    );

    writeFileSync(path.join(dir, "tracked.txt"), "hello\n", "utf8");
    run(dir, "git", ["add", "--", "tracked.txt"]);

    run(dir, "bash", ["git-hooks/pre-commit"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      FAST_COMMIT: "1",
    });

    expect(run(dir, "git", ["diff", "--cached", "--name-only"])).toBe("tracked.txt");
  });
});

describe("staged content guard", () => {
  function fixture() {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-content-guard-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);
    installPreCommitFixture(dir);
    return dir;
  }

  function stage(dir: string, name: string, content: string | Buffer) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
    run(dir, "git", ["--literal-pathspecs", "add", "-f", "--", name]);
  }

  const commitArgs = ["-c", "core.hooksPath=git-hooks", "commit", "-qm", "guard proof"];

  function blocked(dir: string, names: string[], commit = false) {
    const result = commit
      ? runFailure(dir, "git", commitArgs)
      : runFailure(dir, "bash", ["git-hooks/pre-commit"]);
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(1);
    expect(output).toContain("Blocked staged content");
    expect(output).toContain("restage");
    for (const name of names) {
      expect(output).toContain(JSON.stringify(name));
    }
    for (const literal of literals) {
      expect(output).not.toContain(literal);
    }
    expect(output).not.toContain("PRIVATE_SOURCE_CONTEXT");
    return result;
  }

  it.each(literals)(
    "blocks staged literal %s before formatting even with a clean working tree",
    (literal) => {
      const dir = fixture();
      const log = installFormattingRecorder(dir);
      stage(dir, "payload.ts", `PRIVATE_SOURCE_CONTEXT prefix${literal}suffix\n`);
      writeFileSync(path.join(dir, "payload.ts"), "clean working tree\n");
      blocked(dir, ["payload.ts"], true);
      expect(readFormatterLog(log)).toEqual([]);
      expect(runFailure(dir, "git", ["rev-parse", "--verify", "HEAD"]).status).not.toBe(0);
    },
  );

  it.each(["payload.txt", "payload.ts"])(
    "blocks working-tree bytes restaged by the real formatter path: %s",
    (name) => {
      const dir = fixture();
      stage(dir, name, "clean staged version\n");
      writeFileSync(path.join(dir, name), literals[0]);
      blocked(dir, [name], true);
      expect(run(dir, "git", ["show", `:${name}`])).toBe(literals[0]);
      expect(runFailure(dir, "git", ["rev-parse", "--verify", "HEAD"]).status).not.toBe(0);
    },
  );

  it("discovers a new path staged during formatting", () => {
    const dir = fixture();
    stage(dir, "payload.ts", "clean\n");
    writeFileSync(path.join(dir, "introduced.txt"), literals[1]);
    const log = installFormattingRecorder(dir, "git add -- introduced.txt");
    blocked(dir, ["introduced.txt"], true);
    expect(readFormatterLog(log)).toHaveLength(1);
  });

  it("uses fixed, case-sensitive matches despite Git grep defaults", () => {
    const dir = fixture();
    run(dir, "git", ["config", "grep.patternType", "extended"]);
    run(dir, "git", ["config", "grep.ignoreCase", "true"]);
    stage(dir, "payload.txt", `${literals[0].toLowerCase()}\nGUARD_SYNTHETIC_BETA_xanything42\n`);
    run(dir, "git", commitArgs);
    expect(run(dir, "git", ["show", "HEAD:payload.txt"])).toContain("xanything42");
  });

  it("scans unchanged lines in modified files but permits unchanged history and deletion-only commits", () => {
    const dir = fixture();
    stage(dir, "historical.txt", `${literals[0]}\nold line\n`);
    run(dir, "git", ["commit", "-qm", "historical fixture"]);
    stage(dir, "clean.txt", "clean\n");
    run(dir, "git", commitArgs);
    stage(dir, "historical.txt", `${literals[0]}\nnew line\n`);
    blocked(dir, ["historical.txt"]);
    run(dir, "git", ["rm", "-f", "--", "historical.txt"]);
    run(dir, "git", commitArgs);
    expect(run(dir, "git", ["ls-tree", "--name-only", "HEAD"])).toBe("clean.txt");
  });

  it.each(["rename", "typechange", "binary"])("scans the full staged blob for %s", (kind) => {
    const dir = fixture();
    if (kind === "rename") {
      stage(dir, "old.txt", literals[0]);
      run(dir, "git", ["commit", "-qm", "historical fixture"]);
      run(dir, "git", ["mv", "--", "old.txt", "payload.txt"]);
    } else if (kind === "typechange") {
      symlinkSync("absent-target", path.join(dir, "payload.txt"));
      run(dir, "git", ["add", "--", "payload.txt"]);
      run(dir, "git", ["commit", "-qm", "symlink fixture"]);
      unlinkSync(path.join(dir, "payload.txt"));
      stage(dir, "payload.txt", literals[0]);
    } else {
      stage(
        dir,
        "payload.txt",
        Buffer.concat([Buffer.from([0, 255]), Buffer.from(literals[1]), Buffer.from([0])]),
      );
    }
    blocked(dir, ["payload.txt"]);
  });

  it("reports literal paths safely and includes ignored docs, tests and generated files", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, ".gitignore"), "ignored/\n");
    const names = [
      "space name.txt",
      "--all",
      ":(exclude)payload.txt",
      "[literal]*?.txt",
      "line\nbreak.txt",
      "control\u001b.txt",
      "ignored/file.txt",
      "docs/example.md",
      "test/example.ts",
      "extensions/example/src/host/web/file.bundle.js",
    ];
    for (const name of names) {
      stage(dir, name, literals[0]);
    }
    stage(dir, `${literals[0]}.txt`, literals[1]);
    const result = blocked(dir, [...names, "[REDACTED].txt"]);
    expect(result.stderr).not.toContain("\u001b");
  });

  it("scans the former public rule filename and beyond both batch limits", () => {
    const dir = fixture();
    const formerRulePath = "scripts/pre-commit/blocked-literals.txt";
    stage(dir, formerRulePath, literals[0]);
    blocked(dir, [formerRulePath]);
    // Long paths cross the byte budget before 64 entries; short paths cross the count budget.
    const batchPaths = [];
    for (let i = 0; i < 140; i++) {
      const suffix = i < 70 ? `/${"x".repeat(180)}/${"y".repeat(180)}` : "";
      const name = `batch-${String(i).padStart(3, "0")}${suffix}.txt`;
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), "clean\n");
      batchPaths.push(name);
    }
    run(dir, "git", ["add", "--", ...batchPaths]);
    stage(dir, formerRulePath, "clean\n");
    stage(dir, "zzz-last.txt", literals[1]);
    blocked(dir, ["zzz-last.txt"]);
  });

  it("permits unborn and existing empty commits and ignores submodule contents", () => {
    const dir = fixture();
    run(dir, "git", [...commitArgs, "--allow-empty"]);
    run(dir, "git", [...commitArgs, "--allow-empty"]);
    const head = run(dir, "git", ["rev-parse", "HEAD"]);
    run(dir, "git", ["update-index", "--add", "--cacheinfo", `160000,${head},submodule`]);
    mkdirSync(path.join(dir, "submodule"));
    writeFileSync(path.join(dir, "submodule", "payload.txt"), literals[0]);
    run(dir, "bash", ["git-hooks/pre-commit"]);
    expect(run(dir, "git", ["diff", "--cached", "--name-only"])).toBe("submodule");
  });

  it.each([
    ["missing file", null],
    ["empty file", ""],
    ["blank lines", "\n\n"],
    ["invalid UTF-8", Buffer.from([255])],
    ["NUL literal", "\0"],
    ["empty setting", undefined],
  ])("fails closed with %s", (_label, content) => {
    const dir = fixture();
    const log = installFormattingRecorder(dir);
    stage(dir, "payload.ts", "clean\n");
    if (content === undefined) {
      run(dir, "git", ["config", "--local", ruleSetting, ""]);
    } else if (content === null) {
      unlinkSync(path.join(dir, rulePath));
    } else {
      writeFileSync(path.join(dir, rulePath), content);
    }
    const result = runFailure(dir, "bash", ["git-hooks/pre-commit"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(ruleSetting);
    expect(result.stderr).toContain("retry");
    expect(result.stdout + result.stderr).not.toContain(path.join(dir, rulePath));
    expect(readFormatterLog(log)).toEqual([]);
  });

  it.each([
    ["literal metacharacters", [...literals], literals.join(" "), "[REDACTED] [REDACTED]"],
    [
      "shorter prefix first",
      ["foo", "foobar"],
      "foobar foo FOOBAR",
      "[REDACTED] [REDACTED] FOOBAR",
    ],
    ["longer prefix first", ["foobar", "foo"], "foobar foo FOOBAR", "[REDACTED] [REDACTED] FOOBAR"],
    ["crossing overlaps", ["abc", "bcd"], "abcd", "[REDACTED]"],
    ["reversed crossing overlaps", ["bcd", "abc"], "abcd", "[REDACTED]"],
    ["self-overlap", ["aba"], "ababa", "[REDACTED]"],
    ["marker literal", ["foo", "REDACTED"], "foo REDACTED", "[REDACTED] [REDACTED]"],
  ])(
    "redacts filenames and formatter streams with %s while preserving failure status",
    (_label, rules, text, redacted) => {
      const dir = fixture();
      writeFileSync(path.join(dir, rulePath), `${rules.join("\n")}\n`);
      const name = `report-${text}\n🦞.ts`;
      stage(dir, name, text);
      const finding = runFailure(dir, "bash", ["git-hooks/pre-commit"]);

      stage(dir, name, "clean\n");
      const context = `🦞 café ${text}\nuntouched ${text} tail\n`;
      const expected = `🦞 café ${redacted}\nuntouched ${redacted} tail\n`;
      installFormattingRecorder(
        dir,
        `printf 'stdout %s' '${context}'\nprintf 'stderr %s' '${context}' >&2\nprintf broken > .git/index\nexit 23`,
      );
      const result = runFailure(dir, "bash", ["git-hooks/pre-commit"]);
      expect(result).toEqual({
        status: 23,
        stdout: `stdout ${expected}`,
        stderr: `stderr ${expected}[pre-commit] Formatter failed. Fix the reported error and retry.\n[pre-commit] FAILED (exit 23)\n`,
      });
      expect(finding.status).toBe(1);
      expect(finding.stderr).toContain(`  ${JSON.stringify(`report-${redacted}\n🦞.ts`)}\n`);
    },
  );

  it.each(["config path", "index", "blob", "post-format blob"])(
    "blocks Git %s read errors without raw diagnostics",
    (kind) => {
      const dir = fixture();
      const name = `${literals[0]}.txt`;
      stage(dir, name, "clean\n");
      if (kind === "config path") {
        run(dir, "git", ["config", "--local", ruleSetting, `~${literals[1]}/private rules.txt`]);
        expect(runFailure(dir, "git", ["config", "--path", "--get", ruleSetting]).status).not.toBe(
          1,
        );
      } else if (kind === "index") {
        writeFileSync(path.join(dir, ".git/index"), literals[1]);
      } else {
        const oid = run(dir, "git", ["rev-parse", `:${name}`]);
        const objectPath = `.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
        if (kind === "post-format blob") {
          // Keep git add from recreating the missing blob before the post-scan.
          writeFileSync(path.join(dir, ".gitignore"), "*.txt\n");
          stage(dir, "trigger.ts", "formatter trigger\n");
          installFormattingRecorder(dir, `rm -- '${objectPath}'`);
        } else {
          unlinkSync(path.join(dir, objectPath));
          const grep = runFailure(dir, "git", [
            "grep",
            "--cached",
            "--fixed-strings",
            "clean",
            "--",
            name,
          ]);
          expect(grep.status).toBe(1);
          expect(grep.stderr.length).toBeGreaterThan(0);
        }
      }
      const result = runFailure(dir, "bash", ["git-hooks/pre-commit"]);
      expect(result.stderr).toContain("Git could not");
      for (const literal of literals) {
        expect(result.stdout + result.stderr).not.toContain(literal);
      }
      expect(result.stderr).not.toContain("error:");
    },
  );
});

describe("scripts/pre-commit/run-node-tool.sh", () => {
  it("runs the installed local tool without invoking pnpm", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-run-node-tool-local-");
    installRunNodeToolFixture(dir);
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    const fakeBinDir = path.join(dir, "bin");
    const toolBinDir = path.join(dir, "node_modules", ".bin");
    mkdirSync(fakeBinDir, { recursive: true });
    mkdirSync(toolBinDir, { recursive: true });
    writeExecutable(
      fakeBinDir,
      "pnpm",
      "#!/usr/bin/env bash\necho 'pnpm should not run from run-node-tool' >&2\nexit 99\n",
    );
    writeExecutable(toolBinDir, "oxfmt", "#!/usr/bin/env bash\nprintf 'local:%s\\n' \"$*\"\n");

    expect(
      run(dir, "bash", ["scripts/pre-commit/run-node-tool.sh", "oxfmt", "--write", "a.ts"], {
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      }),
    ).toBe("local:--write a.ts");
  });

  it("fails before pnpm can hydrate dependencies when node_modules is missing", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-run-node-tool-missing-deps-");
    installRunNodeToolFixture(dir);
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    const fakeBinDir = path.join(dir, "bin");
    const markerPath = path.join(dir, "pnpm-called");
    mkdirSync(fakeBinDir, { recursive: true });
    writeExecutable(
      fakeBinDir,
      "pnpm",
      `#!/usr/bin/env bash\ntouch ${JSON.stringify(markerPath)}\nexit 99\n`,
    );

    const result = runFailure(
      dir,
      "bash",
      ["scripts/pre-commit/run-node-tool.sh", "oxfmt", "--write", "a.ts"],
      { PATH: `${fakeBinDir}:${process.env.PATH ?? ""}` },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Missing repo dependencies: cannot run oxfmt without node_modules.",
    );
    expect(existsSync(markerPath)).toBe(false);
  });
});
