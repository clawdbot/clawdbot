import { describe, expect, it } from "vitest";
import {
  POSIX_INLINE_COMMAND_FLAGS,
  POWERSHELL_INLINE_COMMAND_FLAGS,
  resolveInlineCommandMatch,
} from "./shell-inline-command.js";

describe("resolveInlineCommandMatch", () => {
  it.each([
    {
      name: "extracts the next token for bash -lc",
      argv: ["bash", "-lc", "echo hi"],
      flags: POSIX_INLINE_COMMAND_FLAGS,
      expected: { command: "echo hi", valueTokenIndex: 2 },
    },
    {
      name: "extracts the next token for PowerShell -Command",
      argv: ["pwsh", "-Command", "Get-ChildItem"],
      flags: POWERSHELL_INLINE_COMMAND_FLAGS,
      expected: { command: "Get-ChildItem", valueTokenIndex: 2 },
    },
    {
      name: "extracts the next token for PowerShell -File",
      argv: ["pwsh", "-File", "script.ps1"],
      flags: POWERSHELL_INLINE_COMMAND_FLAGS,
      expected: { command: "script.ps1", valueTokenIndex: 2 },
    },
    {
      name: "extracts the next token for PowerShell -f",
      argv: ["powershell", "-f", "script.ps1"],
      flags: POWERSHELL_INLINE_COMMAND_FLAGS,
      expected: { command: "script.ps1", valueTokenIndex: 2 },
    },
    {
      name: "supports combined -c forms when enabled",
      argv: ["sh", "-cecho hi"],
      flags: POSIX_INLINE_COMMAND_FLAGS,
      opts: { allowCombinedC: true },
      expected: { command: "echo hi", valueTokenIndex: 1 },
    },
    {
      name: "keeps post-c no-argument shell flags separate from the command",
      argv: ["bash", "-cx", "echo hi"],
      flags: POSIX_INLINE_COMMAND_FLAGS,
      opts: { allowCombinedC: true },
      expected: { command: "echo hi", valueTokenIndex: 2 },
    },
    {
      name: "keeps post-c stdin shell flags separate from the command",
      argv: ["bash", "-cs", "echo hi"],
      flags: POSIX_INLINE_COMMAND_FLAGS,
      opts: { allowCombinedC: true },
      expected: { command: "echo hi", valueTokenIndex: 2 },
    },
    {
      name: "rejects combined -c forms when disabled",
      argv: ["sh", "-cecho hi"],
      flags: POSIX_INLINE_COMMAND_FLAGS,
      opts: { allowCombinedC: false },
      expected: { command: null, valueTokenIndex: null },
    },
    {
      name: "returns a value index for blank command tokens",
      argv: ["bash", "-lc", "   "],
      flags: POSIX_INLINE_COMMAND_FLAGS,
      expected: { command: null, valueTokenIndex: 2 },
    },
    {
      name: "returns null value index when the flag has no following token",
      argv: ["bash", "-lc"],
      flags: POSIX_INLINE_COMMAND_FLAGS,
      expected: { command: null, valueTokenIndex: null },
    },
  ])("$name", ({ argv, flags, opts, expected }) => {
    expect(resolveInlineCommandMatch(argv, flags, opts)).toEqual(expected);
  });

  it("stops parsing after --", () => {
    expect(
      resolveInlineCommandMatch(["bash", "--", "-lc", "echo hi"], POSIX_INLINE_COMMAND_FLAGS),
    ).toEqual({
      command: null,
      valueTokenIndex: null,
    });
  });
});
