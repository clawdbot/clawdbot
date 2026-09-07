/**
 * Tests chat channel id normalization and matching helpers.
 */
import { describe, expect, it } from "vitest";
import { listBundledChannelCatalogEntries } from "../channels/bundled-channel-catalog-read.js";
import {
  BUNDLED_CHAT_CHANNEL_ENVELOPE_PREFIXES,
  BUNDLED_CHAT_CHANNEL_IDS,
} from "./chat-channel-ids.js";

describe("plugin-sdk chat-channel-ids", () => {
  it("covers every bundled and official channel catalog id", () => {
    const exported = new Set(BUNDLED_CHAT_CHANNEL_IDS);
    const missing = listBundledChannelCatalogEntries()
      .map((entry) => entry.id)
      .filter((id) => !exported.has(id));

    expect(missing).toEqual([]);
  });

  it("covers channel labels and aliases used by envelope formatters", () => {
    expect(BUNDLED_CHAT_CHANNEL_ENVELOPE_PREFIXES).toEqual(
      expect.arrayContaining([
        "googlechat",
        "Google Chat",
        "nextcloud-talk",
        "Nextcloud Talk",
        "msteams",
        "teams",
      ]),
    );
  });
});
