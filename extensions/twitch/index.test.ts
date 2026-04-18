import { describe } from "vitest";
import { assertBundledChannelEntries } from "../../test/helpers/bundled-channel-entry.ts";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";

describe("twitch bundled entries", () => {
  assertBundledChannelEntries({
    entry,
    expectedId: "twitch",
    expectedName: "Twitch",
    setupEntry,
  });
});
