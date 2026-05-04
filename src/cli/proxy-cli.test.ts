import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerProxyCli } from "./proxy-cli.js";

describe("proxy cli", () => {
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
      "--allowed-url",
      "--denied-url",
      "--apns-reachable",
      "--apns-authority",
      "--timeout-ms",
    ]);
  });
});
