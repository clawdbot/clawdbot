import { describe, expect, it } from "vitest";
import setupEntry from "./setup-entry.js";

describe("discord setup entry", () => {
  it("exposes legacy state migration detector through setup entry metadata", () => {
    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");
    expect(setupEntry.features).toEqual({ legacyStateMigrations: true });
    expect(setupEntry.loadLegacyStateMigrationDetector?.()).toBeTypeOf("function");
  });
});
