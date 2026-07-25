// Session-key artifact parity contract for bundled channel plugins.
//
// Core resolves threaded session conversations from lightweight `session-key-api`
// artifacts before full plugin loading (src/channels/plugins/session-conversation.ts).
// This suite pins each artifact export to the exact function the loaded plugin's
// messaging surface uses so the fast path cannot drift from plugin behavior.
//
// Artifact exports are intentionally non-uniform: telegram/feishu ship the
// `resolveSessionConversation` hook core probes, while discord ships only its
// explicit session-key normalizer. Pin what each channel ships instead of
// forcing one shape.
import { beforeAll, describe, expect, it } from "vitest";
import {
  getBundledChannelPluginAsync,
  getBundledChannelSessionKeyArtifactAsync,
  listBundledChannelPluginIds,
} from "./test-helpers/bundled-channel-plugin-loader.js";

// Bundled channels expected to ship a top-level session-key artifact.
const SESSION_KEY_ARTIFACT_PLUGIN_IDS = ["discord", "feishu", "telegram"] as const;
const SESSION_CONVERSATION_ARTIFACT_PLUGIN_IDS = ["feishu", "telegram"] as const;

type ExplicitSessionKeyNormalizer = (
  sessionKey: string,
  ctx: { ChatType?: string; From?: string; SenderId?: string },
) => string;

describe("bundled channel session-key artifact parity", () => {
  const artifacts = new Map<string, Record<string, unknown>>();

  beforeAll(async () => {
    for (const id of listBundledChannelPluginIds()) {
      const artifact = await getBundledChannelSessionKeyArtifactAsync(id);
      if (artifact) {
        artifacts.set(id, artifact);
      }
    }
  });

  it("keeps the artifact table in sync with bundled channels that ship one", () => {
    expect([...artifacts.keys()].toSorted()).toEqual([...SESSION_KEY_ARTIFACT_PLUGIN_IDS]);
  });

  it.each(SESSION_CONVERSATION_ARTIFACT_PLUGIN_IDS)(
    "keeps the %s artifact resolver identical to the plugin messaging hook",
    async (id) => {
      const resolveSessionConversation = artifacts.get(id)?.resolveSessionConversation;
      expect(typeof resolveSessionConversation).toBe("function");

      const plugin = await getBundledChannelPluginAsync(id);
      expect(plugin?.messaging?.resolveSessionConversation).toBe(resolveSessionConversation);
    },
  );

  it("keeps the discord artifact normalizer behind the plugin messaging hook", async () => {
    const normalize = artifacts.get("discord")?.normalizeExplicitDiscordSessionKey as
      | ExplicitSessionKeyNormalizer
      | undefined;
    expect(typeof normalize).toBe("function");

    const plugin = await getBundledChannelPluginAsync("discord");
    const pluginNormalize = plugin?.messaging?.normalizeExplicitSessionKey;
    expect(typeof pluginNormalize).toBe("function");

    // The plugin hook adapts core's params-object shape onto the artifact's
    // positional export, so pin behavioral parity over representative keys.
    const cases = [
      { sessionKey: "discord:channel:123", ctx: { ChatType: "direct", SenderId: "123" } },
      { sessionKey: "discord:dm:42", ctx: { ChatType: "dm", From: "discord:42" } },
      { sessionKey: "agent:m:discord:channel:9", ctx: { ChatType: "direct", From: "discord:9" } },
      { sessionKey: "Discord:Channel:77", ctx: { ChatType: "group", SenderId: "77" } },
    ] as const;
    for (const { sessionKey, ctx } of cases) {
      expect(pluginNormalize?.({ sessionKey, ctx })).toBe(normalize?.(sessionKey, ctx));
    }
  });
});
