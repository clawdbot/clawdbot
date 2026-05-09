import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  collectOption,
  parsePositiveIntOrUndefined,
  resolveActionArgs,
  resolveCommandOptionArgs,
} from "./helpers.js";

describe("program helpers", () => {
  it("collectOption appends values in order", () => {
    expect(collectOption("a")).toEqual(["a"]);
    expect(collectOption("b", ["a"])).toEqual(["a", "b"]);
  });

  it.each([
    { value: undefined, expected: undefined },
    { value: null, expected: undefined },
    { value: "", expected: undefined },
    { value: 5, expected: 5 },
    { value: 5.9, expected: 5 },
    { value: 0, expected: undefined },
    { value: -1, expected: undefined },
    { value: Number.NaN, expected: undefined },
    { value: "10", expected: 10 },
    { value: "10ms", expected: 10 },
    { value: "0", expected: undefined },
    { value: "nope", expected: undefined },
    { value: true, expected: undefined },
  ])("parsePositiveIntOrUndefined(%j)", ({ value, expected }) => {
    expect(parsePositiveIntOrUndefined(value)).toBe(expected);
  });

  it("resolveActionArgs returns args when command has arg array", () => {
    const command = new Command();
    (command as Command & { args?: string[] }).args = ["one", "two"];
    expect(resolveActionArgs(command)).toEqual(["one", "two"]);
  });

  it("resolveActionArgs returns empty array for missing/invalid args", () => {
    const command = new Command();
    (command as unknown as { args?: unknown }).args = "not-an-array";
    expect(resolveActionArgs(command)).toStrictEqual([]);
    expect(resolveActionArgs(undefined)).toStrictEqual([]);
  });

  it("resolveCommandOptionArgs serializes explicit options", () => {
    const command = new Command()
      .option("--json", "JSON output", false)
      .option("--timeout <ms>", "Timeout", "30000")
      .option("--tag <name>", "Tag", collectOption)
      .option("--no-progress", "Disable progress");

    command.parse([
      "node",
      "test",
      "--json",
      "--timeout",
      "10",
      "--tag",
      "a",
      "--tag",
      "b",
      "--no-progress",
    ]);

    expect(resolveCommandOptionArgs(command)).toEqual([
      "--json",
      "--timeout",
      "10",
      "--tag",
      "a",
      "--tag",
      "b",
      "--no-progress",
    ]);
  });

  it("resolveCommandOptionArgs skips defaults", () => {
    const command = new Command()
      .option("--json", "JSON output", false)
      .option("--timeout <ms>", "Timeout", "30000");

    command.parse(["node", "test"]);

    expect(resolveCommandOptionArgs(command)).toStrictEqual([]);
  });
});
