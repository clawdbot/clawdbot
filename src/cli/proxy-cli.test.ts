import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerProxyCli } from "./proxy-cli.js";

describe("proxy cli", () => {
  function createProgram() {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => undefined,
      writeOut: () => undefined,
    });
    registerProxyCli(program);
    return program;
  }

  it("registers the debug proxy subcommands", () => {
    const program = new Command();
    registerProxyCli(program);

    const proxy = program.commands.find((command) => command.name() === "proxy");
    expect(proxy?.commands.map((command) => command.name())).toEqual([
      "start",
      "run",
      "validate",
      "coverage",
      "sessions",
      "query",
      "blob",
      "purge",
    ]);

    const validate = proxy?.commands.find((command) => command.name() === "validate");
    expect(validate?.description()).toBe("Validate the operator-managed network proxy");
    expect(validate?.options.map((option) => option.long)).toEqual([
      "--json",
      "--proxy-url",
      "--proxy-ca-file",
      "--allowed-url",
      "--denied-url",
      "--apns-reachable",
      "--apns-authority",
      "--timeout-ms",
    ]);
  });

  it.each([
    [["proxy", "sessions", "--limit", "abc"], /--limit must be an integer/],
    [["proxy", "sessions", "--limit", "0"], /--limit must be a positive integer/],
    [["proxy", "validate", "--timeout-ms", "1.5"], /--timeout-ms must be an integer/],
    [["proxy", "validate", "--timeout-ms", "0"], /--timeout-ms must be a positive integer/],
    [["proxy", "start", "--port", "abc"], /--port must be an integer/],
    [["proxy", "run", "--port", "65536"], /--port must be between 0 and 65535/],
  ])("rejects invalid numeric option %s", (args, expected) => {
    const program = createProgram();

    expect(() => program.parse(["node", "openclaw", ...args])).toThrow(expected);
  });
});
