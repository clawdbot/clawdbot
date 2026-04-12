import { beforeEach, describe, vi } from "vitest";
import { assertBundledChannelEntries } from "../../test/helpers/bundled-channel-entry.ts";
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
