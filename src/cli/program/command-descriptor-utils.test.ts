// Command descriptor utility tests cover CLI descriptor helpers and Commander integration.
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  addCommandDescriptorsToProgram,
  collectUniqueCommandDescriptors,
  defineCommandDescriptorCatalog,
} from "./command-descriptor-utils.js";

describe("command-descriptor-utils", () => {
  const descriptors = [
    { name: "alpha", description: "Alpha", hasSubcommands: false },
    { name: "beta", description: "Beta", hasSubcommands: true },
    { name: "gamma", description: "Gamma", hasSubcommands: true, parentDefaultHelp: true },
  ] as const;

  it("collects unique descriptors across groups in order", () => {
    expect(
      collectUniqueCommandDescriptors([
        [
          { name: "alpha", description: "Alpha" },
          { name: "beta", description: "Beta" },
        ],
        [
          { name: "beta", description: "Ignored duplicate" },
          { name: "gamma", description: "Gamma" },
        ],
      ]),
    ).toEqual([
      { name: "alpha", description: "Alpha" },
      { name: "beta", description: "Beta" },
      { name: "gamma", description: "Gamma" },
    ]);
  });

  it("defines a reusable descriptor catalog", () => {
    const catalog = defineCommandDescriptorCatalog(descriptors);

    expect(catalog.descriptors).toBe(descriptors);
    expect(catalog.getDescriptors()).toBe(descriptors);
    expect(catalog.getNames()).toEqual(["alpha", "beta", "gamma"]);
    expect(catalog.getCommandsWithSubcommands()).toEqual(["beta", "gamma"]);
    expect(catalog.getParentDefaultHelpCommands()).toEqual(["gamma"]);
  });

  it("adds descriptors without duplicating existing commands", () => {
    const program = new Command();
    const existingCommands = addCommandDescriptorsToProgram(program, descriptors);

    addCommandDescriptorsToProgram(
      program,
      [
        { name: "beta", description: "Ignored duplicate" },
        { name: "delta", description: "Delta" },
      ],
      existingCommands,
    );

    expect(program.commands.map((command) => command.name())).toEqual([
      "alpha",
      "beta",
      "gamma",
      "delta",
    ]);
  });

  it("strips terminal escapes from rendered descriptor descriptions", () => {
    const program = new Command();

    addCommandDescriptorsToProgram(program, [
      {
        name: "safe-command",
        description: "Open \u001B]8;;https://example.test\u0007link\u001B]8;;\u0007 now\u001B[2J",
      },
    ]);

    expect(program.commands[0]?.description()).toBe("Open link now");
  });

  it("keeps hidden descriptors out of help", () => {
    const program = new Command();
    addCommandDescriptorsToProgram(program, [
      { name: "visible", description: "Visible" },
      { name: "retired", description: "Retired", hidden: true },
    ]);

    expect(program.commands.map((command) => command.name())).toContain("retired");
    expect(program.helpInformation()).toContain("visible");
    expect(program.helpInformation()).not.toContain("retired");
  });

  it("rejects unsafe descriptor command names before rendering", () => {
    const program = new Command();

    expect(() =>
      addCommandDescriptorsToProgram(program, [{ name: "bad\nname", description: "Bad" }]),
    ).toThrow('Invalid CLI command name: "bad\\nname"');
    expect(program.commands).toStrictEqual([]);
  });
});
