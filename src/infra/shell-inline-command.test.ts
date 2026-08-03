// Covers shell inline command flag parsing.
import { describe, expect, it } from "vitest";
import {
  POSIX_INLINE_COMMAND_FLAGS,
  resolveInlineCommandMatch,
  resolvePowerShellInlineCommandMatch,
} from "./shell-inline-command.js";

describe("resolveInlineCommandMatch", () => {
  it.each([
    {
      name: "extracts the next token for bash -lc",
      argv: ["bash", "-lc", "echo hi"],
      opts: {},
      expected: { command: "echo hi", valueTokenIndex: 2 },
    },
    {
      name: "supports combined -c forms when enabled",
      argv: ["sh", "-cecho hi"],
      opts: { allowCombinedC: true },
      expected: { command: "echo hi", valueTokenIndex: 1 },
    },
    {
      name: "keeps post-c no-argument shell flags separate from the command",
      argv: ["bash", "-cx", "echo hi"],
      opts: { allowCombinedC: true },
      expected: { command: "echo hi", valueTokenIndex: 2 },
    },
    {
      name: "keeps post-c stdin shell flags separate from the command",
      argv: ["bash", "-cs", "echo hi"],
      opts: { allowCombinedC: true },
      expected: { command: "echo hi", valueTokenIndex: 2 },
    },
    {
      name: "extracts yash long cmdline option",
      argv: ["yash", "--cmdline", "echo hi"],
      opts: {},
      expected: { command: "echo hi", valueTokenIndex: 2 },
    },
    {
      name: "keeps pre-c clustered shell flags separate from the command",
      argv: ["yash", "-xc", "echo hi"],
      opts: { allowCombinedC: true },
      expected: { command: "echo hi", valueTokenIndex: 2 },
    },
    {
      name: "rejects combined -c forms when disabled",
      argv: ["sh", "-cecho hi"],
      opts: { allowCombinedC: false },
      expected: { command: null, valueTokenIndex: null },
    },
    {
      name: "returns a value index for blank command tokens",
      argv: ["bash", "-lc", "   "],
      opts: {},
      expected: { command: null, valueTokenIndex: 2 },
    },
    {
      name: "returns null value index when the flag has no following token",
      argv: ["bash", "-lc"],
      opts: {},
      expected: { command: null, valueTokenIndex: null },
    },
  ])("$name", ({ argv, opts, expected }) => {
    expect(resolveInlineCommandMatch(argv, POSIX_INLINE_COMMAND_FLAGS, opts)).toEqual(expected);
  });

  it("stops parsing after --", () => {
    expect(
      resolveInlineCommandMatch(["bash", "--", "-lc", "echo hi"], POSIX_INLINE_COMMAND_FLAGS),
    ).toEqual({
      command: null,
      valueTokenIndex: null,
    });
  });

  it.each([
    {
      name: "stops at an omitted PowerShell script file before script args",
      argv: ["pwsh", "script.ps1", "-en", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      expected: { command: null, valueTokenIndex: null },
    },
    {
      name: "skips PowerShell option values before encoded-command prefixes",
      argv: [
        "pwsh",
        "-WorkingDirectory",
        "/tmp/project",
        "-en",
        "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA",
      ],
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 4 },
    },
    {
      name: "skips abbreviated PowerShell window style values before slash encoded command",
      argv: ["pwsh", "-win", "hidden", "/ec", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 4 },
    },
    {
      name: "skips abbreviated PowerShell working directory values before slash encoded command",
      argv: [
        "pwsh",
        "-WorkingDir",
        "/tmp/project",
        "/ec",
        "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA",
      ],
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 4 },
    },
    {
      name: "skips PowerShell input format alias values before encoded-command prefixes",
      argv: ["pwsh", "-if", "XML", "-EncodedCommand", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 4 },
    },
    {
      name: "skips slash PowerShell input format alias values before slash encoded command",
      argv: ["pwsh", "/if", "XML", "/ec", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 4 },
    },
    {
      name: "skips PowerShell configuration name values before encoded-command prefixes",
      argv: ["pwsh", "-config", "SomeConfig", "-ec", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 4 },
    },
    {
      name: "skips PowerShell custom pipe name values before encoded-command prefixes",
      argv: ["pwsh", "-cus", "pipe-name", "-ec", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 4 },
    },
    {
      name: "extracts the command tail for PowerShell command-with-args",
      argv: ["pwsh", "-cwa", "Write-Output", "hi"],
      expected: { command: "Write-Output hi", valueTokenIndex: 2 },
    },
    {
      name: "extracts PowerShell slash switch forms before script file binding",
      argv: ["pwsh", "/ec", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 2 },
    },
    {
      name: "keeps scanning after PowerShell slash switches",
      argv: ["pwsh", "/NoProfile", "/ec", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 3 },
    },
    {
      name: "stops at slash paths before PowerShell script args",
      argv: ["/usr/bin/pwsh", "/tmp/script.ps1", "/ec", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      expected: { command: null, valueTokenIndex: null },
    },
  ])("$name", ({ argv, expected }) => {
    expect(resolvePowerShellInlineCommandMatch(argv)).toEqual(expected);
  });
});

describe("resolvePowerShellInlineCommandMatch", () => {
  it.each([
    {
      name: "slash encoded-command alias",
      argv: ["pwsh", "/NoProfile", "/ec", "ZQBjAGgAbwA="],
      expected: { command: "ZQBjAGgAbwA=", valueTokenIndex: 3 },
    },
    {
      name: "encoded-command prefix abbreviation",
      argv: ["pwsh", "-en", "ZQBjAGgAbwA="],
      expected: { command: "ZQBjAGgAbwA=", valueTokenIndex: 2 },
    },
    {
      name: "option value before slash encoded-command alias",
      argv: ["pwsh", "-WorkingDir", "/tmp/project", "/ec", "ZQBjAGgAbwA="],
      expected: { command: "ZQBjAGgAbwA=", valueTokenIndex: 4 },
    },
    {
      name: "input format value before encoded command",
      argv: ["pwsh", "-if", "XML", "-EncodedCommand", "ZQBjAGgAbwA="],
      expected: { command: "ZQBjAGgAbwA=", valueTokenIndex: 4 },
    },
    {
      name: "configuration value before encoded-command alias",
      argv: ["pwsh", "-config", "SomeConfig", "-ec", "ZQBjAGgAbwA="],
      expected: { command: "ZQBjAGgAbwA=", valueTokenIndex: 4 },
    },
    {
      name: "window style value before slash encoded-command alias",
      argv: ["pwsh", "-win", "hidden", "/ec", "ZQBjAGgAbwA="],
      expected: { command: "ZQBjAGgAbwA=", valueTokenIndex: 4 },
    },
    {
      name: "error action alias value before command",
      argv: ["pwsh", "-ea", "stop", "-Command", "Get-Date"],
      expected: { command: "Get-Date", valueTokenIndex: 4 },
    },
    {
      name: "slash error action alias value before command",
      argv: ["pwsh", "/ea", "stop", "-Command", "Get-Date"],
      expected: { command: "Get-Date", valueTokenIndex: 4 },
    },
    {
      name: "execution policy alias value before slash command",
      argv: ["pwsh", "/ep", "Bypass", "/c", "Get-Date"],
      expected: { command: "Get-Date", valueTokenIndex: 4 },
    },
    {
      name: "custom pipe name value before encoded-command alias",
      argv: ["pwsh", "-cus", "pipe-name", "-ec", "ZQBjAGgAbwA="],
      expected: { command: "ZQBjAGgAbwA=", valueTokenIndex: 4 },
    },
    {
      name: "token value before command",
      argv: ["pwsh", "-to", "token-value", "-Command", "Get-Date"],
      expected: { command: "Get-Date", valueTokenIndex: 4 },
    },
    {
      name: "utc timestamp value before command",
      argv: ["pwsh", "-utc", "1234", "-Command", "Get-Date"],
      expected: { command: "Get-Date", valueTokenIndex: 4 },
    },
    {
      name: "encoded arguments value before command",
      argv: ["pwsh", "-encodeda", "YQByAGcA", "-Command", "Get-Date"],
      expected: { command: "Get-Date", valueTokenIndex: 4 },
    },
    {
      name: "file script arguments",
      argv: ["pwsh", "-File", "script.ps1", "-ExtraArg"],
      expected: { command: "script.ps1", valueTokenIndex: 2 },
    },
    {
      name: "stops at the first positional argument",
      argv: ["pwsh", "script.ps1", "/ec", "ZQBjAGgAbwA="],
      expected: { command: null, valueTokenIndex: null },
    },
    {
      name: "does not treat an option value as an encoded-command flag",
      argv: ["pwsh", "-WorkingDir", "/ec", "ZQBjAGgAbwA="],
      expected: { command: null, valueTokenIndex: null },
    },
  ])("$name", ({ argv, expected }) => {
    expect(resolvePowerShellInlineCommandMatch(argv)).toEqual(expected);
  });
});
