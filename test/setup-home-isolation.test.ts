import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConfigIO } from "../src/config/config.js";

describe("shared test setup home isolation", () => {
  it("routes default config IO through the per-worker temp home", () => {
    const testHome = process.env.OPENCLAW_TEST_HOME;
    if (!testHome) {
      throw new Error("OPENCLAW_TEST_HOME must be set by the test setup");
    }
    expect(process.env.HOME).toBe(testHome);
    expect(process.env.USERPROFILE).toBe(testHome);
    expect(createConfigIO().configPath).toBe(path.join(testHome, ".openclaw", "openclaw.json"));
  });
});
