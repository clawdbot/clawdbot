// Message-tool lightweight artifact contract for bundled channel plugins.
//
// Core discovers message-tool schemas from lightweight `message-tool-api`
// artifacts without loading full channel plugins
// (src/channels/plugins/message-tool-api.ts). This shard owns artifact inventory
// and export shape; loaded-plugin parity lives in plugin-shape.contract.test.ts.
import { beforeAll, describe, expect, it } from "vitest";
import {
  getBundledChannelMessageToolArtifactAsync,
  listBundledChannelPluginIds,
} from "./test-helpers/bundled-channel-plugin-loader.js";

// Bundled channels expected to ship a top-level message-tool artifact.
const MESSAGE_TOOL_ARTIFACT_PLUGIN_IDS = ["imessage", "slack"] as const;

describe("bundled channel message-tool artifact parity", () => {
  const artifactDescribers = new Map<string, unknown>();

  beforeAll(async () => {
    for (const id of listBundledChannelPluginIds()) {
      const artifact = await getBundledChannelMessageToolArtifactAsync(id);
      if (artifact) {
        artifactDescribers.set(id, artifact.describeMessageTool);
      }
    }
  });

  it("keeps the artifact table in sync with bundled channels that ship one", () => {
    expect([...artifactDescribers.keys()].toSorted()).toEqual([
      ...MESSAGE_TOOL_ARTIFACT_PLUGIN_IDS,
    ]);
    for (const id of MESSAGE_TOOL_ARTIFACT_PLUGIN_IDS) {
      expect(typeof artifactDescribers.get(id)).toBe("function");
    }
  });
});
