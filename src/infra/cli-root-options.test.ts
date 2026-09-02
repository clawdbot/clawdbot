// Covers root CLI option token parsing.
import { describe, expect, it } from "vitest";
import { consumeRootOptionToken, isValueToken } from "./cli-root-options.js";

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
