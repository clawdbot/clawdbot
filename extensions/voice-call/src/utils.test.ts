import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
});
