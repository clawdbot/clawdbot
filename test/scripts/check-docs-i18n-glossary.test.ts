import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGitRunner,
  parseArgs,
  readGitFile,
} from "../../scripts/lib/docs-i18n-glossary-git.mts";
import * as managedChildProcess from "../../scripts/lib/managed-child-process.mts";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const scriptPath = path.resolve("scripts/check-docs-i18n-glossary.mts");
const tempDirs: string[] = [];

function writeGitFixture(binDir: string, body: string): void {
  if (process.platform === "win32") {
    const fixturePath = path.join(binDir, "git-fixture.mjs");
    writeFileSync(fixturePath, body);
    writeFileSync(
      path.join(binDir, "git.cmd"),
      `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`,
    );
    return;
  }
  writeFileSync(path.join(binDir, "git"), `#!${process.execPath}\n${body}`, { mode: 0o755 });
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("check-docs-i18n-glossary", () => {
  it("parses explicit diff refs", () => {
    expect(parseArgs(["--base", "origin/main", "--head", "HEAD"])).toEqual({
      base: "origin/main",
      head: "HEAD",
    });
  });

  it("rejects missing diff ref values", () => {
    expect(() => parseArgs(["--base", "--head", "HEAD"])).toThrow("--base requires a value");
    expect(() => parseArgs(["--base", "-h", "--head", "HEAD"])).toThrow("--base requires a value");
    expect(() => parseArgs(["--head"])).toThrow("--head requires a value");
    expect(() => parseArgs(["--head", "-h"])).toThrow("--head requires a value");
    expect(() => parseArgs(["--base", ""])).toThrow("--base requires a value");
  });

  it("runs git as direct argv so Windows-special pathnames are not cmd-wrapped", async () => {
    const runSpy = vi.spyOn(managedChildProcess, "runManagedCommand");
    runSpy.mockResolvedValue(0 as never);
    try {
      const runGit = createGitRunner({ cwd: process.cwd() });
      await expect(runGit(["show", "HEAD:docs/a&b.md"])).resolves.toBe("");
      expect(runSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          bin: "git",
          args: ["show", "HEAD:docs/a&b.md"],
          shell: false,
          timeoutForceKillOnLeaderExit: true,
          timeoutKillGraceMs: 0,
        }),
      );
    } finally {
      runSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")(
    "passes Windows-special pathname arguments to git unchanged",
    async () => {
      const tempDir = makeTempDir(tempDirs, "check-docs-i18n-glossary-");
      const binDir = path.join(tempDir, "bin");
      const argsPath = path.join(tempDir, "args.json");
      mkdirSync(binDir);
      writeGitFixture(
        binDir,
        `require("node:fs").writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));\nprocess.exit(0);\n`,
      );

      const runGit = createGitRunner({
        timeoutMs: 500,
        env: {
          ...process.env,
          PATH: binDir,
          ARGS_FILE: argsPath,
        },
      });

      await expect(runGit(["show", "HEAD:docs/a&b.md"])).resolves.toBe("");
      expect(JSON.parse(readFileSync(argsPath, "utf8"))).toEqual(["show", "HEAD:docs/a&b.md"]);
    },
  );

  it("fails with an actionable timeout when git diff hangs", async () => {
    const tempDir = makeTempDir(tempDirs, "check-docs-i18n-glossary-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir);
    writeGitFixture(
      binDir,
      'if (process.argv[2] === "diff") { setTimeout(() => {}, 10_000); }\nelse { process.exit(0); }\n',
    );

    const runGit = createGitRunner({
      timeoutMs: 500,
      env: {
        ...process.env,
        PATH: binDir,
      },
    });

    await expect(
      runGit(["diff", "--name-only", "--diff-filter=ACMR", "HEAD~1", "--", "docs"]),
    ).rejects.toThrow(
      "docs:check-i18n-glossary: git diff --name-only --diff-filter=ACMR HEAD~1 -- docs timed out after 500ms.",
    );
  });

  it("propagates timeout diagnostics when git merge-base hangs", async () => {
    const tempDir = makeTempDir(tempDirs, "check-docs-i18n-glossary-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir);
    writeGitFixture(
      binDir,
      'if (process.argv[2] === "merge-base") { setTimeout(() => {}, 10_000); }\nelse { process.exit(0); }\n',
    );

    const runGit = createGitRunner({
      timeoutMs: 500,
      env: {
        ...process.env,
        PATH: binDir,
      },
    });

    await expect(runGit(["merge-base", "origin/main", "HEAD"])).rejects.toThrow(
      "docs:check-i18n-glossary: git merge-base origin/main HEAD timed out after 500ms.",
    );
  });

  it("exits with the managed SIGTERM status during merge-base resolution", () => {
    const tempDir = makeTempDir(tempDirs, "check-docs-i18n-glossary-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir);
    writeGitFixture(
      binDir,
      `if (process.argv[2] === "merge-base" && process.argv[3] === "origin/main") {
  process.exit(143);
}
if (process.argv[2] === "merge-base") {
  console.log("base-sha");
  process.exit(0);
}
if (process.argv[2] === "diff") {
  process.exit(0);
}
process.exit(1);
`,
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: binDir,
      },
    });

    expect(result.status).toBe(143);
    expect(result.stderr).toContain(
      "docs:check-i18n-glossary: git merge-base origin/main HEAD failed: git exited with code 143",
    );
  });

  it("propagates timed-out git show failures from readGitFile", async () => {
    const tempDir = makeTempDir(tempDirs, "check-docs-i18n-glossary-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir);
    writeGitFixture(
      binDir,
      'if (process.argv[2] === "ls-tree") { console.log("100644 blob abc123\\tdocs/example.md"); process.exit(0); }\nif (process.argv[2] === "show") { setTimeout(() => {}, 10_000); }\nelse { process.exit(0); }\n',
    );

    const git = createGitRunner({
      timeoutMs: 500,
      env: {
        ...process.env,
        PATH: binDir,
      },
    });
    const startedAt = Date.now();

    await expect(readGitFile("HEAD", "docs/example.md", git)).rejects.toThrow(
      "docs:check-i18n-glossary: git show HEAD:docs/example.md timed out after 500ms.",
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
  });

  it("keeps the empty baseline fallback only for absent base files", async () => {
    const tempDir = makeTempDir(tempDirs, "check-docs-i18n-glossary-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir);
    writeGitFixture(
      binDir,
      "if (process.argv[2] === \"show\") { console.error(\"fatal: path 'docs/new.md' does not exist in 'HEAD'\"); process.exit(128); }\nprocess.exit(0);\n",
    );

    const git = createGitRunner({
      timeoutMs: 500,
      env: {
        ...process.env,
        PATH: binDir,
      },
    });

    await expect(readGitFile("HEAD", "docs/new.md", git)).resolves.toBe("");
  });

  it("detects an absent base file without parsing localized git diagnostics", async () => {
    const tempDir = makeTempDir(tempDirs, "check-docs-i18n-glossary-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir);
    writeGitFixture(
      binDir,
      "if (process.argv[2] === \"show\") { console.error(\"fatal: 路径 'docs/new.md' 在 'HEAD' 中不存在\"); process.exit(128); }\nprocess.exit(0);\n",
    );

    const git = createGitRunner({
      timeoutMs: 500,
      env: {
        ...process.env,
        PATH: binDir,
      },
    });

    await expect(readGitFile("HEAD", "docs/new.md", git)).resolves.toBe("");
  });

  it("reads baseline content when the base file exists", async () => {
    const tempDir = makeTempDir(tempDirs, "check-docs-i18n-glossary-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir);
    writeGitFixture(
      binDir,
      'if (process.argv[2] === "ls-tree") { console.log("100644 blob abc123\\tdocs/example.md"); process.exit(0); }\nif (process.argv[2] === "show") { console.log("base content"); process.exit(0); }\nprocess.exit(0);\n',
    );

    const git = createGitRunner({
      timeoutMs: 500,
      env: {
        ...process.env,
        PATH: binDir,
      },
    });

    await expect(readGitFile("HEAD", "docs/example.md", git)).resolves.toBe("base content");
  });

  it("surfaces other git show failures instead of an empty baseline", async () => {
    const tempDir = makeTempDir(tempDirs, "check-docs-i18n-glossary-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir);
    writeGitFixture(
      binDir,
      'if (process.argv[2] === "ls-tree") { console.log("100644 blob abc123\\tdocs/example.md"); process.exit(0); }\nif (process.argv[2] === "show") { console.error("fatal: bad object"); process.exit(128); }\nprocess.exit(0);\n',
    );

    const git = createGitRunner({
      timeoutMs: 500,
      env: {
        ...process.env,
        PATH: binDir,
      },
    });

    await expect(readGitFile("HEAD", "docs/example.md", git)).rejects.toThrow(
      "docs:check-i18n-glossary: git show HEAD:docs/example.md failed: fatal: bad object",
    );
  });

  it.skipIf(process.platform === "win32")(
    "force-kills the managed git process group on timeout",
    async () => {
      const tempDir = makeTempDir(tempDirs, "check-docs-i18n-glossary-");
      const binDir = path.join(tempDir, "bin");
      const readyPath = path.join(tempDir, "ready");
      mkdirSync(binDir);
      writeGitFixture(
        binDir,
        'if (process.argv[2] === "diff") { require("node:fs").writeFileSync(process.env.PROOF_READY, "ready"); process.on("SIGTERM", () => {}); setInterval(() => {}, 10_000); }\nelse { process.exit(0); }\n',
      );

      const runGit = createGitRunner({
        timeoutMs: 500,
        env: {
          ...process.env,
          PATH: binDir,
          PROOF_READY: readyPath,
        },
      });
      const startedAt = Date.now();

      await expect(
        runGit(["diff", "--name-only", "--diff-filter=ACMR", "HEAD~1", "--", "docs"]),
      ).rejects.toThrow(
        "docs:check-i18n-glossary: git diff --name-only --diff-filter=ACMR HEAD~1 -- docs timed out after 500ms.",
      );
      const elapsedMs = Date.now() - startedAt;
      expect(existsSync(readyPath)).toBe(true);
      expect(elapsedMs).toBeGreaterThanOrEqual(500);
      expect(elapsedMs).toBeLessThan(8_000);
    },
  );

  it("preserves stderr when git fails without timing out", () => {
    const tempDir = makeTempDir(tempDirs, "check-docs-i18n-glossary-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir);
    writeGitFixture(
      binDir,
      'if (process.argv[2] === "diff") { console.error("fatal: invalid revision"); process.exit(128); }\nprocess.exit(0);\n',
    );

    const result = spawnSync(process.execPath, [scriptPath, "--base", "missing-ref"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: binDir,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs:check-i18n-glossary: git diff --name-only --diff-filter=ACMR missing-ref -- docs failed: fatal: invalid revision",
    );
  });

  it("reports the exit code when git fails without stderr", async () => {
    const tempDir = makeTempDir(tempDirs, "check-docs-i18n-glossary-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir);
    writeGitFixture(
      binDir,
      'if (process.argv[2] === "show") { process.exit(1); }\nprocess.exit(0);\n',
    );

    const git = createGitRunner({
      timeoutMs: 500,
      env: {
        ...process.env,
        PATH: binDir,
      },
    });

    await expect(git(["show", "HEAD:docs/example.md"])).rejects.toThrow(
      "docs:check-i18n-glossary: git show HEAD:docs/example.md failed: git exited with code 1",
    );
  });

  it("preserves the runner cause when spawning git fails without stderr", async () => {
    const runSpy = vi.spyOn(managedChildProcess, "runManagedCommand");
    runSpy.mockRejectedValue(
      Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }) as never,
    );
    try {
      const runGit = createGitRunner({ cwd: process.cwd() });
      await expect(runGit(["show", "HEAD:docs/example.md"])).rejects.toThrow(
        "docs:check-i18n-glossary: git show HEAD:docs/example.md failed: spawn git ENOENT",
      );
    } finally {
      runSpy.mockRestore();
    }
  });

  it("preserves process-cleanup failures without stderr", async () => {
    const runSpy = vi.spyOn(managedChildProcess, "runManagedCommand");
    runSpy.mockRejectedValue(
      new AggregateError(
        [new Error("spawn git ENOENT")],
        "Managed command setup failed and its process tree could not be cleaned up",
      ) as never,
    );
    try {
      const runGit = createGitRunner({ cwd: process.cwd() });
      await expect(runGit(["show", "HEAD:docs/example.md"])).rejects.toThrow(
        "docs:check-i18n-glossary: git show HEAD:docs/example.md failed: Managed command setup failed and its process tree could not be cleaned up",
      );
    } finally {
      runSpy.mockRestore();
    }
  });
});
