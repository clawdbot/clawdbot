import { beforeEach, describe, expect, it, vi } from "vitest";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());

vi.mock("./facade-loader.js", () => ({
  loadBundledPluginPublicSurfaceModuleSync,
}));

describe("plugin-sdk bluebubbles facade", () => {
  beforeEach(() => {
    vi.resetModules();
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
  });

  it("delegates conversation matching helpers to the plugin public facade", async () => {
    const normalized = { conversationId: "+15551234567" };
    const match = { conversationId: "+15551234567", matchPriority: 2 };
    const normalizeBlueBubblesAcpConversationId = vi.fn().mockReturnValue(normalized);
    const matchBlueBubblesAcpConversation = vi.fn().mockReturnValue(match);
    const resolveBlueBubblesConversationIdFromTarget = vi.fn().mockReturnValue("+15551234567");
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      normalizeBlueBubblesAcpConversationId,
      matchBlueBubblesAcpConversation,
      resolveBlueBubblesConversationIdFromTarget,
    });

    const bluebubbles = await import("./bluebubbles.js");

    expect(bluebubbles.normalizeBlueBubblesAcpConversationId("sms:+15551234567")).toBe(normalized);
    expect(
      bluebubbles.matchBlueBubblesAcpConversation({
        bindingConversationId: "+15551234567",
        conversationId: "sms:+15551234567",
      }),
    ).toBe(match);
    expect(bluebubbles.resolveBlueBubblesConversationIdFromTarget("sms:+15551234567")).toBe(
      "+15551234567",
    );
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "bluebubbles",
      artifactBasename: "api.js",
    });
    expect(normalizeBlueBubblesAcpConversationId).toHaveBeenCalledWith("sms:+15551234567");
    expect(matchBlueBubblesAcpConversation).toHaveBeenCalledWith({
      bindingConversationId: "+15551234567",
      conversationId: "sms:+15551234567",
    });
    expect(resolveBlueBubblesConversationIdFromTarget).toHaveBeenCalledWith("sms:+15551234567");
  });
});
