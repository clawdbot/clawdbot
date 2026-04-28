import { assertBundledChannelEntries } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe } from "vitest";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";

describe("slack bundled entries", () => {
  assertBundledChannelEntries({
    entry,
    expectedId: "slack",
    expectedName: "Slack",
    setupEntry,
  });
});
