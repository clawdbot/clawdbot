// Thread-binding lightweight artifact contract for bundled channel plugins.
//
// Core resolves default thread placement from lightweight `thread-binding-api`
// artifacts before full plugin loading (src/channels/plugins/thread-binding-api.ts).
// This shard owns artifact inventory and placement shape; loaded-plugin parity
// lives in plugin-shape.contract.test.ts.
import { beforeAll, describe, expect, it } from "vitest";
import {
  getBundledChannelThreadBindingArtifactAsync,
  listBundledChannelPluginIds,
} from "./test-helpers/bundled-channel-plugin-loader.js";

// Bundled channels expected to ship a top-level thread-binding artifact.
const THREAD_BINDING_ARTIFACT_PLUGIN_IDS = ["discord", "matrix"] as const;

describe("bundled channel thread-binding artifact parity", () => {
  const artifactPlacements = new Map<string, unknown>();

  beforeAll(async () => {
    for (const id of listBundledChannelPluginIds()) {
      const artifact = await getBundledChannelThreadBindingArtifactAsync(id);
      if (artifact) {
        artifactPlacements.set(id, artifact.defaultTopLevelPlacement);
      }
    }
  });

  it("keeps the artifact table in sync with bundled channels that ship one", () => {
    expect([...artifactPlacements.keys()].toSorted()).toEqual([
      ...THREAD_BINDING_ARTIFACT_PLUGIN_IDS,
    ]);
    for (const id of THREAD_BINDING_ARTIFACT_PLUGIN_IDS) {
      expect(["current", "child"]).toContain(artifactPlacements.get(id));
    }
  });
});
