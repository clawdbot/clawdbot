// Mattermost tests cover the shared outbound delivery path.
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createTestRegistry,
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageMattermostMock = vi.hoisted(() => vi.fn());

vi.mock("./mattermost/send.js", () => ({
  sendMessageMattermost: sendMessageMattermostMock,
}));

import { mattermostPlugin } from "./channel.js";

describe("Mattermost outbound delivery", () => {
  beforeEach(() => {
    sendMessageMattermostMock.mockReset();
    sendMessageMattermostMock.mockResolvedValue({
      messageId: "post-1",
      channelId: "channel-1",
    });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "mattermost", plugin: mattermostPlugin, source: "test" }]),
    );
  });

  afterEach(() => {
    releasePinnedPluginChannelRegistry();
  });

  it.each([
    {
      name: "internal tool traces",
      text: "Done.\n⚠️ 🛠️ `search repos (agent)` failed",
      expected: "Done.",
    },
    {
      name: "ordinary assistant prose",
      text: "The pipeline has 3 open deals.",
      expected: "The pipeline has 3 open deals.",
    },
  ])("sends sanitized $name through the channel handler", async ({ text, expected }) => {
    await sendDurableMessageBatch({
      cfg: {},
      channel: "mattermost",
      to: "channel:team-1",
      payloads: [{ text }],
      skipQueue: true,
    });

    expect(sendMessageMattermostMock).toHaveBeenCalledWith(
      "channel:team-1",
      expected,
      expect.objectContaining({ cfg: {} }),
    );
  });
});
