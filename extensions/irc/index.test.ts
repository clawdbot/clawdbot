import { assertBundledChannelEntries } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe } from "vitest";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";

describe("irc bundled entries", () => {
  assertBundledChannelEntries({
    entry,
    expectedId: "irc",
    expectedName: "IRC",
    setupEntry,
  });
});
