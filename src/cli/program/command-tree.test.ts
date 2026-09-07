// Command tree tests cover CLI command hierarchy construction and lookup.
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { removeCommandByName } from "./command-tree.js";

describe("command-tree", () => {
  it("removes by command name", () => {
    const program = new Command();
    program.command("alpha");
    program.command("beta");

    expect(removeCommandByName(program, "alpha")).toBe(true);
    expect(program.commands.map((command) => command.name())).toEqual(["beta"]);
  });

  it("removes by command alias", () => {
    const program = new Command();
    program.command("alpha").alias("a");
    program.command("beta");

    expect(removeCommandByName(program, "a")).toBe(true);
    expect(program.commands.map((command) => command.name())).toEqual(["beta"]);
  });

  it("returns false when name does not exist", () => {
    const program = new Command();
    program.command("alpha");

    expect(removeCommandByName(program, "missing")).toBe(false);
    expect(program.commands.map((command) => command.name())).toEqual(["alpha"]);
  });
});
