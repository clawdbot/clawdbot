// Proxy CLI tests cover proxy command registration and option parsing.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerProxyCli } from "./proxy-cli.js";

const { runDebugProxySessionsCommand, runDebugProxyStartCommand, runProxyValidateCommand } =
  vi.hoisted(() => ({
    runDebugProxySessionsCommand: vi.fn(),
    runDebugProxyStartCommand: vi.fn(),
    runProxyValidateCommand: vi.fn(),
  }));

vi.mock("./proxy-cli.runtime.js", () => ({
  runDebugProxyCoverageCommand: vi.fn(),
  runDebugProxyPurgeCommand: vi.fn(),
  runDebugProxyQueryCommand: vi.fn(),
  runDebugProxyRunCommand: vi.fn(),
  runDebugProxySessionsCommand,
  runDebugProxyStartCommand,
  runProxyValidateCommand,
  readDebugProxyBlobCommand: vi.fn(),
}));

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

  beforeEach(() => {
    runDebugProxySessionsCommand.mockReset();
    runDebugProxyStartCommand.mockReset();
    runProxyValidateCommand.mockReset();
  });

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
    [["proxy", "start", "--port", "-1"], /--port must be between 0 and 65535/],
    [["proxy", "run", "--port", "65536"], /--port must be between 0 and 65535/],
  ])("rejects invalid numeric option %s", (args, expected) => {
    const program = createProgram();

    expect(() => program.parse(["node", "openclaw", ...args])).toThrow(expected);
  });

  it("normalizes signed decimal numeric options through the shared parser", async () => {
    const program = createProgram();

    await program.parseAsync(["node", "openclaw", "proxy", "start", "--port", "+08080"]);
    await program.parseAsync(["node", "openclaw", "proxy", "validate", "--timeout-ms", "+01000"]);
    await program.parseAsync(["node", "openclaw", "proxy", "sessions", "--limit", "+05"]);

    expect(runDebugProxyStartCommand).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 8080,
    });
    expect(runProxyValidateCommand).toHaveBeenCalledWith({
      allowedUrls: undefined,
      apnsAuthority: undefined,
      apnsReachability: undefined,
      deniedUrls: undefined,
      json: undefined,
      proxyCaFile: undefined,
      proxyUrl: undefined,
      timeoutMs: 1000,
    });
    expect(runDebugProxySessionsCommand).toHaveBeenCalledWith({ limit: 5 });
  });
});
