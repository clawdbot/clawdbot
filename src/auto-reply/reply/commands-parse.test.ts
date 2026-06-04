// Tests command parser normalization, aliases, and argument extraction.
import { describe, expect, it } from "vitest";
import { parseConfigCommand } from "./config-commands.js";
import { parseDebugCommand } from "./debug-commands.js";

describe("config/debug command parsing", () => {
  it("parses config/debug command actions and JSON payloads", () => {
    const cases: Array<{
      parse: (input: string) => unknown;
      input: string;
      expected: unknown;
    }> = [
      { parse: parseConfigCommand, input: "/config", expected: { action: "show" } },
      {
        parse: parseConfigCommand,
        input: "/config show",
        expected: { action: "show", path: undefined },
      },
      {
        parse: parseConfigCommand,
        input: "/config show foo.bar",
        expected: { action: "show", path: "foo.bar" },
      },
      {
        parse: parseConfigCommand,
        input: "/config get foo.bar",
        expected: { action: "show", path: "foo.bar" },
      },
      {
        parse: parseConfigCommand,
        input: "/config unset foo.bar",
        expected: { action: "unset", path: "foo.bar" },
      },
      {
        parse: parseConfigCommand,
        input: '/config set foo={"a":1}',
        expected: { action: "set", path: "foo", value: { a: 1 } },
      },
      { parse: parseDebugCommand, input: "/debug", expected: { action: "show" } },
      { parse: parseDebugCommand, input: "/debug show", expected: { action: "show" } },
      { parse: parseDebugCommand, input: "/debug reset", expected: { action: "reset" } },
      {
        parse: parseDebugCommand,
        input: "/debug unset foo.bar",
        expected: { action: "unset", path: "foo.bar" },
      },
      {
        parse: parseDebugCommand,
        input: '/debug set foo={"a":1}',
        expected: { action: "set", path: "foo", value: { a: 1 } },
      },
    ];

    for (const testCase of cases) {
      expect(testCase.parse(testCase.input)).toEqual(testCase.expected);
    }
  });
});
