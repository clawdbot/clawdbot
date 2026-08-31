// Voice Call tests cover utils plugin behavior.
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveUserPath } from "./utils.js";

describe("resolveUserPath", () => {
  it("returns trimmed empty input unchanged", () => {
    expect(resolveUserPath("   ")).toBe("");
  });

  it("expands tildes and resolves relative paths", () => {
    expect(resolveUserPath("~/voice-call/config.json")).toBe(
      path.resolve(os.homedir(), "voice-call/config.json"),
    );
    expect(resolveUserPath("./voice-call")).toBe(path.resolve("./voice-call"));
  });

  it("does not interpret $ patterns in home when expanding tildes", () => {
    const spy = vi.spyOn(os, "homedir").mockReturnValue("/home/$&user");
    try {
      expect(resolveUserPath("~/voice-call/config.json")).toBe(
        path.resolve("/home/$&user/voice-call/config.json"),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
