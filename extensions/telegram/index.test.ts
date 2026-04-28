import { assertBundledChannelEntries } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, vi } from "vitest";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";

describe("telegram bundled entries", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  assertBundledChannelEntries({
    entry,
    expectedId: "telegram",
    expectedName: "Telegram",
    setupEntry,
    channelMessage: "declares the channel entry without importing the broad api barrel",
  });
});
