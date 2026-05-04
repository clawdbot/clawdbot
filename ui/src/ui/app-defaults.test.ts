import { describe, expect, it } from "vitest";
import { DEFAULT_SESSIONS_FILTERS } from "./app-defaults.ts";

describe("app defaults", () => {
  it("defaults session list requests to a broader but bounded result set", () => {
    expect(DEFAULT_SESSIONS_FILTERS).toEqual({
      activeMinutes: "120",
      limit: "200",
    });
  });
});
