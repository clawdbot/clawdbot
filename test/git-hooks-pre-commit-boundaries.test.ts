import { copyFileSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitArgs,
  createContentGuardFixture,
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
function diagnosticFormatter(dir: string, stream: number, exitCode: number): void {
  writeExecutable(
    path.join(dir, "node_modules/.bin"),
    "oxfmt",
    `#!/usr/bin/env node
const fs = require("node:fs");
const payload = fs.readFileSync("payload.ts");
let written = 0;
while (written < payload.length) written += fs.writeSync(${stream}, payload, written, payload.length - written);
process.exitCode = ${exitCode};
`,
  );
}

describe("pre-commit Git path identity", () => {
  it.each(["staged", "restaged"])("blocks the only BOM-prefixed path when %s", (mode) => {
    const dir = fixture();
    const name = "\uFEFFpayload.txt";
    stage(dir, name, mode === "staged" ? literals[0] : "clean\n");
    writeFileSync(path.join(dir, name), literals[0]);
    const result = runFailure(dir, "git", commitArgs);
    expectBlocked(result.stderr, name);
    expect(runFailure(dir, "git", ["rev-parse", "--verify", "HEAD"]).status).not.toBe(0);
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
      writeFileSync(path.join(dir, name), "restaged\n");
      expect(
        run(dir, "bash", ["-c", 'exec git "$@" 2>&1', "hook-proof", flag, ...commitArgs]),
      ).toBe("");
      expect(run(dir, "git", ["show", `HEAD:${name}`])).toBe("restaged");
      expect(run(dir, "git", ["show", "HEAD::(exclude)clean.txt"])).toBe("literal colon");
    },
  );

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
    writeFileSync(path.join(dir, name), "selected restaged\n");
    run(dir, "git", args, env);
    expect(run(dir, "git", ["show", `HEAD:${name}`])).toBe("selected restaged");
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
  it.each([1, 2])("discards incomplete overflow captures from stream %s", (stream) => {
    const dir = fixture();
    const token = "SYNTHETIC_CAPTURE_".padEnd(128, "x");
    writeFileSync(path.join(dir, rulePath), `${token}\n`);
    stage(dir, "payload.ts", "clean\n");
    const cap = 16 * 1024 * 1024;
    const payload = ".".repeat(cap - 131168) + token.repeat(2048) + "ACTIONABLE_TAIL\n";
    writeFileSync(path.join(dir, "payload.ts"), payload);
    diagnosticFormatter(dir, stream, 23);
    const result = runFailure(dir, "git", commitArgs);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Formatter could not complete");
    // No padding, redacted capture, or cut literal may be replayed on either stream.
    expect(output.length).toBeLessThan(300);
    expect(output).not.toMatch(/\.{2}|SYNTHETIC|x{2}|REDACTED|ACTIONABLE_TAIL/);
    expect(output).toContain("[pre-commit] FAILED (exit 1)\n");
    expect(runFailure(dir, "git", ["rev-parse", "--verify", "HEAD"]).status).not.toBe(0);
  });

  it.each([1, 2])("preserves and redacts complete below-cap output on stream %s", (stream) => {
    const dir = fixture();
    stage(dir, "payload.ts", "clean\n");
    const payload = ".".repeat(256) + `${literals[0]}\n`.repeat(2048) + "ACTIONABLE_TAIL\n";
    writeFileSync(path.join(dir, "payload.ts"), payload);
    diagnosticFormatter(dir, stream, 23);
    const result = runFailure(dir, "bash", ["git-hooks/pre-commit"]);
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(23);
    expect(output.startsWith(payload.replaceAll(literals[0], "[REDACTED]"))).toBe(true);
    expect(output).not.toContain(literals[0]);
    expect(output.endsWith(failureLine)).toBe(true);
    // Formatter failure must abort before restaging or the second scan.
    expect(run(dir, "git", ["show", ":payload.ts"])).toBe("clean");
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

  it.each([true, false].flatMap((configured) => [1, 2].map((stream) => ({ configured, stream }))))(
    "drains piped diagnostics: rules=$configured stream=$stream",
    ({ configured, stream }) => {
      const dir = fixture();
      if (!configured) {
        run(dir, "git", ["config", "--local", "--unset", ruleSetting]);
        unlinkSync(path.join(dir, rulePath));
      }
      stage(dir, "payload.ts", "clean\n");
      const payload = "public diagnostic context\n".repeat(4000) + "ACTIONABLE_FINAL_DETAIL\n";
      writeFileSync(path.join(dir, "payload.ts"), payload);
      diagnosticFormatter(dir, stream, 23);
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
      diagnosticFormatter(dir, stream, 0);
      expect(run(dir, "bash", ["-c", 'exec git "$@" 2>&1', "hook-proof", ...commitArgs])).toBe(
        payload.trim(),
      );
      expect(run(dir, "git", ["show", "HEAD:payload.ts"])).toBe(payload.trim());
    },
  );
});
