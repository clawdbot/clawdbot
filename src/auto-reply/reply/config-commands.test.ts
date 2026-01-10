import { describe, expect, it } from "vitest";

import { parseConfigCommand } from "./config-commands.js";

describe("parseConfigCommand", () => {
  it("parses show/unset", () => {
    expect(parseConfigCommand("/config")).toEqual({ action: "show" });
    expect(parseConfigCommand("/config show")).toEqual({
      action: "show",
      path: undefined,
    });
    expect(parseConfigCommand("/config show foo.bar")).toEqual({
      action: "show",
      path: "foo.bar",
    });
    expect(parseConfigCommand("/config get foo.bar")).toEqual({
      action: "show",
      path: "foo.bar",
    });
    expect(parseConfigCommand("/config unset foo.bar")).toEqual({
      action: "unset",
      path: "foo.bar",
    });
  });

  it("parses set with JSON", () => {
    const cmd = parseConfigCommand('/config set foo={"a":1}');
    expect(cmd).toEqual({ action: "set", path: "foo", value: { a: 1 } });
  });
});
