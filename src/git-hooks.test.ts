import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  filterOxfmtTargets,
  filterOutPartialTargets,
  findPartiallyStagedFiles,
  splitNullDelimited,
} from "../scripts/format-staged.js";
import { setupGitHooks } from "../scripts/setup-git-hooks.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "moltbot-hooks-"));
}

describe("format-staged helpers", () => {
  it("splits null-delimited output", () => {
    expect(splitNullDelimited("a\0b\0")).toEqual(["a", "b"]);
    expect(splitNullDelimited("")).toEqual([]);
  });

  it("filters oxfmt targets", () => {
    const targets = filterOxfmtTargets([
      "src/app.ts",
      "src/app.md",
      "test/foo.tsx",
      "scripts/dev.ts",
      "test\\bar.js",
    ]);
    expect(targets).toEqual(["src/app.ts", "test/foo.tsx", "test/bar.js"]);
  });

  it("detects partially staged files", () => {
    const partial = findPartiallyStagedFiles(
      ["src/a.ts", "test/b.tsx"],
      ["src/a.ts", "docs/readme.md"],
    );
    expect(partial).toEqual(["src/a.ts"]);
  });

  it("filters out partial targets", () => {
    const filtered = filterOutPartialTargets(
      ["src/a.ts", "test/b.tsx", "test/c.ts"],
      ["test/b.tsx"],
    );
    expect(filtered).toEqual(["src/a.ts", "test/c.ts"]);
  });
});

describe("setupGitHooks", () => {
  it("returns git-missing when git is unavailable", () => {
    const runGit = vi.fn(() => ({ status: 1, stdout: "" }));
    const result = setupGitHooks({ repoRoot: "/tmp", runGit });
    expect(result).toEqual({ ok: false, reason: "git-missing" });
    expect(runGit).toHaveBeenCalled();
  });

  it("returns not-repo when not inside a work tree", () => {
    const runGit = vi.fn((args) => {
      if (args[0] === "--version") return { status: 0, stdout: "git version" };
      if (args[0] === "rev-parse") return { status: 0, stdout: "false" };
      return { status: 1, stdout: "" };
    });

    const result = setupGitHooks({ repoRoot: "/tmp", runGit });
    expect(result).toEqual({ ok: false, reason: "not-repo" });
  });

  it("configures hooks path when inside a repo", () => {
    const repoRoot = makeTempDir();
    const hooksDir = path.join(repoRoot, "git-hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(hookPath, "#!/bin/sh\n", "utf-8");
    fs.chmodSync(hookPath, 0o644);

    const runGit = vi.fn((args) => {
      if (args[0] === "--version") return { status: 0, stdout: "git version" };
      if (args[0] === "rev-parse") return { status: 0, stdout: "true" };
      if (args[0] === "config") return { status: 0, stdout: "" };
      return { status: 1, stdout: "" };
    });

    const result = setupGitHooks({ repoRoot, runGit });
    expect(result).toEqual({ ok: true });
    expect(runGit.mock.calls.some(([args]) => args[0] === "config")).toBe(true);

    if (process.platform !== "win32") {
      const mode = fs.statSync(hookPath).mode & 0o777;
      expect(mode & 0o100).toBeTruthy();
    }

    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
});
