import { describe, expect, it } from "vitest";
import setupEntry from "./setup-entry.js";

describe("qa-channel setup entry", () => {
  it("loads the bundled setup plugin through the setup-entry contract", () => {
    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");

    const setupPlugin = setupEntry.loadSetupPlugin();
    expect(setupPlugin.id).toBe("qa-channel");
    expect(setupPlugin.capabilities.chatTypes).toEqual(["direct", "group"]);
  });
});
