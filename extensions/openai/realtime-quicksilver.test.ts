// Openai tests cover GPT-Live (quicksilver) realtime voice gating.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isOpenAIGptLiveModel } from "./realtime-quicksilver.js";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mintSecretMock = vi.hoisted(() => vi.fn());

vi.mock("./realtime-provider-shared.js", async () => {
  const actual = await vi.importActual<typeof import("./realtime-provider-shared.js")>(
    "./realtime-provider-shared.js",
  );
  return {
    ...actual,
    createOpenAIRealtimeClientSecret: mintSecretMock,
  };
});

describe("openai gpt-live model detection", () => {
  it("matches the gpt-live model family", () => {
    expect(isOpenAIGptLiveModel("gpt-live-1")).toBe(true);
    expect(isOpenAIGptLiveModel("gpt-live-1-mini")).toBe(true);
    expect(isOpenAIGptLiveModel(" GPT-Live-1 ")).toBe(true);
    expect(isOpenAIGptLiveModel("gpt-live")).toBe(true);
  });

  it("rejects non-live models and prefix lookalikes", () => {
    expect(isOpenAIGptLiveModel(undefined)).toBe(false);
    expect(isOpenAIGptLiveModel("gpt-realtime-2.1")).toBe(false);
    expect(isOpenAIGptLiveModel("gpt-liveish")).toBe(false);
  });
});

describe("openai realtime voice provider gpt-live transport routing", () => {
  beforeEach(() => {
    mintSecretMock.mockReset();
    mintSecretMock.mockResolvedValue({ value: "ek_test", expiresAt: 1234 });
  });

  it("keeps GA realtime browser sessions working", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const session = await provider.createBrowserSession?.({
      providerConfig: { apiKey: "test-key" },
      model: "gpt-realtime-2.1",
      instructions: "Keep GA behavior unchanged.",
    });
    expect(session).toMatchObject({
      transport: "webrtc",
      offerUrl: "https://api.openai.com/v1/realtime/calls",
    });
    expect(mintSecretMock.mock.calls[0]?.[0]?.session).toMatchObject({
      type: "realtime",
      model: "gpt-realtime-2.1",
      instructions: "Keep GA behavior unchanged.",
    });
  });

  it("routes gpt-live models to a backend WebSocket bridge", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const callbacks = {
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    };
    expect(
      provider.createBridge({
        ...callbacks,
        providerConfig: { apiKey: "test-key", model: "gpt-live-1-codex" },
      }),
    ).toMatchObject({ supportsToolResultContinuation: true });
    expect(() =>
      provider.createBridge({
        ...callbacks,
        providerConfig: { apiKey: "test-key", model: "gpt-realtime-2.1" },
      }),
    ).not.toThrow();
  });

  it("rejects Azure credentials before creating a Platform GPT-Live bridge", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    expect(() =>
      provider.createBridge({
        providerConfig: {
          apiKey: "azure-test-key",
          model: "gpt-live-1-codex",
          azureEndpoint: "https://example.openai.azure.com",
          azureDeployment: "realtime",
        },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
      }),
    ).toThrow("GPT-Live backend WebSocket sessions do not support Azure");
  });
});
