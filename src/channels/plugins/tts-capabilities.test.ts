import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { resolveChannelTtsVoiceDelivery } from "./tts-capabilities.js";
import type { ChannelPlugin } from "./types.js";

function createChannelPlugin(
  id: string,
  capabilities: ChannelPlugin["capabilities"],
): ChannelPlugin {
  return createChannelTestPluginBase({
    id,
    label: id,
    capabilities,
    config: {
      listAccountIds: () => ["default"],
    },
  });
}

describe("resolveChannelTtsVoiceDelivery", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("reads voice delivery behavior from channel plugin capabilities", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "bluebubbles",
          plugin: createChannelPlugin("bluebubbles", {
            chatTypes: ["direct"],
            tts: {
              voice: {
                synthesisTarget: "audio-file",
                audioFileFormats: ["mp3", "caf", "audio/mpeg", "audio/x-caf"],
              },
            },
          }),
          source: "test",
        },
        {
          pluginId: "discord",
          plugin: createChannelPlugin("discord", {
            chatTypes: ["direct"],
            tts: { voice: { synthesisTarget: "voice-note" } },
          }),
          source: "test",
        },
        {
          pluginId: "feishu",
          plugin: createChannelPlugin("feishu", {
            chatTypes: ["direct"],
            tts: { voice: { synthesisTarget: "voice-note", transcodesAudio: true } },
          }),
          source: "test",
        },
        {
          pluginId: "matrix",
          plugin: createChannelPlugin("matrix", {
            chatTypes: ["direct"],
            tts: { voice: { synthesisTarget: "voice-note" } },
          }),
          source: "test",
        },
        {
          pluginId: "telegram",
          plugin: createChannelPlugin("telegram", {
            chatTypes: ["direct"],
            tts: { voice: { synthesisTarget: "voice-note" } },
          }),
          source: "test",
        },
        {
          pluginId: "whatsapp",
          plugin: createChannelPlugin("whatsapp", {
            chatTypes: ["direct"],
            tts: { voice: { synthesisTarget: "voice-note", transcodesAudio: true } },
          }),
          source: "test",
        },
      ]),
    );
    expect(resolveChannelTtsVoiceDelivery("bluebubbles")).toEqual({
      synthesisTarget: "audio-file",
      audioFileFormats: ["mp3", "caf", "audio/mpeg", "audio/x-caf"],
    });
    expect(resolveChannelTtsVoiceDelivery("discord")).toEqual({
      synthesisTarget: "voice-note",
    });
    expect(resolveChannelTtsVoiceDelivery("feishu")).toEqual({
      synthesisTarget: "voice-note",
      transcodesAudio: true,
    });
    expect(resolveChannelTtsVoiceDelivery("matrix")).toEqual({
      synthesisTarget: "voice-note",
    });
    expect(resolveChannelTtsVoiceDelivery("telegram")).toEqual({
      synthesisTarget: "voice-note",
    });
    expect(resolveChannelTtsVoiceDelivery("whatsapp")).toEqual({
      synthesisTarget: "voice-note",
      transcodesAudio: true,
    });
    expect(resolveChannelTtsVoiceDelivery("slack")).toBeUndefined();
  });
});
