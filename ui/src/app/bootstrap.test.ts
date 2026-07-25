import { describe, expect, it } from "vitest";
import { normalizeInitialApplicationLocation } from "./bootstrap.ts";

describe("normalizeInitialApplicationLocation", () => {
  it("routes an opaque persisted key without aborting bootstrap", () => {
    expect(
      normalizeInitialApplicationLocation(
        { pathname: "/", search: "", hash: "" },
        "",
        "telegram:12345",
      ),
    ).toEqual({ pathname: "/chat/main/telegram/12345", search: "", hash: "" });
  });

  it("leaves the initial location unchanged when a malformed key has no path", () => {
    const location = { pathname: "/", search: "?draft=hello", hash: "" };
    expect(normalizeInitialApplicationLocation(location, "", "agent::broken")).toBe(location);
  });
});
