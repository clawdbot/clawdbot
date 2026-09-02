import { afterEach, describe, expect, it, vi } from "vitest";
import * as processExec from "../process/exec.js";
import type { SpawnResult } from "../process/exec.js";
import {
  createGitCommandError,
  executeGitCommand,
  requireGitCommand,
  requireGitCommandBuffer,
  requireGitCommandRaw,
} from "./git-exec.js";

afterEach(() => vi.restoreAllMocks());

const progress = Array.from({ length: 1000 }, (_, i) => `Updating files: ${i}/1000`).join("\r");
const failure = {
  stdout: "",
  stderr: "",
  code: 128,
  signal: null,
  killed: false,
  termination: "exit",
} satisfies SpawnResult;

it.each([
  { timeoutMs: undefined, seconds: 120 },
  { timeoutMs: 300_000, seconds: 300 },
])("reports the applied $seconds-second Git timeout", async ({ timeoutMs, seconds }) => {
  const commandSpy = vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValue({
    ...failure,
    termination: "timeout",
    code: 124,
  });
  const args = ["worktree", "add"];
  const result = await executeGitCommand("/repo", args, { timeoutMs });
  const label = `timed out after ${seconds} seconds`;
  expect(createGitCommandError("git worktree add", result).message).toContain(label);
  await expect(requireGitCommand("/repo", args, { timeoutMs })).rejects.toThrow(label);
  expect(
    commandSpy.mock.calls.map(([, options]) =>
      typeof options === "number" ? options : options.timeoutMs,
    ),
  ).toEqual([seconds * 1000, seconds * 1000]);
});

describe.each([
  ["text", requireGitCommand],
  ["raw", requireGitCommandRaw],
  ["buffered", requireGitCommandBuffer],
] as const)("Git %s diagnostics", (_kind, requireGit) => {
  async function failureMessage(args: string[]): Promise<string> {
    try {
      await requireGit("/repo", args);
    } catch (error) {
      if (error instanceof Error) {
        return error.message;
      }
      throw error;
    }
    throw new Error("Expected Git to fail");
  }

  function failWith(overrides: Partial<SpawnResult>) {
    const result = { ...failure, ...overrides };
    vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValueOnce(result);
    vi.spyOn(processExec, "runCommandBuffered").mockResolvedValueOnce({
      ...result,
      stdout: Buffer.from(result.stdout),
      stderr: Buffer.from(result.stderr),
      code: result.termination === "exit" && !result.outputLimitExceeded ? result.code : null,
      termination: result.outputLimitExceeded
        ? "output-limit"
        : result.termination === "no-output-timeout"
          ? "timeout"
          : result.termination,
    });
  }

  it.each(["\n", "\r\n"])(
    "collapses redraws and preserves fatal details with %j",
    async (newline) => {
      failWith({
        stderr: `Preparing worktree${newline}${progress}\r${newline}\u001b[31mfatal: disk full\u001b[0m${newline}`,
      });
      await expect(requireGit("/repo", ["worktree", "add"])).rejects.toThrow(
        "git worktree add failed (exit code 128):\nPreparing worktree\nUpdating files: 999/1000\nfatal: disk full",
      );
    },
  );

  it("bounds long diagnostic lines and keeps the useful tail", async () => {
    failWith({ stderr: `${"x".repeat(30_000)}\nfatal: permission denied\n` });
    const message = await failureMessage(["status"]);
    expect(message.length).toBeLessThanOrEqual(2400);
    expect(message).toContain("…");
    expect(message).toMatch(/fatal: permission denied$/);
  });

  it("bounds newline progress and reports exit 124 without inventing a timeout", async () => {
    failWith({ code: 124, stderr: progress.replaceAll("\r", "\n") });
    const message = await failureMessage(["status"]);
    expect(message.length).toBeLessThanOrEqual(2400);
    expect(message.split("\n").length).toBeLessThanOrEqual(14);
    expect(message).toContain("exit code 124");
    expect(message).not.toMatch(/timed out|timeout/i);
  });

  it.each([
    {
      termination: "timeout",
      signal: "SIGKILL",
      code: 124,
      expected: "timed out after 120 seconds; signal SIGKILL",
    },
    {
      termination: "signal",
      signal: "SIGTERM",
      code: null,
      expected: "signal SIGTERM",
    },
    {
      termination: "signal",
      signal: "SIGKILL",
      outputLimitExceeded: true,
      code: null,
      expected: "output limit exceeded; signal SIGKILL",
    },
  ] satisfies Array<Partial<SpawnResult> & { expected: string }>)(
    "reports $expected even when only progress was captured",
    async ({ expected, ...metadata }) => {
      failWith({ ...metadata, stderr: progress });
      const message = await failureMessage(["worktree", "add"]);
      expect(message).toContain(`failed (${expected})`);
      expect(message.length).toBeLessThan(400);
      expect(message).toContain("Updating files: 999/1000");
      if (metadata.termination === "timeout") {
        expect(message).toContain("Check repository access and disk space.");
      } else {
        expect(message).not.toMatch(/timed out|timeout/i);
      }
    },
  );

  it.each(["", " \t\r\n", `${String.fromCharCode(27)}[0m`, "progress\r \t"])(
    "uses stdout when stderr has no visible diagnostic: %j",
    async (stderr) => {
      failWith({ stderr, stdout: "error: cannot read index\n" });
      await expect(requireGit("/repo", ["status"])).rejects.toThrow("error: cannot read index");
    },
  );
});

describe("successful Git output", () => {
  it("keeps raw text byte-for-byte and preserves the trimmed text contract", async () => {
    const stdout = " \u001b[31mname\u001b[0m\rredraw\0\r\n ";
    vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValue({
      ...failure,
      code: 0,
      stdout,
    });
    await expect(requireGitCommandRaw("/repo", ["status"])).resolves.toBe(stdout);
    await expect(requireGitCommand("/repo", ["status"])).resolves.toBe(stdout.trim());
  });

  it("keeps binary output including invalid UTF-8 and terminal control bytes", async () => {
    const stdout = Buffer.from([0, 255, 13, 10, 27, 91, 51, 49, 109, 32]);
    vi.spyOn(processExec, "runCommandBuffered").mockResolvedValue({
      ...failure,
      code: 0,
      stdout,
      stderr: Buffer.alloc(0),
    });
    await expect(requireGitCommandBuffer("/repo", ["show"])).resolves.toEqual(stdout);
  });
});
