// Daemon command argv tests cover command argument construction.
import { describe, expect, it } from "vitest";
import { parseCmdScriptCommandLine, quoteCmdScriptArg } from "./cmd-argv.js";

describe("cmd argv helpers", () => {
  it.each([
    "plain",
    "with space",
    "safe&whoami",
    "safe|whoami",
    "safe<in",
    "safe>out",
    "safe^caret",
    "%TEMP%",
    "!token!",
    'he said "hi"',
    "C:\\Program Files\\OpenClaw\\",
    "\\\\server\\share\\folder\\",
    'C:\\temp\\file with "quotes"\\',
  ])("round-trips single arg: %p", (arg) => {
    const encoded = quoteCmdScriptArg(arg);
    expect(parseCmdScriptCommandLine(encoded)).toEqual([arg]);
  });

  it("round-trips mixed command lines", () => {
    const args = [
      "node",
      "gateway.js",
      "--display-name",
      "safe&whoami",
      "--percent",
      "%TEMP%",
      "--bang",
      "!token!",
      "--quoted",
      'he said "hi"',
    ];
    const encoded = args.map((arg) => quoteCmdScriptArg(arg)).join(" ");
    expect(parseCmdScriptCommandLine(encoded)).toEqual(args);
  });

  it("does not let a trailing backslash escape the closing quote", () => {
    const workingDirectory = "C:\\Program Files\\OpenClaw\\";
    const encoded = quoteCmdScriptArg(workingDirectory);
    // CommandLineToArgvW / cmd treat an odd run of backslashes before " as
    // escaping that quote. The wrapper must emit an even run so the closer
    // stays a closer. This assertion is portable; it fails on macOS too.
    expect(encoded.endsWith('\\\\"')).toBe(true);
    expect(encoded).toBe('"C:\\Program Files\\OpenClaw\\\\"');
    expect(parseCmdScriptCommandLine(encoded)).toEqual([workingDirectory]);
  });

  it("rejects CR/LF in command arguments", () => {
    expect(() => quoteCmdScriptArg("bad\narg")).toThrow(/Command argument cannot contain CR or LF/);
    expect(() => quoteCmdScriptArg("bad\rarg")).toThrow(/Command argument cannot contain CR or LF/);
  });
});
