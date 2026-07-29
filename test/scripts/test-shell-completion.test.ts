// Shell completion test script tests cover local diagnostic CLI argument safety.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testing as shellCompletionTesting } from "../../scripts/test-shell-completion.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { force: true, recursive: true });
  }
});

describe("test-shell-completion script", () => {
  it("parses explicit shell overrides", () => {
    expect(shellCompletionTesting.parseArgs(["--shell", "bash", "--check-only"])).toEqual({
      checkOnly: true,
      force: false,
      help: false,
      shell: "bash",
    });
    expect(shellCompletionTesting.parseArgs(["--shell=fish"])).toEqual({
      checkOnly: false,
      force: false,
      help: false,
      shell: "fish",
    });
  });

  it("rejects unknown or malformed arguments before touching shell state", () => {
    expect(() => shellCompletionTesting.parseArgs(["--wat"])).toThrow("Unknown argument: --wat");
    expect(() => shellCompletionTesting.parseArgs(["--shell"])).toThrow("--shell requires a value");
    expect(() => shellCompletionTesting.parseArgs(["--shell", "--check-only"])).toThrow(
      "--shell requires a value",
    );
    expect(() => shellCompletionTesting.parseArgs(["--shell", "tcsh"])).toThrow(
      "--shell must be one of:",
    );
  });

  it("prints help without running completion status checks", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/test-shell-completion.ts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("--shell <shell>");
    expect(result.stdout).not.toContain("Cache path:");
  });

  it("fails unknown arguments before prompting or checking shell state", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/test-shell-completion.ts", "--wat"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown argument: --wat");
  });

  it("uses --shell for check-only status instead of the detected shell", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-shell-home-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-shell-state-"));
    tempDirs.push(homeDir, stateDir);

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/test-shell-completion.ts", "--shell", "fish", "--check-only"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: homeDir,
          NO_COLOR: "1",
          OPENCLAW_STATE_DIR: stateDir,
          SHELL: "/bin/zsh",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Shell:");
    expect(result.stdout).toContain("fish");
    expect(result.stdout).toContain("(from --shell)");
    expect(result.stdout).not.toContain("(detected from $SHELL)");
  });
});
