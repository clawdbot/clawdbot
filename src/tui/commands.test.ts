import { describe, expect, it } from "vitest";

import { getSlashCommands, parseCommand } from "./commands.js";

describe("tui slash commands", () => {
  it("treats /elev as an alias for /elevated", () => {
    expect(parseCommand("/elev on")).toEqual({ name: "elevated", args: "on" });
  });

  it("normalizes alias case", () => {
    expect(parseCommand("/ELEV off")).toEqual({
      name: "elevated",
      args: "off",
    });
  });

  it("includes gateway text commands", () => {
    const commands = getSlashCommands({});
    expect(commands.some((command) => command.name === "context")).toBe(true);
    expect(commands.some((command) => command.name === "commands")).toBe(true);
  });

  it("offers reasoning stream mode", () => {
    const commands = getSlashCommands({});
    const reasoning = commands.find((command) => command.name === "reasoning");
    expect(reasoning).toBeTruthy();
    expect(reasoning?.getArgumentCompletions?.("")).toEqual(
      expect.arrayContaining([{ value: "stream", label: "stream" }]),
    );
  });
});
