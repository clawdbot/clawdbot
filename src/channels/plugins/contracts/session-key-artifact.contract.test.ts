// Session-key lightweight artifact contract for bundled channel plugins.
//
// Core resolves threaded session conversations from lightweight `session-key-api`
// artifacts before full plugin loading (src/channels/plugins/session-conversation.ts).
// This shard owns artifact inventory and export shape; loaded-plugin identity and
// adapter behavior parity live in plugin-shape.contract.test.ts.
//
// Artifact exports are intentionally non-uniform: telegram/feishu ship the
// `resolveSessionConversation` hook core probes, while discord ships only its
// explicit session-key normalizer. Pin what each channel ships instead of
// forcing one shape.
import { beforeAll, describe, expect, it } from "vitest";
import {
  getBundledChannelSessionKeyArtifactAsync,
  listBundledChannelPluginIds,
} from "./test-helpers/bundled-channel-plugin-loader.js";

// Bundled channels expected to ship a top-level session-key artifact.
const SESSION_KEY_ARTIFACT_PLUGIN_IDS = ["discord", "feishu", "telegram"] as const;
const SESSION_CONVERSATION_ARTIFACT_PLUGIN_IDS = ["feishu", "telegram"] as const;

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
    for (const id of SESSION_CONVERSATION_ARTIFACT_PLUGIN_IDS) {
      expect(typeof artifacts.get(id)?.resolveSessionConversation).toBe("function");
    }
    expect(typeof artifacts.get("discord")?.normalizeExplicitDiscordSessionKey).toBe("function");
  });
});
