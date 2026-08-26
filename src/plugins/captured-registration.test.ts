// Covers captured plugin registration behavior in test registries.
import { describe, expect, it, vi } from "vitest";
import { capturePluginRegistration } from "./captured-registration.js";
import type { AnyAgentTool, OpenClawPluginApi } from "./types.js";

describe("captured plugin registration", () => {
  it("preserves root machine-output metadata", () => {
    const machineOutput = ({ stdoutIsTTY }: { stdoutIsTTY: boolean }) => !stdoutIsTTY;
    const captured = capturePluginRegistration({
      register(api) {
        api.registerCli(() => {}, {
          commands: [" captured-machine ", "captured-machine", "captured-extra"],
          descriptors: [
            {
              name: "captured-machine",
              description: "Captured machine output",
              hasSubcommands: true,
              machineOutput,
            },
          ],
        });
      },
    });

    expect(captured.cliRegistrars[0]?.commands).toEqual(["captured-machine", "captured-extra"]);
    const descriptor = captured.cliRegistrars[0]?.descriptors[0];
    expect(descriptor?.machineOutput).toBe(machineOutput);
    expect(
      descriptor?.machineOutput?.({
        argv: ["node", "openclaw", "captured-machine"],
        stdoutIsTTY: false,
      }),
    ).toBe(true);
  });

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
        api.registerWorkerProvider({
          id: "captured-worker",
          provision: async () => ({
            leaseId: "captured-lease",
            ssh: {
              host: "worker.example",
              port: 22,
              user: "worker",
              hostKey: ["ssh-ed25519", "AAAA"].join(" "),
              keyRef: { source: "env", provider: "default", id: "WORKER_SSH_KEY" },
            },
          }),
          inspect: async () => ({ status: "active" }),
          destroy: async () => {},
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
        api.registerSessionCatalog({
          id: "captured-catalog",
          label: "Captured Catalog",
          list: async () => [],
          read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
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
    expect(captured.workerProviders.map((provider) => provider.id)).toEqual(["captured-worker"]);
    expect(captured.modelCatalogProviders.map((provider) => provider.provider)).toEqual([
      "captured-provider",
    ]);
    expect(captured.sessionCatalogs.map((provider) => provider.id)).toEqual(["captured-catalog"]);
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
  });

  it("enforces captured middleware runtime and tool scopes", async () => {
    const handler = vi.fn(() => undefined);
    const captured = capturePluginRegistration({
      register(api) {
        api.registerAgentToolResultMiddleware(handler, {
          runtimes: ["codex"],
          matcher: ["exec"],
        });
      },
    });
    const registration = captured.agentToolResultMiddlewares[0];
    expect(registration).toBeDefined();
    if (!registration) {
      return;
    }
    const event = {
      toolCallId: "call-1",
      args: {},
      result: { content: [{ type: "text" as const, text: "ok" }], details: {} },
    };

    await registration.handler({ ...event, toolName: "web_search" }, { runtime: "codex" });
    await registration.handler({ ...event, toolName: "exec" }, { runtime: "openclaw" });
    await registration.handler({ ...event, toolName: "exec" }, { runtime: "codex" });

    expect(handler).toHaveBeenCalledOnce();
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
