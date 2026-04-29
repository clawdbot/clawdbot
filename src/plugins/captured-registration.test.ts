import { describe, expect, it } from "vitest";
import { capturePluginRegistration } from "./captured-registration.js";
import type { AnyAgentTool } from "./types.js";

describe("captured plugin registration", () => {
  it("keeps a complete plugin API surface available while capturing supported capabilities", () => {
    const capturedTool = {
      name: "captured-tool",
      description: "Captured tool",
      parameters: {},
      execute: async () => ({ content: [], details: {} }),
    } as unknown as AnyAgentTool;
    const captured = capturePluginRegistration({
      register(api) {
        api.registerTool(capturedTool);
        api.registerProvider({
          id: "captured-provider",
          label: "Captured Provider",
          auth: [],
        });
        api.registerVideoGenerationProvider({
          id: "captured-video",
          label: "Captured Video",
          defaultModel: "captured-video-model",
          capabilities: {
            generate: { maxVideos: 1 },
          },
          generateVideo: async () => ({
            provider: "captured-video",
            model: "captured-video-model",
            videos: [],
          }),
        });
        api.registerMusicGenerationProvider({
          id: "captured-music",
          label: "Captured Music",
          defaultModel: "captured-music-model",
          capabilities: {
            generate: { maxTracks: 1 },
          },
          generateMusic: async () => ({
            tracks: [],
          }),
        });
        api.registerTextTransforms({
          input: [{ from: /red basket/g, to: "blue basket" }],
          output: [{ from: /blue basket/g, to: "red basket" }],
        });
        api.registerChannel({
          plugin: {
            id: "captured-channel",
            meta: {
              id: "captured-channel",
              label: "Captured Channel",
              selectionLabel: "Captured Channel",
              docsPath: "/channels/captured-channel",
              blurb: "captured channel",
            },
            capabilities: { chatTypes: ["direct"] },
            config: {
              listAccountIds: () => [],
              resolveAccount: () => ({ accountId: "default" }),
            },
            outbound: { deliveryMode: "direct" },
          },
        });
        api.registerHook("message_received", () => {});
        api.registerCommand({
          name: "captured-command",
          description: "Captured command",
          handler: async () => ({ text: "ok" }),
        });
        api.registerAgentToolResultMiddleware(() => undefined, {
          runtimes: ["codex"],
        });
      },
    });

    expect(captured.tools.map((tool) => tool.name)).toEqual(["captured-tool"]);
    expect(captured.providers.map((provider) => provider.id)).toEqual(["captured-provider"]);
    expect(captured.videoGenerationProviders.map((provider) => provider.id)).toEqual([
      "captured-video",
    ]);
    expect(captured.musicGenerationProviders.map((provider) => provider.id)).toEqual([
      "captured-music",
    ]);
    expect(captured.textTransforms).toHaveLength(1);
    expect(captured.textTransforms[0]?.input).toHaveLength(1);
    expect(captured.agentToolResultMiddlewares).toHaveLength(1);
    expect(captured.agentToolResultMiddlewares[0]?.runtimes).toEqual(["codex"]);
    expect(captured.api.registerMemoryEmbeddingProvider).toBeTypeOf("function");
  });
});
