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
    const encoded = args.map(quoteCmdScriptArg).join(" ");
    expect(parseCmdScriptCommandLine(encoded)).toEqual(args);
  });

  it("rejects CR/LF in command arguments", () => {
    expect(() => quoteCmdScriptArg("bad\narg")).toThrow(/Command argument cannot contain CR or LF/);
    expect(() => quoteCmdScriptArg("bad\rarg")).toThrow(/Command argument cannot contain CR or LF/);
  });
});
