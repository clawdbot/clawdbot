// Committer tests cover committer script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const scriptPath = path.join(process.cwd(), "scripts", "committer");
const { createTempDir } = createScriptTestHarness();
let templateRepo: string;

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
  cpSync(templateRepo, repo, { recursive: true });
  return repo;
}

function createTemplateRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "committer-template-"));
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

function commitWithHelperFailure(repo: string, ...args: string[]) {
  return spawnSync("bash", [scriptPath, ...args], { cwd: repo, encoding: "utf8" });
}

function committedPaths(repo: string) {
  const output = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD");
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (line) {
      paths.push(line);
    }
  }
  return paths.toSorted();
}

function committedFileContents(repo: string, relativePath: string) {
  return git(repo, "show", `HEAD:${relativePath}`);
}

describe("scripts/committer", () => {
  beforeAll(() => {
    templateRepo = createTemplateRepo();
  });

  afterAll(() => {
    rmSync(templateRepo, { recursive: true, force: true });
  });

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

  it("fails before staging when formatting dependencies are missing", () => {
    const repo = createRepo();
    writeRepoFile(repo, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    writeRepoFile(
      repo,
      "scripts/pre-commit/filter-staged-files.mjs",
      "for (const file of process.argv.slice(4)) { if (file.endsWith('.ts')) process.stdout.write(file + '\\0'); }\n",
    );
    writeRepoFile(repo, "note.ts", "export const note = true;\n");

    const result = commitWithHelperFailure(repo, "test: missing formatter", "note.ts");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot run oxfmt without node_modules");
    expect(result.stderr).toContain("--no-verify-formatted");
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
    expect(git(repo, "log", "-1", "--pretty=%s")).toBe("seed");
  });

  it("commits dependency-less formatted work only with the explicit assertion", () => {
    const repo = createRepo();
    writeRepoFile(repo, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    writeRepoFile(
      repo,
      "scripts/pre-commit/filter-staged-files.mjs",
      "for (const file of process.argv.slice(4)) { if (file.endsWith('.ts')) process.stdout.write(file + '\\0'); }\n",
    );
    writeRepoFile(repo, "note.ts", "export const note = true;\n");

    const output = commitWithHelperArgs(
      repo,
      "--no-verify-formatted",
      "test: formatted assertion",
      "note.ts",
    );

    expect(output).toContain("asserts separate formatting proof; committing with --no-verify");
    expect(committedPaths(repo)).toEqual(["note.ts"]);
  });

  it("fails before staging when formatter applicability cannot be determined", () => {
    const repo = createRepo();
    writeRepoFile(repo, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    writeRepoFile(
      repo,
      "scripts/pre-commit/filter-staged-files.mjs",
      "process.stderr.write('fixture filter failure\\n'); process.exit(7);\n",
    );
    writeRepoFile(repo, "note.ts", "export const note = true;\n");

    const result = commitWithHelperFailure(repo, "test: failed formatter filter", "note.ts");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unable to determine formatter applicability");
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
    expect(git(repo, "log", "-1", "--pretty=%s")).toBe("seed");
  });

  it("bypasses git hooks when using --fast", () => {
    const repo = createRepo();
    installHook(repo, ".githooks/pre-commit", "#!/usr/bin/env bash\nset -euo pipefail\nexit 91\n");
    writeRepoFile(repo, "note.txt", "hello\n");

    const output = commitWithHelperArgs(repo, "--fast", "test: fast no verify", "note.txt");

    expect(output).toContain('Committed "test: fast no verify" with 1 files');
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
      'Usage: committer [--force] [--fast] [--no-verify-formatted] "commit message" "file" ["file" ...]',
    );
  });
});
