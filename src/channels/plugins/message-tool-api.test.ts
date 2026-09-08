// Message tool API tests cover channel message tool descriptors and runtime calls.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock } = vi.hoisted(() => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock: vi.fn(
    ({
      artifactCandidates,
      dirName,
    }: {
      artifactCandidates: readonly string[];
      dirName: string;
    }) => {
      const artifactBasename = artifactCandidates[0];
      if (dirName === "slack" && artifactBasename === "message-tool-api.js") {
        return {
          describeMessageTool: () => ({
            actions: ["send", "upload-file"],
            capabilities: ["presentation"],
            schema: null,
          }),
        };
      }
      if (dirName === "empty" && artifactBasename === "message-tool-api.js") {
        return {};
      }
      if (dirName === "broken" && artifactBasename === "message-tool-api.js") {
        throw new Error("broken message tool artifact");
      }
      return null;
    },
  ),
}));

vi.mock("../../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync:
    loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock,
}));

import { resolveBundledChannelMessageToolDiscoveryAdapter } from "./message-tool-api.js";

describe("bundled channel message tool fast path", () => {
  beforeEach(() => {
    loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock.mockClear();
  });

  it("loads message tool discovery from the narrow artifact", () => {
    const adapter = resolveBundledChannelMessageToolDiscoveryAdapter(" slack ");
    expect(adapter?.describeMessageTool?.({ cfg: {} })).toStrictEqual({
      actions: ["send", "upload-file"],
      capabilities: ["presentation"],
      schema: null,
    });
    expect(loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock).toHaveBeenCalledWith({
      dirName: "slack",
      artifactCandidates: ["message-tool-api.js"],
    });
  });

  it("treats missing artifacts as absent discovery", () => {
    expect(resolveBundledChannelMessageToolDiscoveryAdapter("discord")).toBeUndefined();
  });

  it("ignores present artifacts without discovery", () => {
    expect(resolveBundledChannelMessageToolDiscoveryAdapter("empty")).toBeUndefined();
  });

  it("surfaces errors from present message tool artifacts", () => {
    expect(() => resolveBundledChannelMessageToolDiscoveryAdapter("broken")).toThrow(
      "broken message tool artifact",
    );
  });
});
