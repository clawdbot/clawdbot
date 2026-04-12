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
      "coverage",
      "sessions",
      "query",
      "blob",
      "purge",
    ]);
  });
});
