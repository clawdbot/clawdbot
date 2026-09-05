// Discord tests cover setup entry plugin behavior.
import { describe, expect, it } from "vitest";
import setupEntry from "./setup-entry.js";

describe("discord setup entry", () => {
  it("keeps legacy state migrations on the doctor contract", () => {
    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");
    expect(setupEntry.features).toBeUndefined();
    expect(setupEntry.loadLegacyStateMigrationDetector).toBeUndefined();
  });
});
