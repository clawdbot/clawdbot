import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadBundledPluginPublicArtifactModuleSyncMock } = vi.hoisted(() => ({
  loadBundledPluginPublicArtifactModuleSyncMock: vi.fn(
    ({ artifactBasename, dirName }: { artifactBasename: string; dirName: string }) => {
      if (dirName === "matrix" && artifactBasename === "thread-binding-api.js") {
        return {
          defaultTopLevelPlacement: "child",
          resolveInboundConversation: () => ({
            conversationId: " $thread ",
            parentConversationId: " !room:example ",
          }),
        };
      }
      if (dirName === "invalid" && artifactBasename === "thread-binding-api.js") {
        return {
          defaultTopLevelPlacement: "floating",
        };
      }
      if (dirName === "empty" && artifactBasename === "thread-binding-api.js") {
        return {};
      }
      if (dirName === "broken" && artifactBasename === "thread-binding-api.js") {
        throw new Error("broken thread binding artifact");
      }
      throw new Error(
        `Unable to resolve bundled plugin public surface ${dirName}/${artifactBasename}`,
      );
    },
  ),
}));

vi.mock("../../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleSync: loadBundledPluginPublicArtifactModuleSyncMock,
}));

import {
  __testing,
  resolveBundledChannelThreadBindingDefaultPlacement,
  resolveBundledChannelThreadBindingInboundConversation,
} from "./thread-binding-api.js";

describe("bundled channel thread binding fast path", () => {
  beforeEach(() => {
    __testing.clearThreadBindingApiCache();
    loadBundledPluginPublicArtifactModuleSyncMock.mockClear();
  });

  it("loads default placement from the narrow thread binding artifact", () => {
    expect(resolveBundledChannelThreadBindingDefaultPlacement("matrix")).toBe("child");
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "matrix",
      artifactBasename: "thread-binding-api.js",
    });
  });

  it("loads inbound conversation resolution from the narrow artifact", () => {
    expect(
      resolveBundledChannelThreadBindingInboundConversation({
        channelId: "matrix",
        to: "room:!room:example",
        threadId: "$thread",
        isGroup: true,
      }),
    ).toEqual({
      conversationId: " $thread ",
      parentConversationId: " !room:example ",
    });
  });

  it("treats missing artifacts as absent hints", () => {
    expect(resolveBundledChannelThreadBindingDefaultPlacement("discord")).toBeUndefined();
    expect(
      resolveBundledChannelThreadBindingInboundConversation({
        channelId: "discord",
        to: "channel:general",
        isGroup: true,
      }),
    ).toBeUndefined();
  });

  it("ignores invalid placement values", () => {
    expect(resolveBundledChannelThreadBindingDefaultPlacement("invalid")).toBeUndefined();
  });

  it("distinguishes a present artifact without an inbound resolver from a missing artifact", () => {
    expect(
      resolveBundledChannelThreadBindingInboundConversation({
        channelId: "empty",
        to: "channel:general",
        isGroup: true,
      }),
    ).toBeUndefined();
  });

  it("surfaces errors from present thread binding artifacts", () => {
    expect(() => resolveBundledChannelThreadBindingDefaultPlacement("broken")).toThrow(
      "broken thread binding artifact",
    );
  });
});
