// Message-tool artifact parity contract for bundled channel plugins.
//
// Core discovers message-tool schemas from lightweight `message-tool-api`
// artifacts without loading full channel plugins
// (src/channels/plugins/message-tool-api.ts). This suite pins each artifact
// export to the exact function the loaded plugin's action surface uses so
// discovery cannot drift from runtime behavior.
import { beforeAll, describe, expect, it } from "vitest";
import {
  getBundledChannelMessageToolArtifactAsync,
  getBundledChannelPluginAsync,
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
  });

  it.each(MESSAGE_TOOL_ARTIFACT_PLUGIN_IDS)(
    "keeps the %s artifact describer identical to the plugin action surface",
    async (id) => {
      const describeMessageTool = artifactDescribers.get(id);
      expect(typeof describeMessageTool).toBe("function");

      const plugin = await getBundledChannelPluginAsync(id);
      expect(plugin?.actions?.describeMessageTool).toBe(describeMessageTool);
    },
  );
});
