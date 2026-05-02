import { describe, expect, it } from "vitest";
import setupEntry from "./setup-entry.js";

describe("qa-channel setup entry", () => {
  it("exposes the bundled setup-entry contract", () => {
    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");
    expect(typeof setupEntry.loadSetupPlugin).toBe("function");
  });
});
