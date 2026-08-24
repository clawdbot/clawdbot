import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { VoiceCallStateRuntime } from "./runtime-state.js";
import { createVoiceCallRuntime, type VoiceCallRuntime } from "./runtime.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";
import { connectWs, startUpgradeWsServer, waitForClose } from "./websocket-test-support.js";

const mocks = vi.hoisted(() => ({
  resolveConfiguredRealtimeVoiceProvider: vi.fn(),
}));

vi.mock("./realtime-voice.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./realtime-voice.runtime.js")>();
  return {
    ...actual,
    resolveConfiguredRealtimeVoiceProvider: mocks.resolveConfiguredRealtimeVoiceProvider,
  };
});

function createStateRuntime(): VoiceCallStateRuntime["state"] {
  return {
    resolveStateDir: () => "",
    openKeyedStore: (() => {
      throw new Error("openKeyedStore is not used by realtime routing tests");
    }) as VoiceCallStateRuntime["state"]["openKeyedStore"],
    openSyncKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("voice-call", options),
    openChannelIngressQueue: (() => {
      throw new Error("openChannelIngressQueue is not used by realtime routing tests");
    }) as VoiceCallStateRuntime["state"]["openChannelIngressQueue"],
    openChannelIngressDrain: (() => {
      throw new Error("openChannelIngressDrain is not used by realtime routing tests");
    }) as VoiceCallStateRuntime["state"]["openChannelIngressDrain"],
  };
}

function createRealtimeProvider(params: {
  id: string;
  connect: ReturnType<typeof vi.fn<() => Promise<void>>>;
  requests?: RealtimeVoiceBridgeCreateRequest[];
}): RealtimeVoiceProviderPlugin {
  return {
    id: params.id,
    label: params.id,
    isConfigured: () => true,
    createBridge: vi.fn((request): RealtimeVoiceBridge => {
      params.requests?.push(request);
      return {
        connect: params.connect,
        sendAudio: vi.fn(),
        setMediaTimestamp: vi.fn(),
        submitToolResult: vi.fn(),
        acknowledgeMark: vi.fn(),
        close: vi.fn(),
        isConnected: () => true,
        triggerGreeting: vi.fn(),
      };
    }),
  };
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  mocks.resolveConfiguredRealtimeVoiceProvider.mockReset();
  resetPluginStateStoreForTests();
});

describe("voice-call realtime route ownership", () => {
  it("selects provider readiness and bridge auth from each inbound number owner", async () => {
    const storePath = tempDirs.make("openclaw-voice-routing-");
    const sockets: WebSocket[] = [];
    const servers: Array<Awaited<ReturnType<typeof startUpgradeWsServer>>> = [];
    let runtime: VoiceCallRuntime | undefined;
    const salesConnect = vi.fn(async () => {});
    const supportConnect = vi.fn(async () => {});
    const salesRequests: RealtimeVoiceBridgeCreateRequest[] = [];
    const salesProvider = createRealtimeProvider({
      id: "openai",
      connect: salesConnect,
      requests: salesRequests,
    });
    const supportProvider = createRealtimeProvider({ id: "xai", connect: supportConnect });
    const registrations = new Map([
      [
        "sales",
        {
          provider: salesProvider,
          providerConfig: { credentialOwner: "sales", model: "gpt-realtime" },
        },
      ],
      [
        "support",
        {
          provider: supportProvider,
          providerConfig: { credentialOwner: "support", model: "grok-voice" },
        },
      ],
    ]);
    mocks.resolveConfiguredRealtimeVoiceProvider.mockImplementation(
      ({ agentId }: { agentId?: string }) => {
        const registration = agentId ? registrations.get(agentId) : undefined;
        if (!registration) {
          throw new Error(`No simulated realtime credentials for ${agentId ?? "unknown"}`);
        }
        return registration;
      },
    );

    try {
      const config = createVoiceCallBaseConfig();
      config.agentId = "main";
      config.store = storePath;
      config.inboundPolicy = "open";
      config.maxConcurrentCalls = 2;
      config.staleCallReaperSeconds = 0;
      config.serve = { ...config.serve, port: 0 };
      config.realtime.enabled = true;
      config.numbers = {
        "+15550001001": { agentId: "sales" },
        "+15550001002": { agentId: "support" },
      };
      const fullConfig = {
        agents: {
          list: [{ id: "main", default: true }, { id: "sales" }, { id: "support" }],
        },
      } as OpenClawConfig;

      runtime = await createVoiceCallRuntime({
        config,
        coreConfig: fullConfig,
        fullConfig,
        agentRuntime: {} as never,
        stateRuntime: createStateRuntime(),
      });
      expect(mocks.resolveConfiguredRealtimeVoiceProvider).not.toHaveBeenCalled();

      const handler = runtime.webhookServer.getRealtimeHandler();
      if (!handler) {
        throw new Error("expected realtime handler");
      }
      const routes = [
        { to: "+15550001001", callSid: "CA-sales", streamSid: "MZ-sales" },
        { to: "+15550001002", callSid: "CA-support", streamSid: "MZ-support" },
      ];
      for (const route of routes) {
        const { streamUrl } = handler.issueStreamSession({
          providerName: "twilio",
          direction: "inbound",
          from: "+15550009999",
          to: route.to,
        });
        const server = await startUpgradeWsServer({
          urlPath: new URL(streamUrl).pathname,
          onUpgrade: (request, socket, head) => {
            handler.handleWebSocketUpgrade(request, socket, head);
          },
        });
        servers.push(server);
        const ws = await connectWs(server.url);
        sockets.push(ws);
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: route.streamSid, callSid: route.callSid },
          }),
        );
      }

      await vi.waitFor(() => {
        expect(salesProvider.createBridge).toHaveBeenCalledTimes(1);
        expect(supportProvider.createBridge).toHaveBeenCalledTimes(1);
        expect(salesConnect).toHaveBeenCalledTimes(1);
        expect(supportConnect).toHaveBeenCalledTimes(1);
      });
      expect(salesProvider.createBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "sales",
          providerConfig: { credentialOwner: "sales", model: "gpt-realtime" },
        }),
      );
      expect(supportProvider.createBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "support",
          providerConfig: { credentialOwner: "support", model: "grok-voice" },
        }),
      );
      expect(
        mocks.resolveConfiguredRealtimeVoiceProvider.mock.calls.map(
          ([options]) => (options as { agentId?: string }).agentId,
        ),
      ).toEqual(["sales", "support"]);

      const hangupCall = vi.spyOn(runtime.provider, "hangupCall");
      salesRequests[0]?.onClose?.("completed");
      for (const ws of sockets) {
        const closed = waitForClose(ws);
        ws.close(1000);
        await closed;
      }
      await vi.waitFor(() => expect(runtime?.manager.getActiveCalls()).toHaveLength(0), {
        timeout: 3_000,
      });
      expect(hangupCall).toHaveBeenCalledTimes(2);
      expect(hangupCall).toHaveBeenCalledWith(
        expect.objectContaining({ providerCallId: "CA-sales", reason: "hangup-bot" }),
      );
      expect(hangupCall).toHaveBeenCalledWith(
        expect.objectContaining({ providerCallId: "CA-support", reason: "hangup-bot" }),
      );
      await expect(runtime.manager.getCallHistory()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            endReason: "hangup-bot",
            providerCallId: "CA-sales",
            state: "hangup-bot",
          }),
          expect.objectContaining({
            endReason: "hangup-bot",
            providerCallId: "CA-support",
            state: "hangup-bot",
          }),
        ]),
      );
    } finally {
      await runtime?.stop();
      for (const ws of sockets) {
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.terminate();
        }
      }
      await Promise.all(servers.map((server) => server.close()));
      resetPluginStateStoreForTests();
    }
  });
});
