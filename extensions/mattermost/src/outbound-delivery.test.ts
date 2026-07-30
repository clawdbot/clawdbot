// Mattermost tests cover the shared outbound delivery path.
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  addTestHook,
  createEmptyPluginRegistry,
  createTestRegistry,
  initializeGlobalHookRunner,
  releasePinnedPluginChannelRegistry,
  resetGlobalHookRunner,
  setActivePluginRegistry,
  type PluginHookRegistration,
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
    sendMessageMattermostMock.mockImplementation(async (_to, text, options) => {
      const result = {
        messageId: "post-1",
        channelId: "CHAN1",
        content: text,
      };
      await options?.onDeliveryResult?.(result);
      return result;
    });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "mattermost", plugin: mattermostPlugin, source: "test" }]),
    );
    resetGlobalHookRunner();
  });

  afterEach(() => {
    resetGlobalHookRunner();
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

  it("applies a message rewrite exactly once before the provider post", async () => {
    const hookRegistry = createEmptyPluginRegistry();
    const handler = vi.fn().mockResolvedValue({ content: "rewritten once" });
    addTestHook({
      registry: hookRegistry,
      pluginId: "rewrite-policy",
      hookName: "message_sending",
      handler: handler as PluginHookRegistration["handler"],
    });
    initializeGlobalHookRunner(hookRegistry);

    await sendDurableMessageBatch({
      cfg: {},
      channel: "mattermost",
      to: "channel:CHAN1",
      payloads: [{ text: "original" }],
      accountId: "default",
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(sendMessageMattermostMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMattermostMock).toHaveBeenCalledWith(
      "channel:CHAN1",
      "rewritten once",
      expect.objectContaining({
        accountId: "default",
        onDeliveryResult: expect.any(Function),
      }),
    );
  });

  it("does not create a provider post when the shared hook cancels", async () => {
    const hookRegistry = createEmptyPluginRegistry();
    const handler = vi.fn().mockResolvedValue({ cancel: true });
    addTestHook({
      registry: hookRegistry,
      pluginId: "cancel-policy",
      hookName: "message_sending",
      handler: handler as PluginHookRegistration["handler"],
    });
    initializeGlobalHookRunner(hookRegistry);

    const result = await sendDurableMessageBatch({
      cfg: {},
      channel: "mattermost",
      to: "channel:CHAN1",
      payloads: [{ text: "do not send" }],
      accountId: "default",
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(sendMessageMattermostMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "suppressed", results: [] });
  });
});
