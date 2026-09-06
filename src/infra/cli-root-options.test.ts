// Covers root CLI option token parsing.
import { describe, expect, it } from "vitest";
import {
  consumeRootOptionToken,
  getCommandArgsWithRootOptions,
  getCommandPositionalsWithRootOptions,
  getRootOptionAwareCommandPath,
  isValueToken,
} from "./cli-root-options.js";

function expectValueTokenCases(
  cases: ReadonlyArray<{ value: string | undefined; expected: boolean }>,
): void {
  for (const { value, expected } of cases) {
    expect(isValueToken(value)).toBe(expected);
  }
}

describe("isValueToken", () => {
  it("classifies value-like and flag-like tokens", () => {
    expectValueTokenCases([
      { value: "work", expected: true },
      { value: "-1", expected: true },
      { value: "-1.5", expected: true },
      { value: "-0.5", expected: true },
      { value: "--", expected: false },
      { value: "--dev", expected: false },
      { value: "-", expected: false },
      { value: "", expected: false },
      { value: undefined, expected: false },
    ]);
  });
});

describe("consumeRootOptionToken", () => {
  it.each([
    { args: ["--dev"], index: 0, expected: 1 },
    { args: ["--profile=work"], index: 0, expected: 1 },
    { args: ["--log-level=debug"], index: 0, expected: 1 },
    { args: ["--container=openclaw-demo"], index: 0, expected: 1 },
    { args: ["--profile", "work"], index: 0, expected: 2 },
    { args: ["--container", "openclaw-demo"], index: 0, expected: 2 },
    { args: ["--profile", "-1"], index: 0, expected: 2 },
    { args: ["--log-level", "-1.5"], index: 0, expected: 2 },
    { args: ["--profile", "--no-color"], index: 0, expected: 1 },
    { args: ["--profile", "--"], index: 0, expected: 1 },
    { args: ["x", "--profile", "work"], index: 1, expected: 2 },
    { args: ["--log-level", ""], index: 0, expected: 1 },
    { args: ["--unknown"], index: 0, expected: 0 },
    { args: [], index: 0, expected: 0 },
  ])("consumes %j at %d", ({ args, index, expected }) => {
    expect(consumeRootOptionToken(args, index)).toBe(expected);
  });
});

describe("literal command discovery", () => {
  it.each(["route", "command-path"] as const)(
    "requires the root command before command options in %s mode",
    (mode) => {
      const options = { commandPath: ["models"], booleanFlags: ["--json"], mode };
      expect(
        getCommandPositionalsWithRootOptions(
          ["node", "openclaw", "--json", "models", "status"],
          options,
        ),
      ).toBeNull();
      for (const args of [
        ["models", "--json", "status"],
        ["--profile", "models", "models", "--json", "status"],
      ]) {
        expect(
          getCommandPositionalsWithRootOptions(["node", "openclaw", ...args], options),
        ).toEqual(["status"]);
      }
    },
  );

  it.each([
    { args: ["--", "config", "get"], expected: ["config", "get"] },
    { args: ["--profile", "work", "--", "config", "get"], expected: ["config", "get"] },
    { args: ["--profile", "--", "config", "get"], expected: ["config", "get"] },
    { args: ["--", "--help"], expected: ["--help"] },
    { args: ["--", "config", "--help"], expected: ["config", "--help"] },
    { args: ["--", "config", "unknown"], expected: ["config", "unknown"] },
    { args: ["--"], expected: [] },
    { args: ["status", "--", "ignored"], expected: ["status"] },
  ])("discovers $args without promoting literal flags", ({ args, expected }) => {
    expect(getRootOptionAwareCommandPath(["node", "openclaw", ...args], 2)).toEqual(expected);
  });

  it.each([
    ["--", "channels", "add", "--channel", "example"],
    ["channels", "--", "add", "--channel", "example"],
    ["channels", "add", "--", "--channel", "example"],
  ])("retains the literal boundary in a delegated argument tail: %j", (...args) => {
    expect(
      getCommandArgsWithRootOptions(["node", "openclaw", ...args], {
        commandPath: ["channels", "add"],
        mode: "command-path",
      }),
    ).toEqual(["--", "--channel", "example"]);
  });

  it("keeps literal root invocations out of conservative fast routes", () => {
    expect(
      getCommandPositionalsWithRootOptions(["node", "openclaw", "--", "config", "get"], {
        commandPath: ["config", "get"],
      }),
    ).toBeNull();
  });
});
