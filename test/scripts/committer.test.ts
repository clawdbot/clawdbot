import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const scriptPath = path.join(process.cwd(), "scripts", "committer");
const { createTempDir } = createScriptTestHarness();

function run(cwd: string, command: string, args: string[]) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
  }).trim();
}

function git(cwd: string, ...args: string[]) {
  return run(cwd, "git", args);
}

function createRepo() {
  const repo = createTempDir("committer-test-");

  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  git(repo, "add", "seed.txt");
  git(repo, "commit", "-qm", "seed");

  return repo;
}

function writeRepoFile(repo: string, relativePath: string, contents: string) {
  const fullPath = path.join(repo, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

function installHook(repo: string, relativePath: string, contents: string) {
  const fullPath = path.join(repo, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents, {
    encoding: "utf8",
    mode: 0o755,
  });
  git(repo, "config", "core.hooksPath", path.dirname(relativePath));
}

function commitWithHelper(repo: string, commitMessage: string, ...args: string[]) {
  return run(repo, "bash", [scriptPath, commitMessage, ...args]);
}

function commitWithHelperArgs(repo: string, ...args: string[]) {
  return run(repo, "bash", [scriptPath, ...args]);
}

function committedPaths(repo: string) {
  const output = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD");
  return output.split("\n").filter(Boolean).toSorted();
}

function committedFileContents(repo: string, relativePath: string) {
  return git(repo, "show", `HEAD:${relativePath}`);
}

describe("scripts/committer", () => {
  it("accepts supported path argument shapes", () => {
    const cases = [
      {
        commitMessage: "test: plain argv",
        files: [
          ["alpha.txt", "alpha\n"],
          ["nested/file with spaces.txt", "beta\n"],
        ] as const,
        args: ["alpha.txt", "nested/file with spaces.txt"],
        expected: ["alpha.txt", "nested/file with spaces.txt"],
      },
      {
        commitMessage: "test: space blob",
        files: [
          ["alpha.txt", "alpha\n"],
          ["beta.txt", "beta\n"],
        ] as const,
        args: ["alpha.txt beta.txt"],
        expected: ["alpha.txt", "beta.txt"],
      },
      {
        commitMessage: "test: newline blob",
        files: [
          ["alpha.txt", "alpha\n"],
          ["nested/file with spaces.txt", "beta\n"],
        ] as const,
        args: ["alpha.txt\nnested/file with spaces.txt"],
        expected: ["alpha.txt", "nested/file with spaces.txt"],
      },
    ] as const;

    for (const testCase of cases) {
      const repo = createRepo();
      for (const [file, contents] of testCase.files) {
        writeRepoFile(repo, file, contents);
      }

      commitWithHelper(repo, testCase.commitMessage, ...testCase.args);

      expect(committedPaths(repo)).toEqual(testCase.expected);
    }
  });

  it("commits changelog-only changes without pulling in unrelated dirty files", () => {
    const repo = createRepo();
    writeRepoFile(repo, "CHANGELOG.md", "initial\n");
    writeRepoFile(repo, "unrelated.ts", "export const ok = true;\n");
    git(repo, "add", "CHANGELOG.md", "unrelated.ts");
    git(repo, "commit", "-qm", "seed extra files");

    writeRepoFile(repo, "CHANGELOG.md", "breaking note\n");
    writeRepoFile(repo, "unrelated.ts", "<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\n");

    commitWithHelper(repo, "docs(changelog): note breaking change", "CHANGELOG.md");

    expect(committedPaths(repo)).toEqual(["CHANGELOG.md"]);
    expect(git(repo, "status", "--short")).toContain("M unrelated.ts");
  });

  it("supports --fast before the commit message", () => {
    const repo = createRepo();
    writeRepoFile(repo, "note.txt", "hello\n");

    const output = commitWithHelperArgs(repo, "--fast", "test: fast helper", "note.txt");

    expect(output).toContain('Committed "test: fast helper" with 1 files');
    expect(committedPaths(repo)).toEqual(["note.txt"]);
  });

  it("supports combining --force and --fast", () => {
    const repo = createRepo();
    writeRepoFile(repo, "note.txt", "hello\n");

    const output = commitWithHelperArgs(
      repo,
      "--force",
      "--fast",
      "test: fast forced helper",
      "note.txt",
    );

    expect(output).toContain('Committed "test: fast forced helper" with 1 files');
    expect(committedPaths(repo)).toEqual(["note.txt"]);
  });

  it("passes FAST_COMMIT through to git hooks when using --fast", () => {
    const repo = createRepo();
    installHook(
      repo,
      ".githooks/pre-commit",
      '#!/usr/bin/env bash\nset -euo pipefail\n[ "${FAST_COMMIT:-}" = "1" ] || exit 91\n',
    );
    writeRepoFile(repo, "note.txt", "hello\n");

    const output = commitWithHelperArgs(repo, "--fast", "test: fast hook env", "note.txt");

    expect(output).toContain('Committed "test: fast hook env" with 1 files');
    expect(committedPaths(repo)).toEqual(["note.txt"]);
  });

  it("commits the hook-restaged file contents and leaves the tree clean", () => {
    const repo = createRepo();
    installHook(
      repo,
      ".githooks/pre-commit",
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf 'formatted\\n' > note.txt",
        "git add note.txt",
      ].join("\n") + "\n",
    );
    writeRepoFile(repo, "note.txt", "raw\n");

    const output = commitWithHelperArgs(repo, "test: hook rewrite", "note.txt");

    expect(output).toContain('Committed "test: hook rewrite" with 1 files');
    expect(committedPaths(repo)).toEqual(["note.txt"]);
    expect(committedFileContents(repo, "note.txt")).toBe("formatted");
    expect(git(repo, "status", "--short", "--untracked-files=no")).toBe("");
  });

  it("prints usage for --help", () => {
    const repo = createRepo();

    const output = commitWithHelperArgs(repo, "--help");

    expect(output).toContain(
      'Usage: committer [--force] [--fast] "commit message" "file" ["file" ...]',
    );
  });
});
