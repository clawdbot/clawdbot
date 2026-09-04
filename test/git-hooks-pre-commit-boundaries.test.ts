import {
  copyFileSync,
  existsSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitArgs,
  createContentGuardFixture,
  installFormattingRecorder,
  installPreCommitFixture,
  readFormatterLog,
  literals,
  rulePath,
  ruleSetting,
  run,
  runFailure,
  stageContent as stage,
  writeExecutable,
} from "./git-hooks-pre-commit.test-support.js";
import { cleanupTempDirs } from "./helpers/temp-dir.js";

const tempDirs: string[] = [];
const fixture = () => createContentGuardFixture(tempDirs);
const failureLine = "[pre-commit] FAILED (exit 23)\n";

afterEach(() => cleanupTempDirs(tempDirs));

function expectBlocked(output: string, name: string): void {
  expect(output).toContain("Blocked staged content");
  expect(output).toContain(JSON.stringify(name));
  expect(output).not.toContain(literals[0]);
  expect(output).toContain("[pre-commit] FAILED (exit 1)\n");
}

// Only the external formatter is simulated; it emits the working-tree input completely.
// With echoStdin it also behaves like a real stdin-mode formatter (blob in, blob out).
function diagnosticFormatter(
  dir: string,
  stream: number,
  exitCode: number,
  echoStdin = false,
): void {
  writeExecutable(
    path.join(dir, "node_modules/.bin"),
    "oxfmt",
    `#!/usr/bin/env node
const fs = require("node:fs");
${echoStdin ? "fs.writeSync(1, fs.readFileSync(0));" : ""}
const payload = fs.readFileSync("payload.ts");
let written = 0;
while (written < payload.length) written += fs.writeSync(${stream}, payload, written, payload.length - written);
process.exitCode = ${exitCode};
`,
  );
}

describe("pre-commit Git path identity", () => {
  it("blocks the only BOM-prefixed path when staged", () => {
    const dir = fixture();
    const name = "\uFEFFpayload.txt";
    stage(dir, name, literals[0]);
    writeFileSync(path.join(dir, name), literals[0]);
    const result = runFailure(dir, "git", commitArgs);
    expectBlocked(result.stderr, name);
    expect(runFailure(dir, "git", ["rev-parse", "--verify", "HEAD"]).status).not.toBe(0);
  });

  it("commits only the staged bytes of a partially staged BOM-prefixed path", () => {
    const dir = fixture();
    const name = "\uFEFFpayload.ts";
    stage(dir, name, "clean\n");
    writeFileSync(path.join(dir, name), literals[0]);
    run(dir, "git", commitArgs);
    expect(run(dir, "git", ["show", `HEAD:${name}`])).toBe("clean");
    expect(readFileSync(path.join(dir, name), "utf8")).toBe(literals[0]);
  });

  it("accepts a benign BOM path without searching its unchanged non-BOM counterpart", () => {
    const dir = fixture();
    stage(dir, "payload.txt", literals[0]);
    run(dir, "git", ["commit", "-qm", "historical fixture"]);
    const name = "\uFEFFpayload.txt";
    stage(dir, name, "clean\n");
    run(dir, "git", commitArgs);
    expect(run(dir, "git", ["show", `HEAD:${name}`])).toBe("clean");
    expect(run(dir, "git", ["show", "HEAD:payload.txt"])).toBe(literals[0]);
  });

  it.each([rulePath, "\uFEFFprivate-rules.txt"])(
    "consumes a rule-file BOM but preserves the configured path: %s",
    (name) => {
      const dir = fixture();
      writeFileSync(path.join(dir, name), `\uFEFF${literals[0]}\n`);
      run(dir, "git", ["config", "--local", ruleSetting, name]);
      stage(dir, "payload.txt", literals[0]);
      expectBlocked(runFailure(dir, "git", commitArgs).stderr, "payload.txt");
    },
  );

  it.each(["--glob-pathspecs", "--icase-pathspecs", "--noglob-pathspecs", "--literal-pathspecs"])(
    "keeps enumerated filenames literal under %s without private rules",
    (flag) => {
      const dir = fixture();
      run(dir, "git", ["config", "--local", "--unset", ruleSetting]);
      unlinkSync(path.join(dir, rulePath));
      const name = "chosen[1].txt";
      stage(dir, name, "staged\n");
      stage(dir, ":(exclude)clean.txt", "literal colon\n");
      stage(dir, "chosen[2].ts", "partial staged\n");
      writeFileSync(path.join(dir, name), "unstaged\n");
      writeFileSync(path.join(dir, "chosen[2].ts"), "partial unstaged\n");
      expect(
        run(dir, "bash", ["-c", 'exec git "$@" 2>&1', "hook-proof", flag, ...commitArgs]),
      ).toBe("");
      expect(run(dir, "git", ["show", `HEAD:${name}`])).toBe("staged");
      expect(run(dir, "git", ["show", "HEAD::(exclude)clean.txt"])).toBe("literal colon");
      expect(run(dir, "git", ["show", "HEAD:chosen[2].ts"])).toBe("partial staged");
      expect(readFileSync(path.join(dir, "chosen[2].ts"), "utf8")).toBe("partial unstaged\n");
    },
  );

  it("treats recovered filenames as literal pathspecs even without the guard env", () => {
    const dir = fixture();
    const names = ["chosen[3].ts", ":(exclude)partial.ts"];
    for (const name of names) {
      stage(dir, name, "keep staged\n");
      writeFileSync(path.join(dir, name), "unstaged only\n");
    }
    // Direct invocation: no guard process pins GIT_LITERAL_PATHSPECS for the script.
    run(dir, "bash", ["scripts/pre-commit/format-staged.sh"]);
    run(dir, "git", ["commit", "-qm", "literal proof"]);
    for (const name of names) {
      expect(run(dir, "git", ["show", `HEAD:${name}`])).toBe("keep staged");
      expect(readFileSync(path.join(dir, name), "utf8")).toBe("unstaged only\n");
    }
  });

  it.each(
    ["--glob-pathspecs", "--icase-pathspecs"].flatMap((flag) =>
      ["only", "alternate"].map((index) => ({ flag, index })),
    ),
  )("preserves $index commit index authority under $flag", ({ flag, index }) => {
    const dir = fixture();
    const name = "chosen[1].txt";
    stage(dir, name, "original\n");
    stage(dir, "excluded.txt", "original excluded\n");
    run(dir, "git", ["commit", "-qm", "initial fixture"]);
    const alternateIndex = path.join(dir, ".git/selected-index");
    copyFileSync(path.join(dir, ".git/index"), alternateIndex);
    stage(dir, "excluded.txt", literals[0]);
    const env =
      index === "alternate"
        ? { GIT_INDEX_FILE: alternateIndex, GIT_DIR: path.join(dir, ".git"), GIT_WORK_TREE: dir }
        : undefined;
    const select = flag === "--glob-pathspecs" ? "chosen*.txt" : "CHOSEN[1].TXT";
    const args = [flag, ...commitArgs, ...(index === "only" ? ["--only", "--", select] : [])];
    writeFileSync(path.join(dir, name), "selected staged\n");
    run(dir, "git", ["--literal-pathspecs", "add", "--", name], env);
    writeFileSync(path.join(dir, name), "selected unstaged\n");
    run(dir, "git", args, env);
    // `--only` commits the working-tree bytes by Git's own semantics; a plain commit
    // must stay on the staged bytes now that the hook never restages the working tree.
    expect(run(dir, "git", ["show", `HEAD:${name}`])).toBe(
      index === "only" ? "selected unstaged" : "selected staged",
    );
    expect(readFileSync(path.join(dir, name), "utf8")).toBe("selected unstaged\n");
    expect(run(dir, "git", ["show", "HEAD:excluded.txt"])).toBe("original excluded");
    expect(run(dir, "git", ["show", ":excluded.txt"])).toBe(literals[0]);
    expect(readFileSync(path.join(dir, "excluded.txt"), "utf8")).toBe(literals[0]);
    const head = run(dir, "git", ["rev-parse", "HEAD"]);
    writeFileSync(path.join(dir, name), literals[0]);
    run(dir, "git", ["--literal-pathspecs", "add", "--", name], env);
    expectBlocked(runFailure(dir, "git", args, env).stderr, name);
    expect(run(dir, "git", ["rev-parse", "HEAD"])).toBe(head);
    expect(run(dir, "git", ["show", ":excluded.txt"])).toBe(literals[0]);
  });
});

describe("pre-commit formatter capture", () => {
  it("discards incomplete overflow captures from stderr", () => {
    const dir = fixture();
    const token = "SYNTHETIC_CAPTURE_".padEnd(128, "x");
    writeFileSync(path.join(dir, rulePath), `${token}\n`);
    stage(dir, "payload.ts", "clean\n");
    const cap = 16 * 1024 * 1024;
    const payload = ".".repeat(cap - 131168) + token.repeat(2048) + "ACTIONABLE_TAIL\n";
    writeFileSync(path.join(dir, "payload.ts"), payload);
    diagnosticFormatter(dir, 2, 23);
    const result = runFailure(dir, "git", commitArgs);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Formatter could not complete");
    // No padding, redacted capture, or cut literal may be replayed on either stream.
    expect(output.length).toBeLessThan(300);
    expect(output).not.toMatch(/\.{2}|SYNTHETIC|x{2}|REDACTED|ACTIONABLE_TAIL/);
    expect(output).toContain("[pre-commit] FAILED (exit 1)\n");
    expect(runFailure(dir, "git", ["rev-parse", "--verify", "HEAD"]).status).not.toBe(0);
  });

  it("keeps oversized formatter stdout out of the diagnostics capture", () => {
    // Stdin-mode stdout is formatted content, so a huge result never overflows the pipes.
    const dir = fixture();
    const token = "SYNTHETIC_CAPTURE_".padEnd(128, "x");
    writeFileSync(path.join(dir, rulePath), `${token}\n`);
    stage(dir, "payload.ts", "clean\n");
    const cap = 16 * 1024 * 1024;
    const payload = ".".repeat(cap - 131168) + token.repeat(2048) + "ACTIONABLE_TAIL\n";
    writeFileSync(path.join(dir, "payload.ts"), payload);
    diagnosticFormatter(dir, 1, 23);
    const result = runFailure(dir, "git", commitArgs);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Formatter failed");
    expect(output.length).toBeLessThan(300);
    expect(output).not.toMatch(/\.{2}|SYNTHETIC|x{2}|REDACTED|ACTIONABLE_TAIL/);
    expect(output).toContain("[pre-commit] FAILED (exit 23)\n");
    expect(run(dir, "git", ["show", ":payload.ts"])).toBe("clean");
    expect(runFailure(dir, "git", ["rev-parse", "--verify", "HEAD"]).status).not.toBe(0);
  });

  it("preserves and redacts complete below-cap stderr diagnostics", () => {
    const dir = fixture();
    stage(dir, "payload.ts", "clean\n");
    const payload = ".".repeat(256) + `${literals[0]}\n`.repeat(2048) + "ACTIONABLE_TAIL\n";
    writeFileSync(path.join(dir, "payload.ts"), payload);
    diagnosticFormatter(dir, 2, 23);
    const result = runFailure(dir, "bash", ["git-hooks/pre-commit"]);
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(23);
    expect(output.startsWith(payload.replaceAll(literals[0], "[REDACTED]"))).toBe(true);
    expect(output).not.toContain(literals[0]);
    expect(output.endsWith(failureLine)).toBe(true);
    // Formatter failure must abort before any index update or the second scan.
    expect(run(dir, "git", ["show", ":payload.ts"])).toBe("clean");
  });

  it("stages formatter stdout for partially staged files and rescans it", () => {
    const dir = fixture();
    stage(dir, "payload.ts", "clean\n");
    const payload = ".".repeat(256) + `${literals[0]}\n`.repeat(2048) + "ACTIONABLE_TAIL\n";
    writeFileSync(path.join(dir, "payload.ts"), payload);
    diagnosticFormatter(dir, 1, 23);
    const failed = runFailure(dir, "bash", ["git-hooks/pre-commit"]);
    expect(failed.status).toBe(23);
    // Content on stdout is never replayed as diagnostics, redacted or otherwise.
    expect(failed.stdout + failed.stderr).not.toContain("ACTIONABLE_TAIL");
    expect(failed.stdout + failed.stderr).not.toContain("[REDACTED]");
    expect(run(dir, "git", ["show", ":payload.ts"])).toBe("clean");
    // On success the emitted bytes become staged content and the post-format scan owns them.
    diagnosticFormatter(dir, 1, 0);
    expectBlocked(runFailure(dir, "git", commitArgs).stderr, "payload.ts");
  });

  it("discards captures when the formatter shell is terminated by a signal", () => {
    const dir = fixture();
    stage(dir, "payload.ts", "clean\n");
    writeExecutable(
      path.join(dir, "node_modules/.bin"),
      "oxfmt",
      `#!/usr/bin/env bash
printf 'INCOMPLETE_STDOUT'
printf 'INCOMPLETE_STDERR' >&2
kill -TERM "$PPID"
`,
    );
    const result = runFailure(dir, "git", commitArgs);
    expect(result.stdout + result.stderr).not.toContain("INCOMPLETE");
    expect(result.stderr).toContain("Formatter could not complete");
    expect(result.stderr).toContain("FAILED (exit 1)");
  });

  it("fails safely when the formatter shell cannot be spawned", () => {
    const dir = fixture();
    stage(dir, "payload.txt", "clean\n");
    const bin = path.join(dir, "bin");
    symlinkSync(process.execPath, path.join(bin, "node"));
    symlinkSync(run(dir, "which", ["git"]), path.join(bin, "git"));
    const result = runFailure(dir, "/bin/bash", ["git-hooks/pre-commit"], { PATH: bin });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Formatter could not complete");
    expect(result.stderr).toContain("FAILED (exit 1)");
  });

  it.each([true, false])("drains piped stderr diagnostics: rules=%s", (configured) => {
    const dir = fixture();
    if (!configured) {
      run(dir, "git", ["config", "--local", "--unset", ruleSetting]);
      unlinkSync(path.join(dir, rulePath));
    }
    stage(dir, "payload.ts", "clean\n");
    const payload = "public diagnostic context\n".repeat(4000) + "ACTIONABLE_FINAL_DETAIL\n";
    writeFileSync(path.join(dir, "payload.ts"), payload);
    diagnosticFormatter(dir, 2, 23);
    for (const [cmd, args] of [
      ["bash", ["git-hooks/pre-commit"]],
      ["git", commitArgs],
    ] as const) {
      const result = runFailure(dir, cmd, [...args]);
      const output = result.stdout + result.stderr;
      expect(result.status).toBe(cmd === "git" ? 1 : 23);
      expect(output.startsWith(payload)).toBe(true);
      expect(output.endsWith(failureLine)).toBe(true);
      expect(output.match(/\[pre-commit\] FAILED/g)).toHaveLength(1);
    }
    diagnosticFormatter(dir, 2, 0, true);
    expect(run(dir, "bash", ["-c", 'exec git "$@" 2>&1', "hook-proof", ...commitArgs])).toBe(
      payload.trim(),
    );
    expect(run(dir, "git", ["show", "HEAD:payload.ts"])).toBe("clean");
  });
});

function createOperationFixture(linked: boolean, revert = false): { dir: string; primary: string } {
  const primary = createContentGuardFixture(tempDirs);
  const commit = (name: string, content: string) => {
    stage(primary, name, content);
    run(primary, "git", ["commit", "-qm", "operation fixture"]);
  };
  commit("changed.ts", "export const value = 0;\n");
  run(primary, "git", ["checkout", "-qb", "side"]);
  commit("changed.ts", "export const value = 1;\n");
  commit("next.txt", "next step\n");
  run(primary, "git", ["checkout", "-q", "main"]);
  if (revert) {
    run(primary, "git", ["merge", "--ff-only", "side"]);
  }
  commit("changed.ts", "export const value = 2;\n");
  let dir = primary;
  if (linked) {
    dir = path.join(primary, "linked");
    run(primary, "git", ["worktree", "add", "-qb", "linked", dir, "HEAD"]);
    installPreCommitFixture(dir);
  }
  return { dir, primary };
}

describe.each([false, true])("Git operation state (linked=%s)", (linked) => {
  it.each([
    { operation: "merge", args: ["merge", "--no-commit", "side"], state: "MERGE_HEAD" },
    {
      operation: "rebase merge",
      args: ["rebase", "--merge", "side"],
      state: "rebase-merge/git-rebase-todo",
    },
    {
      operation: "rebase apply",
      args: ["rebase", "--apply", "side"],
      state: "rebase-apply/next",
    },
    { operation: "cherry-pick", args: ["cherry-pick", "side~1"], state: "CHERRY_PICK_HEAD" },
    { operation: "revert", args: ["revert", "--no-edit", "side~1"], state: "REVERT_HEAD" },
    {
      operation: "cherry-pick sequencer-only",
      args: ["cherry-pick", "side~1", "side"],
      state: "sequencer/todo",
    },
    {
      operation: "revert sequencer-only",
      args: ["revert", "--no-edit", "side~1", "side"],
      state: "sequencer/todo",
    },
  ])("preserves operation staging during $operation", ({ operation, args, state }) => {
    const { dir, primary } = createOperationFixture(linked, operation.startsWith("revert"));
    expect(runFailure(dir, "git", args).status).toBe(1);
    expect(run(dir, "git", ["ls-files", "--unmerged"])).not.toBe("");
    const metadata = path.resolve(dir, run(dir, "git", ["rev-parse", "--git-path", state]));
    if (linked) {
      expect(existsSync(path.join(primary, ".git", state))).toBe(false);
    }
    if (state === "sequencer/todo") {
      stage(dir, "changed.ts", "export const value = 3;\n");
      // A real resolution commit clears the per-step ref while later steps remain queued.
      run(dir, "git", commitArgs);
      for (const ref of ["CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"]) {
        expect(
          existsSync(path.resolve(dir, run(dir, "git", ["rev-parse", "--git-path", ref]))),
        ).toBe(false);
      }
    }
    const before = readFileSync(metadata);
    const staged = "export const value=4;\n";
    const unstaged = `${staged}// unstaged edit\n`;
    stage(dir, "changed.ts", staged);
    const stagedOid = run(dir, "git", ["rev-parse", ":changed.ts"]);
    writeFileSync(path.join(dir, "changed.ts"), unstaged);
    const log = installFormattingRecorder(
      dir,
      "printf '// formatted\\n' >> changed.ts\nprintf formatted",
    );

    expect(run(dir, "bash", ["git-hooks/pre-commit"])).toBe("");
    expect(readFormatterLog(log)).toEqual([]);
    expect(run(dir, "git", ["rev-parse", ":changed.ts"])).toBe(stagedOid);
    expect(readFileSync(path.join(dir, "changed.ts"), "utf8")).toBe(unstaged);
    expect(readFileSync(metadata)).toEqual(before);

    stage(dir, "changed.ts", literals[1]);
    expect(runFailure(dir, "bash", ["git-hooks/pre-commit"]).stderr).toContain(
      "Blocked staged content",
    );
    stage(dir, "changed.ts", staged);
    writeFileSync(path.join(dir, "changed.ts"), unstaged);
    run(dir, "git", commitArgs);
    expect(readFormatterLog(log)).toEqual([]);
    expect(run(dir, "git", ["rev-parse", "HEAD:changed.ts"])).toBe(stagedOid);
    expect(readFileSync(path.join(dir, "changed.ts"), "utf8")).toBe(unstaged);
  });

  it("formats and restages with an orphan REBASE_HEAD", () => {
    const { dir, primary } = createOperationFixture(linked);
    if (linked) {
      // Another worktree's real rebase must not suppress this worktree's ordinary commit.
      expect(runFailure(primary, "git", ["rebase", "--merge", "side"]).status).toBe(1);
    }
    const head = run(dir, "git", ["rev-parse", "HEAD"]);
    // Reproduce the observed orphan state without claiming how it was left behind.
    run(dir, "git", ["update-ref", "REBASE_HEAD", head]);
    for (const state of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
      "sequencer",
    ]) {
      expect(
        existsSync(path.resolve(dir, run(dir, "git", ["rev-parse", "--git-path", state]))),
      ).toBe(false);
    }
    expect(runFailure(dir, "git", ["rebase", "--continue"]).stderr).toContain(
      "no rebase in progress",
    );
    const working = "export const value=5;\n";
    stage(dir, "changed.ts", working);
    const log = installFormattingRecorder(
      dir,
      "printf '// formatted\\n' >> changed.ts\nprintf formatted",
    );
    expect(run(dir, "bash", ["git-hooks/pre-commit"])).toBe("formatted");
    expect(readFormatterLog(log)).toEqual([
      "oxfmt --write --no-error-on-unmatched-pattern changed.ts",
    ]);
    expect(readFileSync(path.join(dir, "changed.ts"), "utf8")).toBe(`${working}// formatted\n`);
    expect(run(dir, "git", ["show", ":changed.ts"])).toBe(`${working}// formatted`);
    expect(run(dir, "git", ["diff", "--", "changed.ts"])).toBe("");
    expect(run(dir, "git", ["rev-parse", "REBASE_HEAD"])).toBe(head);
  });
});
