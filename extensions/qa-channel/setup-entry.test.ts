import { beforeAll, describe, expect, it } from "vitest";
import setupEntry from "./setup-entry.js";

describe("qa-channel setup entry", () => {
  let setupPlugin: ReturnType<typeof setupEntry.loadSetupPlugin>;

  beforeAll(() => {
    setupPlugin = setupEntry.loadSetupPlugin();
  });

  it("loads the bundled setup plugin through the setup-entry contract", () => {
    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");

    expect(setupPlugin.id).toBe("qa-channel");
    expect(setupPlugin.capabilities.chatTypes).toEqual(["direct", "group"]);
  });
});
