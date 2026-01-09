import { describe, expect, it } from "vitest";

import { parseDebugCommand } from "./debug-commands.js";

describe("parseDebugCommand", () => {
  it("parses show/reset", () => {
    expect(parseDebugCommand("/debug")).toEqual({ action: "show" });
    expect(parseDebugCommand("/debug show")).toEqual({ action: "show" });
    expect(parseDebugCommand("/debug reset")).toEqual({ action: "reset" });
  });

  it("parses set with JSON", () => {
    const cmd = parseDebugCommand('/debug set foo={"a":1}');
    expect(cmd).toEqual({ action: "set", path: "foo", value: { a: 1 } });
  });

  it("parses unset", () => {
    const cmd = parseDebugCommand("/debug unset foo.bar");
    expect(cmd).toEqual({ action: "unset", path: "foo.bar" });
  });
});
