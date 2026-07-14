// Covers the public system-run command boundary and its approval consistency checks.
import { describe, expect, test } from "vitest";
import {
  extractShellCommandFromArgv,
  formatExecCommand,
  resolveSystemRunCommandRequest,
} from "./system-run-command.js";

function expectValidResult<T extends { ok: boolean }>(result: T): T & { ok: true } {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("expected valid system-run command");
  }
  return result as T & { ok: true };
}

function expectRawCommandMismatch(params: { argv: string[]; rawCommand: string }): void {
  const result = resolveSystemRunCommandRequest({
    command: params.argv,
    rawCommand: params.rawCommand,
  });
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected raw-command mismatch");
  }
  expect(result.message).toContain("rawCommand does not match command");
  expect(result.details?.code).toBe("RAW_COMMAND_MISMATCH");
}

describe("system run command public boundary", () => {
  test("formats command arguments without losing whitespace", () => {
    expect(formatExecCommand(["echo", "hi there"])).toBe('echo "hi there"');
    expect(formatExecCommand(["runner "])).toBe('"runner "');
  });

  test.each([
    { argv: ["/bin/sh", "-c", "echo hi"], expected: "echo hi" },
    { argv: ["cmd.exe", "/d", "/s", "/c", "echo", "hi"], expected: "echo hi" },
    { argv: ["/usr/bin/env", "FOO=bar", "zsh", "-c", "echo hi"], expected: "echo hi" },
    {
      argv: ["pwsh", "-CommandWithArgs", "allowed.exe", ";", "blocked.exe"],
      expected: "allowed.exe ; blocked.exe",
    },
    { argv: ["pwsh", "-File", "script.ps1", "-ExtraArg"], expected: "script.ps1" },
    { argv: ["busybox", "sh", "-c", "echo hi"], expected: "echo hi" },
    { argv: ["bash", "script.sh"], expected: null },
  ])("extracts the shell payload for $argv", ({ argv, expected }) => {
    expect(extractShellCommandFromArgv(argv)).toBe(expected);
  });

  test("keeps rawless sh -lc fail-closed", () => {
    expect(extractShellCommandFromArgv(["/bin/sh", "-lc", "echo hi"])).toBeNull();
  });

  test("requires argv when rawCommand is present", () => {
    const result = resolveSystemRunCommandRequest({ rawCommand: "echo hi" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details?.code).toBe("MISSING_COMMAND");
    }
  });

  test("normalizes non-string argv and empty requests", () => {
    expect(resolveSystemRunCommandRequest({})).toMatchObject({
      ok: true,
      argv: [],
      commandText: "",
    });
    expect(
      expectValidResult(resolveSystemRunCommandRequest({ command: ["echo", 123, false, null] })),
    ).toMatchObject({
      argv: ["echo", "123", "false", "null"],
      commandText: "echo 123 false null",
    });
  });

  test("accepts canonical direct argv text and trims it", () => {
    expect(
      expectValidResult(
        resolveSystemRunCommandRequest({ command: ["echo", "hi"], rawCommand: "  echo hi  " }),
      ),
    ).toMatchObject({
      commandText: "echo hi",
      shellPayload: null,
    });
  });

  test("accepts a legacy shell preview while retaining canonical command text", () => {
    expect(
      expectValidResult(
        resolveSystemRunCommandRequest({
          command: ["/bin/sh", "-lc", "echo hi"],
          rawCommand: "echo hi",
        }),
      ),
    ).toMatchObject({
      commandText: '/bin/sh -lc "echo hi"',
      previewText: "echo hi",
    });
  });

  test.each([
    {
      name: "direct argv mismatch",
      argv: ["uname", "-a"],
      rawCommand: "echo hi",
    },
    {
      name: "cmd trailing-argument smuggling",
      argv: ["cmd.exe", "/d", "/s", "/c", "echo", "SAFE&&whoami"],
      rawCommand: "echo",
    },
    {
      name: "shell positional-argv carrier",
      argv: ["/bin/sh", "-lc", '$0 "$1"', "/usr/bin/touch", "/tmp/marker"],
      rawCommand: '$0 "$1"',
    },
    {
      name: "environment prelude",
      argv: ["/usr/bin/env", "BASH_ENV=/tmp/payload.sh", "bash", "-lc", "echo hi"],
      rawCommand: "echo hi",
    },
    {
      name: "interactive shell startup flag",
      argv: ["/bin/bash", "-i", "-c", "/usr/bin/printf ok"],
      rawCommand: "/usr/bin/printf ok",
    },
    {
      name: "fish init command",
      argv: ["/usr/bin/fish", "--init-command=/tmp/payload.fish", "-c", "/usr/bin/printf ok"],
      rawCommand: "/usr/bin/printf ok",
    },
  ])("rejects $name approval-display mismatch", ({ argv, rawCommand }) => {
    expectRawCommandMismatch({ argv, rawCommand });
  });

  test("binds canonical text to the full positional carrier argv", () => {
    expect(
      expectValidResult(
        resolveSystemRunCommandRequest({
          command: ["/bin/sh", "-lc", '$0 "$1"', "/usr/bin/touch", "/tmp/marker"],
        }),
      ),
    ).toMatchObject({
      commandText: '/bin/sh -lc "$0 \\"$1\\"" /usr/bin/touch /tmp/marker',
      previewText: null,
    });
  });

  test("keeps PowerShell command-with-args payloads bound", () => {
    expect(
      expectValidResult(
        resolveSystemRunCommandRequest({
          command: ["pwsh", "-cwa", "Write-Output", "hi"],
          rawCommand: "Write-Output hi",
        }),
      ),
    ).toMatchObject({
      shellPayload: "Write-Output hi",
      previewText: "Write-Output hi",
    });
  });
});
