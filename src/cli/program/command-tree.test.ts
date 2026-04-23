import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { removeCommand, removeCommandByName } from "./command-tree.js";

describe("command-tree", () => {
  it("removes a command instance when present", () => {
    const program = new Command();
    const alpha = program.command("alpha");
    program.command("beta");

    expect(removeCommand(program, alpha)).toBe(true);
    expect(program.commands.map((command) => command.name())).toEqual(["beta"]);
  });

  it("returns false when command instance is already absent", () => {
    const program = new Command();
    program.command("alpha");
    const detached = new Command("beta");

    expect(removeCommand(program, detached)).toBe(false);
  });

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
