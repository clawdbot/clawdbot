import { describe, expect, it } from "vitest";
import { capturePluginRegistration } from "./captured-registration.js";
import type { AnyAgentTool, OpenClawPluginApi } from "./types.js";

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
        api.registerModelCatalogProvider({
          provider: "captured-provider",
          kinds: ["text"],
          staticCatalog: () => [
            {
              kind: "text",
              provider: "captured-provider",
              model: "captured-model",
              source: "static",
            },
          ],
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
    expect(captured.modelCatalogProviders.map((provider) => provider.provider)).toEqual([
      "captured-provider",
    ]);
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

  it("returns synthetic scheduled-turn ids independent of human-readable names", async () => {
    let scheduleSessionTurn: OpenClawPluginApi["scheduleSessionTurn"] | undefined;
    let registerSessionSchedulerJob: OpenClawPluginApi["registerSessionSchedulerJob"] | undefined;
    const captured = capturePluginRegistration({
      id: "captured-custom-plugin",
      name: "Captured Custom Plugin",
      register(api) {
        registerSessionSchedulerJob = api.session.workflow.registerSessionSchedulerJob;
        scheduleSessionTurn = api.session.workflow.scheduleSessionTurn;
      },
    });

    expect(
      registerSessionSchedulerJob?.({
        id: "captured-job",
        sessionKey: "agent:main:main",
        kind: "session-turn",
      }),
    ).toEqual({
      id: "captured-job",
      pluginId: "captured-custom-plugin",
      sessionKey: "agent:main:main",
      kind: "session-turn",
    });
    await expect(
      scheduleSessionTurn?.({
        sessionKey: "agent:main:main",
        message: "wake",
        delayMs: 1_000,
        name: "human-readable-name",
      }),
    ).resolves.toEqual({
      id: "captured-session-turn-1",
      pluginId: "captured-custom-plugin",
      sessionKey: "agent:main:main",
      kind: "session-turn",
    });
    expect(captured.sessionSchedulerJobs).toEqual([
      {
        id: "captured-job",
        sessionKey: "agent:main:main",
        kind: "session-turn",
      },
    ]);
  });
});
