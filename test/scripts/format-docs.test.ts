// Format Docs tests cover the docs formatter helper process spawning.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  chunkFilesForCommand,
  docsFiles,
  formatDocs,
  resolveOxfmtInvocation,
  runOxfmt,
} from "../../scripts/format-docs.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function writeDocsFixture(root: string): void {
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# OpenClaw\n", "utf8");
  fs.writeFileSync(path.join(root, "docs", "guide.mdx"), "# Guide\n", "utf8");
}

describe("format-docs", () => {
  it("wraps the Windows oxfmt.cmd shim through cmd.exe", () => {
    const invocation = resolveOxfmtInvocation(["--write", "docs\\guide.mdx"], {
      comSpec: "C:\\Windows\\System32\\cmd.exe",
      existsSync: (candidate: string) => candidate.endsWith("oxfmt.cmd"),
      platform: "win32",
      repoRoot: "C:\\repo",
    });

    expect(invocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.args[3]).toContain("oxfmt.cmd");
    expect(invocation.args[3]).toContain("--write");
    expect(invocation.args[3]).toContain("docs\\guide.mdx");
    expect(invocation.shell).toBe(false);
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });

  it("batches oxfmt invocations when docs exceed the command line budget", () => {
    const root = createTempDir("openclaw-format-docs-batch-");
    const calls: Array<{ args: string[]; command: string }> = [];

    runOxfmt(
      ["docs/one.md", "docs/two.md", "docs/three.md"],
      {
        maxCommandLineBytes: 1,
        repoRoot: root,
      },
      {
        existsSync: () => false,
        spawnSync: (command: string, args: string[]) => {
          calls.push({ args, command });
          return { status: 0, stderr: "", stdout: "" };
        },
      },
    );

    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.command === process.execPath)).toBe(true);
    expect(calls.map((call) => call.args.at(-1))).toEqual([
      "docs/one.md",
      "docs/two.md",
      "docs/three.md",
    ]);
  });

  it("reports git and oxfmt spawn diagnostics", () => {
    const root = createTempDir("openclaw-format-docs-failures-");

    expect(() =>
      docsFiles(root, {
        spawnSync: () => ({
          status: 128,
          stderr: "fatal: not a git repository",
          stdout: "",
        }),
      }),
    ).toThrow(/git ls-files failed:[\s\S]*exit status: 128[\s\S]*fatal: not a git repository/u);

    expect(() =>
      runOxfmt(
        ["README.md"],
        { repoRoot: root },
        {
          existsSync: () => false,
          spawnSync: () => ({
            status: 1,
            stderr: "formatter stderr",
            stdout: "formatter stdout",
          }),
        },
      ),
    ).toThrow(
      /oxfmt failed:[\s\S]*command:[\s\S]*exit status: 1[\s\S]*formatter stderr[\s\S]*formatter stdout/u,
    );
  });

  it("uses repository paths in write mode and temporary paths in check mode", () => {
    const root = createTempDir("openclaw-format-docs-mode-");
    writeDocsFixture(root);
    const oxfmtFileArgs: string[][] = [];

    const spawnSync = (command: string, args: string[]) => {
      if (command === "git") {
        return {
          status: 0,
          stderr: "",
          stdout: "README.md\ndocs/guide.mdx\n",
        };
      }
      oxfmtFileArgs.push(args.slice(-2));
      return { status: 0, stderr: "", stdout: "" };
    };

    expect(
      formatDocs(
        {
          check: false,
          repoRoot: root,
          root,
        },
        {
          existsSync: fs.existsSync,
          spawnSync,
        },
      ),
    ).toEqual({ changed: [], fileCount: 2 });

    expect(
      formatDocs(
        {
          check: true,
          repoRoot: root,
          root,
        },
        {
          existsSync: fs.existsSync,
          spawnSync,
        },
      ),
    ).toEqual({ changed: [], fileCount: 2 });

    expect(oxfmtFileArgs[0]).toEqual(["README.md", "docs/guide.mdx"]);
    expect(oxfmtFileArgs[1]?.every((filePath) => path.isAbsolute(filePath))).toBe(true);
    expect(oxfmtFileArgs[1]?.every((filePath) => filePath.startsWith(root))).toBe(false);
  });

  it("keeps single oversized docs in their own command chunk", () => {
    expect(chunkFilesForCommand(["docs/very-long-name.md"], ["--write"], 1)).toEqual([
      ["docs/very-long-name.md"],
    ]);
  });
});
