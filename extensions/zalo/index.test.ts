import { assertBundledChannelEntries } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe } from "vitest";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";

describe("zalo bundled entries", () => {
  assertBundledChannelEntries({
    entry,
    expectedId: "zalo",
    expectedName: "Zalo",
    setupEntry,
    channelMessage: "declares the channel plugin without a runtime-barrel cycle",
    setupMessage: "declares the setup plugin without a runtime-barrel cycle",
  });
});
