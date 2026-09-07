import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAIRealtimeSelectedBridge } from "./realtime-ga-selected-bridge.js";
import { openAIRealtimeHost } from "./realtime-host.js";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider-factory.js";
import type { OpenAIRealtimeVoiceBridgeConfig } from "./realtime-voice-session-policy.js";
const mocks = vi.hoisted(() => ({ createPeer: vi.fn() }));
vi.mock("./realtime-quicksilver-peer.runtime.js", () => ({
  OpenAIQuicksilverAudioPeer: { create: mocks.createPeer },
}));
const { FakeWebSocket } = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
vi.mock("ws", () => ({ default: FakeWebSocket }));

function setup(
  overrides: Partial<OpenAIRealtimeVoiceBridgeConfig> = {},
  throughProvider?: "gateway" | "backend",
) {
  const cfg: OpenAIRealtimeVoiceBridgeConfig = {
    providerConfig: {},
    model: "gpt-realtime-2.1",
    voice: "cedar",
    autoRespondToAudio: false,
    audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
    onError: vi.fn(),
    onReady: vi.fn(),
    onClose: vi.fn(),
    logger: { warn: vi.fn() },
    ...overrides,
  };
  const token = [
    "eyJhbGciOiJub25lIn0",
    Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "selected-account" } }),
    ).toString("base64url"),
    "fixture",
  ].join(".");
  const resolveProviderAuthProfileApiKey = vi.fn<
    typeof openAIRealtimeHost.resolveProviderAuthProfileApiKey
  >(async ({ profileTypes }) => (profileTypes?.includes("oauth") ? token : undefined));
  const host = {
    ...openAIRealtimeHost,
    isProviderAuthProfileConfigured: vi.fn(() => false),
    resolveProviderAuthProfileApiKey,
  };
  const peer = {
    createOffer: vi.fn(async () => "v=offer"),
    applyAnswer: vi.fn(),
    close: vi.fn(),
    isControlOpen: () => true,
    sendAudio: vi.fn(),
    sendControl: vi.fn(),
    discardInboundAudio: vi.fn(),
  };
  mocks.createPeer.mockImplementation(async (params) => {
    peer.applyAnswer.mockImplementation(async () => {
      params.gaDataChannel.onOpen();
      params.gaDataChannel.onMessage('{"type":"session.created"}');
    });
    return peer;
  });
  const fetchMock = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response("v=answer", {
        status: 201,
        headers: { Location: "/v1/realtime/calls/call_selected" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const bridge = throughProvider
    ? buildOpenAIRealtimeVoiceProvider(host).createBridge({
        ...cfg,
        providerConfig: {
          ...cfg.providerConfig,
          model: cfg.model,
          voice: cfg.voice,
          apiKey: cfg.apiKey,
          azureEndpoint: cfg.azureEndpoint,
          azureDeployment: cfg.azureDeployment,
          azureApiVersion: cfg.azureApiVersion,
        },
        ...(throughProvider === "gateway"
          ? { runAgentConsult: vi.fn(async () => ({ text: "owned agent response" })) }
          : {}),
      })
    : createOpenAIRealtimeSelectedBridge(cfg, host);
  return {
    cfg,
    host,
    token,
    peer,
    fetchMock,
    bridge,
  };
}
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
  mocks.createPeer.mockReset();
  FakeWebSocket.instances.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GA selected-auth factory", () => {
  it("routes a Gateway GA OAuth request through the real provider factory", async () => {
    const h = setup({}, "gateway");
    try {
      expect(h.host.resolveProviderAuthProfileApiKey).not.toHaveBeenCalled();
      await h.bridge.connect();
      expect(h.fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
        Authorization: "Bearer " + h.token,
        "chatgpt-account-id": "selected-account",
      });
      expect(h.fetchMock.mock.calls[0]?.[1]?.body).toContain('"model":"gpt-realtime-2.1"');
      expect(h.fetchMock.mock.calls[0]?.[1]?.body).toContain('"create_response":false');
      expect(FakeWebSocket.instances).toHaveLength(0);
      h.bridge.sendUserMessage?.("owned agent response", { mode: "readback" });
      expect(h.peer.sendControl).toHaveBeenCalledWith(
        expect.stringContaining('"conversation":"none"'),
      );
    } finally {
      h.bridge.close();
    }
  });

  it("keeps non-Gateway GA backend requests on their existing Platform path", async () => {
    const h = setup({}, "backend");
    try {
      await expect(h.bridge.connect()).rejects.toThrow("Platform");
      expect(mocks.createPeer).not.toHaveBeenCalled();
      expect(h.fetchMock).not.toHaveBeenCalled();
    } finally {
      h.bridge.close();
    }
  });
  it("selects once only on connect and carries OAuth model/account into the call", async () => {
    const h = setup();
    expect(h.host.resolveProviderAuthProfileApiKey).not.toHaveBeenCalled();
    await h.bridge.connect();
    expect(h.host.resolveProviderAuthProfileApiKey).toHaveBeenCalledTimes(2);
    expect(h.fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer " + h.token,
      "chatgpt-account-id": "selected-account",
    });
    expect(h.fetchMock.mock.calls[0]?.[1]?.body).toContain('"model":"gpt-realtime-2.1"');
    expect(FakeWebSocket.instances).toHaveLength(0);
    h.bridge.close();
  });
  it.each(["explicit", "profile", "azure"])(
    "preserves %s Platform/Azure routing when OAuth also exists",
    async (kind) => {
      const h = setup({
        ...(kind === "profile" ? {} : { apiKey: "platform-fixture" }),
        ...(kind === "azure"
          ? { azureEndpoint: "https://azure.example", azureDeployment: "deployment" }
          : {}),
      });
      if (kind === "profile") {
        h.host.resolveProviderAuthProfileApiKey.mockResolvedValue("platform-fixture");
      }
      const connect = h.bridge.connect();
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const socket = FakeWebSocket.instances[0]!;
      socket.readyState = FakeWebSocket.OPEN;
      socket.emit("open");
      socket.emit("message", Buffer.from('{"type":"session.updated"}'));
      await connect;
      expect(mocks.createPeer).not.toHaveBeenCalled();
      expect(h.fetchMock).not.toHaveBeenCalled();
      expect(
        h.host.resolveProviderAuthProfileApiKey.mock.calls.some(([arg]) =>
          arg.profileTypes?.includes("oauth"),
        ),
      ).toBe(false);
      expect(h.bridge.supportsReadback).toBe(kind !== "azure");
      h.bridge.close();
    },
  );
  it.each([
    { azureEndpoint: "https://azure.example" },
    { azureDeployment: "deployment" },
    { azureApiVersion: "2024-10-01-preview" },
  ])("preserves authored partial Azure route without selecting OAuth: %j", async (azure) => {
    const h = setup(azure);
    try {
      await expect(h.bridge.connect()).rejects.toThrow();
      expect(
        h.host.resolveProviderAuthProfileApiKey.mock.calls.some(([arg]) =>
          arg.profileTypes?.includes("oauth"),
        ),
      ).toBe(false);
      expect(mocks.createPeer).not.toHaveBeenCalled();
      expect(h.fetchMock).not.toHaveBeenCalled();
    } finally {
      h.bridge.close();
    }
  });

  it("keeps endpoint-only Azure GA on its configured WebSocket endpoint", async () => {
    const h = setup({ azureEndpoint: "https://azure.example", apiKey: "platform-fixture" });
    try {
      const connect = h.bridge.connect();
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const socket = FakeWebSocket.instances[0]!;
      expect(socket.args[0]).toBe("wss://azure.example/v1/realtime?model=gpt-realtime-2.1");
      socket.readyState = FakeWebSocket.OPEN;
      socket.emit("open");
      socket.emit("message", Buffer.from('{"type":"session.updated"}'));
      await connect;
      expect(h.bridge.supportsReadback).toBe(true);
      expect(h.host.resolveProviderAuthProfileApiKey).not.toHaveBeenCalled();
      expect(mocks.createPeer).not.toHaveBeenCalled();
    } finally {
      h.bridge.close();
    }
  });

  it("refuses unresolved authored Platform input instead of trying OAuth", async () => {
    const h = setup();
    h.host.isProviderAuthProfileConfigured.mockReturnValue(true);
    await expect(h.bridge.connect()).rejects.toThrow("Platform");
    expect(h.host.resolveProviderAuthProfileApiKey).toHaveBeenCalledTimes(1);
    expect(mocks.createPeer).not.toHaveBeenCalled();
  });
  it.each(["api_key", "oauth"] as const)(
    "retires during awaited %s auth and discards late selection",
    async (stage) => {
      const h = setup();
      let resolve!: (value: string) => void;
      const gate = new Promise<string>((done) => {
        resolve = done;
      });
      h.host.resolveProviderAuthProfileApiKey.mockImplementation(async ({ profileTypes }) =>
        profileTypes?.includes(stage) ? gate : undefined,
      );
      const connect = h.bridge.connect();
      await vi.waitFor(() =>
        expect(h.host.resolveProviderAuthProfileApiKey).toHaveBeenCalledTimes(
          stage === "oauth" ? 2 : 1,
        ),
      );
      h.bridge.close();
      await connect;
      resolve(h.token);
      await new Promise<void>((done) => {
        setImmediate(done);
      });
      expect(mocks.createPeer).not.toHaveBeenCalled();
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(h.fetchMock).not.toHaveBeenCalled();
    },
  );
  it("does not retry another auth/model/transport after OAuth call refusal", async () => {
    const h = setup();
    h.fetchMock.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await expect(h.bridge.connect()).rejects.toThrow("call creation failed (403)");
    await expect(h.bridge.connect()).rejects.toThrow("call creation failed (403)");
    expect(h.fetchMock).toHaveBeenCalledOnce();
    expect(h.host.resolveProviderAuthProfileApiKey).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(h.peer.close).toHaveBeenCalledOnce();
  });
});
