// Google tests cover realtime voice provider plugin behavior.
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  resamplePcm,
} from "openclaw/plugin-sdk/realtime-voice";
import type { RealtimeVoiceTool } from "openclaw/plugin-sdk/realtime-voice";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGoogleRealtimeVoiceProvider } from "./realtime-voice-provider.js";

type MockGoogleLiveSession = {
  close: ReturnType<typeof vi.fn>;
  sendClientContent: ReturnType<typeof vi.fn>;
  sendRealtimeInput: ReturnType<typeof vi.fn>;
  sendToolResponse: ReturnType<typeof vi.fn>;
};

type MockGoogleLiveConnectParams = {
  model: string;
  config: Record<string, unknown>;
  callbacks: {
    onopen: () => void;
    onmessage: (message: Record<string, unknown>) => void;
    onerror: (event: { error?: unknown; message?: string }) => void;
    onclose: (event?: { code?: number; reason?: string; wasClean?: boolean }) => void;
  };
};

const { connectMock, createGoogleGenAIMock, createTokenMock, session } = vi.hoisted(() => {
  const sessionValue: MockGoogleLiveSession = {
    close: vi.fn(),
    sendClientContent: vi.fn(),
    sendRealtimeInput: vi.fn(),
    sendToolResponse: vi.fn(),
  };
  const connectMockLocal = vi.fn(async (_params: MockGoogleLiveConnectParams) => sessionValue);
  const createTokenMockLocal = vi.fn(async (_params: unknown) => ({
    name: "auth_tokens/browser-session",
  }));
  const createGoogleGenAIMockLocal = vi.fn(() => ({
    authTokens: {
      create: createTokenMockLocal,
    },
    live: {
      connect: connectMockLocal,
    },
  }));
  return {
    connectMock: connectMockLocal,
    createGoogleGenAIMock: createGoogleGenAIMockLocal,
    createTokenMock: createTokenMockLocal,
    session: sessionValue,
  };
});

vi.mock("./google-genai-runtime.js", () => ({
  createGoogleGenAI: createGoogleGenAIMock,
}));

const ENV_KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string>>;

function lastConnectParams(): MockGoogleLiveConnectParams {
  const params = connectMock.mock.calls.at(-1)?.[0];
  if (!params) {
    throw new Error("expected google live connect call");
  }
  return params;
}

function sentAudio(index = 0): { data?: unknown; mimeType?: unknown } {
  const audio = session.sendRealtimeInput.mock.calls[index]?.[0]?.audio;
  if (!audio) {
    throw new Error(`Expected sent audio at index ${index}`);
  }
  return audio as { data?: unknown; mimeType?: unknown };
}

function requireFirstMockArg(mock: ReturnType<typeof vi.fn>, label: string): unknown {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call[0];
}

function requireFirstError(mock: ReturnType<typeof vi.fn>): { message?: string } {
  const error = requireFirstMockArg(mock, "Google Live error");
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    throw new Error("expected Google Live error");
  }
  return error as { message?: string };
}

function requireFirstAudio(mock: ReturnType<typeof vi.fn>): unknown {
  return requireFirstMockArg(mock, "Google Live audio");
}

function createRealtimeTool(name: string): RealtimeVoiceTool {
  return {
    type: "function",
    name,
    description: "Contract test tool",
    parameters: { type: "object", properties: {} },
  };
}

function createUnreadableToolName(): RealtimeVoiceTool {
  return {
    type: "function",
    get name(): string {
      throw new Error("unreadable tool name");
    },
    description: "Contract test tool",
    parameters: { type: "object", properties: {} },
  };
}

function createMalformedToolName(name: unknown): RealtimeVoiceTool {
  return {
    type: "function",
    name,
    description: "Contract test tool",
    parameters: { type: "object", properties: {} },
  } as unknown as RealtimeVoiceTool;
}

function createMockGoogleLiveSession(): MockGoogleLiveSession {
  return {
    close: vi.fn(),
    sendClientContent: vi.fn(),
    sendRealtimeInput: vi.fn(),
    sendToolResponse: vi.fn(),
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve = (_value: T) => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("buildGoogleRealtimeVoiceProvider", () => {
  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    connectMock.mockClear();
    createGoogleGenAIMock.mockClear();
    createTokenMock.mockClear();
    session.close.mockClear();
    session.sendClientContent.mockClear();
    session.sendRealtimeInput.mockClear();
    session.sendToolResponse.mockClear();
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      const value = envSnapshot[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  afterAll(() => {
    vi.doUnmock("./google-genai-runtime.js");
    vi.resetModules();
  });

  it("declares realtime Talk capabilities for catalog selection", () => {
    const provider = buildGoogleRealtimeVoiceProvider();

    expect(provider.defaultModel).toBe("gemini-3.1-flash-live-preview");
    expect(provider.capabilities).toEqual({
      transports: ["provider-websocket", "gateway-relay"],
      inputAudioFormats: [
        { encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 },
        { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
      ],
      outputAudioFormats: [
        { encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 },
        { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
      ],
      supportsBrowserSession: true,
      supportsBargeIn: true,
      handlesInputAudioBargeIn: true,
      supportsToolCalls: true,
      supportsVideoFrames: true,
      supportsSessionResumption: true,
    });
  });

  it("uses Gemini 3.1 Live-compatible defaults", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: {
        apiKey: "gemini-key",
        enableAffectiveDialog: true,
        thinkingBudget: 8_193,
      },
      tools: [createRealtimeTool("openclaw_agent_consult")],
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    expect(bridge.supportsToolResultContinuation).toBe(false);
    expect(bridge.supportsToolResultSuppression).toBe(false);
    await bridge.connect();

    const params = lastConnectParams();
    expect(params.model).toBe("gemini-3.1-flash-live-preview");
    expect(params.config.thinkingConfig).toEqual({ thinkingLevel: "HIGH" });
    expect(params.config).not.toHaveProperty("enableAffectiveDialog");
    const config = params.config as {
      tools?: Array<{ functionDeclarations?: Array<{ behavior?: string; name?: string }> }>;
    };
    expect(config.tools?.[0]?.functionDeclarations?.[0]).toMatchObject({
      name: "openclaw_agent_consult",
    });
    expect(config.tools?.[0]?.functionDeclarations?.[0]).not.toHaveProperty("behavior");
  });

  it("normalizes provider config and cfg model-provider key fallback", () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {
        models: {
          providers: {
            google: {
              apiKey: "cfg-key",
            },
          },
        },
      } as never,
      rawConfig: {
        providers: {
          google: {
            model: "gemini-live-2.5-flash-preview",
            voice: "Puck",
            temperature: 0.4,
            silenceDurationMs: 700,
            startSensitivity: "high",
            activityHandling: "no_interruption",
            turnCoverage: "turn_includes_only_activity",
            automaticActivityDetectionDisabled: false,
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "cfg-key",
      model: "gemini-live-2.5-flash-preview",
      voice: "Puck",
      temperature: 0.4,
      apiVersion: undefined,
      prefixPaddingMs: undefined,
      silenceDurationMs: 700,
      startSensitivity: "high",
      endSensitivity: undefined,
      activityHandling: "no-interruption",
      turnCoverage: "only-activity",
      automaticActivityDetectionDisabled: false,
      enableAffectiveDialog: undefined,
      sessionResumption: undefined,
      contextWindowCompression: undefined,
      thinkingLevel: undefined,
      thinkingBudget: undefined,
    });
  });

  it("connects with Google Live setup config and tool declarations", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: {
        apiKey: "gemini-key",
        model: "gemini-live-2.5-flash-preview",
        voice: "Kore",
        temperature: 0.3,
        startSensitivity: "low",
        endSensitivity: "low",
        activityHandling: "no-interruption",
        turnCoverage: "only-activity",
      },
      instructions: "Speak briefly.",
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Look something up",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        },
        {
          type: "function",
          name: "openclaw_agent_consult",
          description: "Ask OpenClaw",
          parameters: {
            type: "object",
            properties: {
              question: { type: "string" },
            },
            required: ["question"],
          },
        },
      ],
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await bridge.connect();

    expect(connectMock).toHaveBeenCalledTimes(1);
    const params = lastConnectParams();
    expect(params.model).toBe("gemini-live-2.5-flash-preview");
    const config = params.config as {
      contextWindowCompression?: unknown;
      outputAudioTranscription?: unknown;
      realtimeInputConfig?: {
        activityHandling?: string;
        automaticActivityDetection?: {
          endOfSpeechSensitivity?: string;
          startOfSpeechSensitivity?: string;
        };
        turnCoverage?: string;
      };
      responseModalities?: string[];
      sessionResumption?: unknown;
      speechConfig?: { voiceConfig?: { prebuiltVoiceConfig?: { voiceName?: string } } };
      systemInstruction?: string;
      temperature?: number;
      tools?: Array<{
        functionDeclarations?: Array<{
          behavior?: string;
          description?: string;
          name?: string;
          parameters?: unknown;
        }>;
      }>;
    };
    expect(config.responseModalities).toEqual(["AUDIO"]);
    expect(config.temperature).toBe(0.3);
    expect(config.systemInstruction).toBe("Speak briefly.");
    expect(config.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe("Kore");
    expect(config.outputAudioTranscription).toEqual({});
    expect(config.realtimeInputConfig?.activityHandling).toBe("NO_INTERRUPTION");
    expect(config.realtimeInputConfig?.automaticActivityDetection?.startOfSpeechSensitivity).toBe(
      "START_SENSITIVITY_LOW",
    );
    expect(config.realtimeInputConfig?.automaticActivityDetection?.endOfSpeechSensitivity).toBe(
      "END_SENSITIVITY_LOW",
    );
    expect(config.realtimeInputConfig?.turnCoverage).toBe("TURN_INCLUDES_ONLY_ACTIVITY");
    expect(config.sessionResumption).toEqual({});
    expect(config.contextWindowCompression).toEqual({ slidingWindow: {} });
    const declarations = config.tools?.[0]?.functionDeclarations ?? [];
    expect(declarations[0]?.name).toBe("lookup");
    expect(declarations[0]?.description).toBe("Look something up");
    expect(declarations[0]?.parameters).toEqual({
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    });
    expect(declarations[1]?.name).toBe("openclaw_agent_consult");
    expect(declarations[1]?.description).toBe("Ask OpenClaw");
    expect(declarations[1]?.parameters).toEqual({
      type: "object",
      properties: {
        question: { type: "string" },
      },
      required: ["question"],
    });
    expect(declarations[1]?.behavior).toBe("NON_BLOCKING");
  });

  it("omits tool names that Google Live cannot accept", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      tools: [
        createRealtimeTool("_lookup"),
        createRealtimeTool("calendar.lookup:next"),
        createRealtimeTool("1_lookup"),
        createRealtimeTool("bad/name"),
        createRealtimeTool(`x${"a".repeat(128)}`),
        createMalformedToolName(undefined),
        createMalformedToolName(null),
        createMalformedToolName(42),
        createUnreadableToolName(),
      ],
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await bridge.connect();

    const config = lastConnectParams().config as {
      tools?: Array<{ functionDeclarations?: Array<{ name?: string }> }>;
    };
    expect(config.tools?.[0]?.functionDeclarations?.map((declaration) => declaration.name)).toEqual(
      ["_lookup", "calendar.lookup:next"],
    );
  });

  it("omits zero temperature for native audio responses", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: {
        apiKey: "gemini-key",
        temperature: 0,
      },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await bridge.connect();

    expect(lastConnectParams().config).not.toHaveProperty("temperature");
  });

  it("drops malformed VAD timing values before connecting", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: {
        apiKey: "gemini-key",
        prefixPaddingMs: -1,
        silenceDurationMs: 250.5,
      },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await bridge.connect();

    expect(lastConnectParams().config).not.toHaveProperty("realtimeInputConfig");
  });

  it("drops malformed thinking budgets before connecting", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: {
        apiKey: "gemini-key",
        thinkingBudget: 24_576.5,
      },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await bridge.connect();

    expect(lastConnectParams().config).not.toHaveProperty("thinkingConfig");
  });

  it("passes Google Live dynamic thinking budget through", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: {
        apiKey: "gemini-key",
        model: "gemini-live-2.5-flash-preview",
        thinkingBudget: -1,
      },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await bridge.connect();

    expect(lastConnectParams().config.thinkingConfig).toEqual({ thinkingBudget: -1 });
  });

  it("omits adaptive thinking budgets for Gemini 3.1 Live", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: {
        apiKey: "gemini-key",
        thinkingBudget: -1,
      },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await bridge.connect();

    expect(lastConnectParams().config).not.toHaveProperty("thinkingConfig");
  });

  it("creates constrained browser sessions for Google Live Talk", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();

    const sessionLocal = await provider.createBrowserSession?.({
      providerConfig: {
        apiKey: "gemini-key",
        model: "gemini-live-2.5-flash-preview",
        prefixPaddingMs: 100,
        silenceDurationMs: 300,
        voice: "Puck",
        temperature: 0.4,
      },
      prefixPaddingMs: 250,
      silenceDurationMs: 650,
      instructions: "Speak briefly.",
      tools: [
        {
          type: "function",
          name: "openclaw_agent_consult",
          description: "Ask OpenClaw",
          parameters: {
            type: "object",
            properties: {
              question: { type: "string" },
            },
            required: ["question"],
          },
        },
      ],
    });

    expect(createTokenMock).toHaveBeenCalledTimes(1);
    const tokenConfig = requireFirstMockArg(createTokenMock, "Google Live auth token config") as {
      config?: {
        liveConnectConstraints?: {
          config?: {
            realtimeInputConfig?: {
              automaticActivityDetection?: {
                prefixPaddingMs?: number;
                silenceDurationMs?: number;
              };
            };
            responseModalities?: string[];
            speechConfig?: { voiceConfig?: { prebuiltVoiceConfig?: { voiceName?: string } } };
            systemInstruction?: string;
            temperature?: number;
            tools?: Array<{
              functionDeclarations?: Array<{
                behavior?: string;
                name?: string;
                parameters?: unknown;
                parametersJsonSchema?: unknown;
              }>;
            }>;
          };
          model?: string;
        };
        uses?: number;
      };
    };
    const liveConstraints = tokenConfig.config?.liveConnectConstraints;
    expect(tokenConfig.config?.uses).toBe(1);
    expect(liveConstraints?.model).toBe("gemini-live-2.5-flash-preview");
    expect(liveConstraints?.config?.responseModalities).toEqual(["AUDIO"]);
    expect(liveConstraints?.config?.temperature).toBe(0.4);
    expect(liveConstraints?.config?.systemInstruction).toBe("Speak briefly.");
    expect(
      liveConstraints?.config?.realtimeInputConfig?.automaticActivityDetection?.prefixPaddingMs,
    ).toBe(250);
    expect(
      liveConstraints?.config?.realtimeInputConfig?.automaticActivityDetection?.silenceDurationMs,
    ).toBe(650);
    expect(liveConstraints?.config?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe(
      "Puck",
    );
    const declaration = liveConstraints?.config?.tools?.[0]?.functionDeclarations?.[0];
    expect(declaration?.name).toBe("openclaw_agent_consult");
    expect(declaration?.behavior).toBe("NON_BLOCKING");
    expect(declaration?.parameters).toEqual({
      type: "object",
      properties: {
        question: { type: "string" },
      },
      required: ["question"],
    });
    expect(declaration?.parametersJsonSchema).toBeUndefined();
    expect(sessionLocal?.provider).toBe("google");
    expect(sessionLocal?.transport).toBe("provider-websocket");
    const websocketSession = sessionLocal as {
      audio: {
        inputEncoding: string;
        inputSampleRateHz: number;
        outputEncoding: string;
        outputSampleRateHz: number;
      };
      clientSecret: string;
      initialMessage: {
        setup: { generationConfig: { responseModalities: string[] }; model: string };
      };
      protocol: string;
      websocketUrl: string;
    };
    expect(websocketSession.protocol).toBe("google-live-bidi");
    expect(websocketSession.clientSecret).toBe("auth_tokens/browser-session");
    expect(websocketSession.websocketUrl).toBe(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
    );
    expect(websocketSession.audio.inputEncoding).toBe("pcm16");
    expect(websocketSession.audio.inputSampleRateHz).toBe(16000);
    expect(websocketSession.audio.outputEncoding).toBe("pcm16");
    expect(websocketSession.audio.outputSampleRateHz).toBe(24000);
    expect(websocketSession.initialMessage.setup.model).toBe(
      "models/gemini-live-2.5-flash-preview",
    );
    expect(websocketSession.initialMessage.setup.generationConfig.responseModalities).toEqual([
      "AUDIO",
    ]);
  });

  it("returns browser expiry in the epoch milliseconds required by the Talk gateway", async () => {
    vi.useFakeTimers();
    const nowMs = Date.UTC(2026, 7, 1, 12, 34, 56, 789);
    vi.setSystemTime(nowMs);
    const provider = buildGoogleRealtimeVoiceProvider();

    const sessionLocal = await provider.createBrowserSession?.({
      providerConfig: { apiKey: "gemini-key" },
    });

    const tokenConfig = requireFirstMockArg(createTokenMock, "Google Live auth token config") as {
      config?: {
        expireTime?: string;
        newSessionExpireTime?: string;
      };
    };
    expect(tokenConfig.config?.expireTime).toBe(new Date(nowMs + 30 * 60 * 1000).toISOString());
    expect(tokenConfig.config?.newSessionExpireTime).toBe(
      new Date(nowMs + 60 * 1000).toISOString(),
    );
    expect(sessionLocal?.expiresAt).toBeGreaterThan(nowMs + 5_000);
    vi.advanceTimersByTime(60_001);
    expect(sessionLocal?.expiresAt).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(sessionLocal?.expiresAt).toBe(nowMs + 60 * 1000);
  });

  it("constrains default browser sessions to Gemini 3.1 capabilities", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();

    const sessionLocal = await provider.createBrowserSession?.({
      providerConfig: {
        apiKey: "gemini-key",
        enableAffectiveDialog: true,
        thinkingLevel: "low",
        thinkingBudget: 8_193,
      },
      tools: [createRealtimeTool("openclaw_agent_consult")],
    });

    const tokenConfig = requireFirstMockArg(createTokenMock, "Google Live auth token config") as {
      config?: {
        liveConnectConstraints?: {
          config?: {
            enableAffectiveDialog?: boolean;
            thinkingConfig?: unknown;
            tools?: Array<{
              functionDeclarations?: Array<{ behavior?: string; name?: string }>;
            }>;
          };
          model?: string;
        };
      };
    };
    const constraints = tokenConfig.config?.liveConnectConstraints;
    expect(constraints?.model).toBe("gemini-3.1-flash-live-preview");
    expect(constraints?.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    expect(constraints?.config).not.toHaveProperty("enableAffectiveDialog");
    expect(constraints?.config?.tools?.[0]?.functionDeclarations?.[0]).toMatchObject({
      name: "openclaw_agent_consult",
    });
    expect(constraints?.config?.tools?.[0]?.functionDeclarations?.[0]).not.toHaveProperty(
      "behavior",
    );
    expect(sessionLocal?.model).toBe("gemini-3.1-flash-live-preview");
  });

  it("creates browser-token clients with a finite request timeout", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    await provider.createBrowserSession?.({
      providerConfig: { apiKey: "test" },
    });

    const clientConfig = requireFirstMockArg(createGoogleGenAIMock, "GoogleGenAI config") as {
      httpOptions?: {
        apiVersion?: string;
        timeout?: number;
      };
    };
    expect(clientConfig.httpOptions).toMatchObject({
      apiVersion: "v1alpha",
      timeout: 30_000,
    });
  });

  it("rejects browser session expiry outside Date range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    const provider = buildGoogleRealtimeVoiceProvider();

    await expect(
      provider.createBrowserSession?.({
        providerConfig: {
          apiKey: "gemini-key",
        },
      }),
    ).rejects.toThrow("Google realtime browser session expiry is outside the supported Date range");
    expect(createTokenMock).not.toHaveBeenCalled();
  });

  it("rejects browser session creation while the process clock is invalid", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    const provider = buildGoogleRealtimeVoiceProvider();

    await expect(
      provider.createBrowserSession?.({
        providerConfig: {
          apiKey: "gemini-key",
        },
      }),
    ).rejects.toThrow("Google realtime browser session expiry is outside the supported Date range");
    expect(createTokenMock).not.toHaveBeenCalled();
  });

  it("can opt out of Google Live session resumption and context compression", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: {
        apiKey: "gemini-key",
        contextWindowCompression: false,
        sessionResumption: false,
      },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await bridge.connect();

    expect(lastConnectParams().config).not.toHaveProperty("contextWindowCompression");
    expect(lastConnectParams().config).not.toHaveProperty("sessionResumption");
  });

  it("shares one pending Google Live connection across concurrent callers", async () => {
    const pendingSession = createDeferred<MockGoogleLiveSession>();
    const connectedSession = createMockGoogleLiveSession();
    connectMock.mockReturnValueOnce(pendingSession.promise);
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    const firstConnect = bridge.connect();
    const secondConnect = bridge.connect();

    expect(connectMock).toHaveBeenCalledTimes(1);
    pendingSession.resolve(connectedSession);
    await Promise.all([firstConnect, secondConnect]);
    expect(connectedSession.close).not.toHaveBeenCalled();
  });

  it("disposes a late session and ignores stale callbacks after reconnecting", async () => {
    vi.useFakeTimers();
    const pendingSession = createDeferred<MockGoogleLiveSession>();
    const lateSession = createMockGoogleLiveSession();
    const replacementSession = createMockGoogleLiveSession();
    connectMock
      .mockReturnValueOnce(pendingSession.promise)
      .mockResolvedValueOnce(replacementSession);
    const provider = buildGoogleRealtimeVoiceProvider();
    const onReady = vi.fn();
    const onError = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onReady,
      onError,
    });

    const cancelledConnect = bridge.connect();
    const staleCallbacks = lastConnectParams().callbacks;
    bridge.close();
    await cancelledConnect;

    await bridge.connect();
    const activeCallbacks = lastConnectParams().callbacks;
    activeCallbacks.onopen();
    activeCallbacks.onmessage({ setupComplete: {} });
    expect(bridge.isConnected()).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);

    staleCallbacks.onopen();
    staleCallbacks.onmessage({ setupComplete: {} });
    staleCallbacks.onerror({ message: "stale error" });
    staleCallbacks.onclose({ code: 1011, reason: "stale close" });
    await vi.advanceTimersByTimeAsync(250);

    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(bridge.isConnected()).toBe(true);
    expect(replacementSession.close).not.toHaveBeenCalled();

    pendingSession.resolve(lateSession);
    await vi.waitFor(() => {
      expect(lateSession.close).toHaveBeenCalledTimes(1);
    });
    expect(bridge.isConnected()).toBe(true);

    bridge.close();
    bridge.close();
    expect(replacementSession.close).toHaveBeenCalledTimes(1);
  });

  it("preserves transcript fragments while reusing a resumption handle", async () => {
    vi.useFakeTimers();
    const provider = buildGoogleRealtimeVoiceProvider();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onTranscript,
    });

    await bridge.connect();
    const firstSession = lastConnectParams().callbacks;
    firstSession.onmessage({
      sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
      serverContent: { inputTranscription: { text: "Before " } },
    });
    firstSession.onmessage({
      sessionResumptionUpdate: { newHandle: "unconfirmed-handle" },
    });
    firstSession.onclose({ code: 1011, reason: "temporary" });
    await vi.advanceTimersByTimeAsync(250);
    lastConnectParams().callbacks.onmessage({
      serverContent: { inputTranscription: { text: "after", finished: true } },
    });

    expect(lastConnectParams().config.sessionResumption).toEqual({ handle: "resume-1" });
    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([
      ["user", "Before after", true],
    ]);
  });

  it("preserves tool ownership while reusing a resumption handle", async () => {
    vi.useFakeTimers();
    const provider = buildGoogleRealtimeVoiceProvider();
    const onToolCall = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall,
    });

    await bridge.connect();
    const firstSession = lastConnectParams().callbacks;
    firstSession.onmessage({
      sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
      toolCall: {
        functionCalls: [{ id: "call-1", name: "lookup", args: { query: "before" } }],
      },
    });
    firstSession.onclose({ code: 1011, reason: "temporary" });
    void bridge.submitToolResult("call-1", { result: "ok" });
    expect(session.sendToolResponse).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);

    const resumedSession = lastConnectParams().callbacks;
    resumedSession.onmessage({
      toolCall: {
        functionCalls: [{ id: "call-1", name: "different", args: { query: "replay" } }],
      },
    });
    resumedSession.onopen();
    resumedSession.onmessage({ setupComplete: {} });

    expect(lastConnectParams().config.sessionResumption).toEqual({ handle: "resume-1" });
    expect(onToolCall).toHaveBeenCalledOnce();
    expect(session.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        {
          id: "call-1",
          name: "lookup",
          response: { result: "ok" },
        },
      ],
    });
  });

  it("fails closed when resumable tool responses exceed the reconnect buffer", async () => {
    vi.useFakeTimers();
    const provider = buildGoogleRealtimeVoiceProvider();
    const onError = vi.fn();
    const onClose = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall: vi.fn(),
      onError,
      onClose,
    });

    await bridge.connect();
    const firstSession = lastConnectParams().callbacks;
    firstSession.onmessage({
      sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
      toolCall: {
        functionCalls: [{ id: "call-1", name: "lookup", args: {} }],
      },
    });
    firstSession.onclose({ code: 1011, reason: "temporary" });
    onError.mockClear();

    void bridge.submitToolResult("call-1", { result: "x".repeat(1024 * 1024) });

    expect(requireFirstError(onError).message).toBe(
      "Google Live reconnect tool-response buffer limit exceeded",
    );
    expect(onClose).toHaveBeenCalledWith("error");
    expect(session.sendToolResponse).not.toHaveBeenCalled();
  });

  it("drops queued reconnect responses when the resumed session cancels their call", async () => {
    vi.useFakeTimers();
    const provider = buildGoogleRealtimeVoiceProvider();
    const onEvent = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall: vi.fn(),
      onEvent,
    });

    await bridge.connect();
    const firstSession = lastConnectParams().callbacks;
    firstSession.onmessage({
      sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
      toolCall: {
        functionCalls: [{ id: "call-1", name: "lookup", args: {} }],
      },
    });
    firstSession.onclose({ code: 1011, reason: "temporary" });
    await vi.advanceTimersByTimeAsync(250);

    const resumedSession = lastConnectParams().callbacks;
    void bridge.submitToolResult("call-1", { result: "stale" });
    expect(session.sendToolResponse).not.toHaveBeenCalled();
    resumedSession.onopen();
    resumedSession.onmessage({
      setupComplete: {},
      toolCallCancellation: { ids: ["call-1"] },
    });

    expect(session.sendToolResponse).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "tool.call.cancelled",
      itemId: "call-1",
    });
  });

  it("resets tool ownership before a fresh automatic reconnect", async () => {
    vi.useFakeTimers();
    const provider = buildGoogleRealtimeVoiceProvider();
    const onToolCall = vi.fn();
    const onEvent = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall,
      onEvent,
    });

    await bridge.connect();
    const firstSession = lastConnectParams().callbacks;
    firstSession.onmessage({
      toolCall: {
        functionCalls: [{ id: "call-1", name: "old_lookup", args: {} }],
      },
    });
    firstSession.onclose({ code: 1011, reason: "temporary" });
    await vi.advanceTimersByTimeAsync(250);

    lastConnectParams().callbacks.onmessage({
      toolCall: {
        functionCalls: [{ id: "call-1", name: "new_lookup", args: {} }],
      },
    });
    void bridge.submitToolResult("call-1", { result: "ok" });

    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "session.continuity.reset",
    });
    expect(onToolCall).toHaveBeenCalledTimes(2);
    expect(session.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        {
          id: "call-1",
          name: "new_lookup",
          response: { result: "ok" },
        },
      ],
    });
  });

  it("preserves continuity when resumability recovers before reconnect", async () => {
    vi.useFakeTimers();
    const provider = buildGoogleRealtimeVoiceProvider();
    const onEvent = vi.fn();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onEvent,
      onTranscript,
    });

    await bridge.connect();
    const firstSession = lastConnectParams().callbacks;
    firstSession.onmessage({
      sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
      serverContent: { inputTranscription: { text: "Before " } },
    });
    firstSession.onmessage({
      sessionResumptionUpdate: { resumable: false },
    });
    firstSession.onmessage({
      sessionResumptionUpdate: { resumable: true, newHandle: "resume-2" },
    });
    expect(onEvent).not.toHaveBeenCalled();

    firstSession.onclose({ code: 1011, reason: "temporary" });
    await vi.advanceTimersByTimeAsync(250);
    lastConnectParams().callbacks.onmessage({
      serverContent: { inputTranscription: { text: "after", finished: true } },
    });

    expect(lastConnectParams().config.sessionResumption).toEqual({ handle: "resume-2" });
    expect(onEvent).not.toHaveBeenCalled();
    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([
      ["user", "Before after", true],
    ]);
  });

  it("drops unfinished hypotheses when a new session has no continuity", async () => {
    vi.useFakeTimers();
    const provider = buildGoogleRealtimeVoiceProvider();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key", sessionResumption: false },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onTranscript,
    });

    await bridge.connect();
    const firstSession = lastConnectParams().callbacks;
    firstSession.onmessage({
      serverContent: { inputTranscription: { text: "Old fragment " } },
    });
    firstSession.onclose({ code: 1011, reason: "temporary" });
    await vi.advanceTimersByTimeAsync(250);
    lastConnectParams().callbacks.onmessage({
      serverContent: { inputTranscription: { text: "New turn", finished: true } },
    });

    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([
      ["user", "New turn", true],
    ]);
  });

  it.each([undefined, "invalidated-handle"])("invalidates resume handles %#", async (newHandle) => {
    vi.useFakeTimers();
    try {
      const provider = buildGoogleRealtimeVoiceProvider();
      const onClose = vi.fn();
      const onError = vi.fn();
      const onEvent = vi.fn();
      const onTranscript = vi.fn();
      const bridge = provider.createBridge({
        providerConfig: { apiKey: "gemini-key" },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        onClose,
        onError,
        onEvent,
        onTranscript,
      });

      await bridge.connect();
      lastConnectParams().callbacks.onmessage({
        setupComplete: { sessionId: "session-1" },
        sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
        serverContent: {
          inputTranscription: { text: "Previous caller " },
          outputTranscription: { text: "Previous assistant " },
        },
      });
      lastConnectParams().callbacks.onmessage({
        sessionResumptionUpdate: { resumable: false, ...(newHandle ? { newHandle } : {}) },
      });
      expect(onEvent).not.toHaveBeenCalled();
      lastConnectParams().callbacks.onclose({
        code: 1011,
        reason: "temporary upstream close",
        wasClean: false,
      });

      expect(onClose).not.toHaveBeenCalled();
      expect(onEvent).toHaveBeenCalledOnce();
      expect(onEvent).toHaveBeenCalledWith({
        direction: "client",
        type: "session.continuity.reset",
      });
      const error = requireFirstError(onError);
      expect(error.message).toContain("reconnecting 1/3");

      await vi.advanceTimersByTimeAsync(250);

      expect(connectMock).toHaveBeenCalledTimes(2);
      expect(lastConnectParams().config.sessionResumption).toEqual({});
      expect(onEvent).toHaveBeenCalledOnce();
      const resetOrder = onEvent.mock.invocationCallOrder[0];
      const reconnectOrder = connectMock.mock.invocationCallOrder[1];
      if (resetOrder === undefined || reconnectOrder === undefined) {
        throw new Error("expected continuity reset before reconnect");
      }
      expect(resetOrder).toBeLessThan(reconnectOrder);

      lastConnectParams().callbacks.onmessage({
        setupComplete: { sessionId: "session-2" },
        serverContent: {
          inputTranscription: { text: "Fresh caller", finished: true },
          outputTranscription: { text: "Fresh assistant", finished: true },
        },
      });

      expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([
        ["user", "Fresh caller", true],
        ["assistant", "Fresh assistant", true],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not finalize or merge a hypothesis across a fresh automatic reconnect", async () => {
    vi.useFakeTimers();
    const provider = buildGoogleRealtimeVoiceProvider();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onTranscript,
    });

    await bridge.connect();
    const firstSession = lastConnectParams().callbacks;
    firstSession.onmessage({
      setupComplete: {},
      serverContent: { inputTranscription: { text: "Interrupted hypothesis" } },
    });
    firstSession.onclose({ code: 1011, reason: "temporary" });

    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    lastConnectParams().callbacks.onmessage({
      setupComplete: {},
      serverContent: { inputTranscription: { text: "New utterance", finished: true } },
    });

    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([
      ["user", "New utterance", true],
    ]);
  });

  it("keeps transcript fragments pending across a resumable reconnect", async () => {
    vi.useFakeTimers();
    const provider = buildGoogleRealtimeVoiceProvider();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onTranscript,
    });

    await bridge.connect();
    const firstSession = lastConnectParams().callbacks;
    firstSession.onmessage({
      setupComplete: {},
      sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
      serverContent: {
        outputTranscription: { text: "Before " },
        turnComplete: true,
      },
    });
    await vi.advanceTimersByTimeAsync(500);
    firstSession.onclose({ code: 1011, reason: "temporary" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onTranscript.mock.calls).toEqual([["assistant", "Before ", false]]);

    lastConnectParams().callbacks.onmessage({
      setupComplete: {},
      serverContent: { outputTranscription: { text: "after", finished: true } },
    });
    expect(onTranscript.mock.calls.at(-1)).toEqual(["assistant", "Before after", true]);
  });

  it("flushes pending transcripts before closing after reconnect failures", async () => {
    vi.useFakeTimers();
    const provider = buildGoogleRealtimeVoiceProvider();
    const onClose = vi.fn();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onClose,
      onTranscript,
    });

    await bridge.connect();
    const firstSession = lastConnectParams().callbacks;
    firstSession.onmessage({
      setupComplete: {},
      sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
      serverContent: { inputTranscription: { text: "Last words" } },
    });
    connectMock
      .mockRejectedValueOnce(new Error("connect failed 1"))
      .mockRejectedValueOnce(new Error("connect failed 2"))
      .mockRejectedValueOnce(new Error("connect failed 3"));
    firstSession.onclose({ code: 1011, reason: "temporary" });

    await vi.advanceTimersByTimeAsync(1_750);

    expect(onTranscript.mock.calls.at(-1)).toEqual(["user", "Last words", true]);
    expect(onClose).toHaveBeenCalledWith("error");
    expect(onTranscript.mock.invocationCallOrder.at(-1)).toBeLessThan(
      onClose.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("emits one continuity reset across failed fresh reconnect attempts", async () => {
    vi.useFakeTimers();
    const provider = buildGoogleRealtimeVoiceProvider();
    const onClose = vi.fn();
    const onEvent = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key", sessionResumption: false },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onClose,
      onEvent,
    });

    await bridge.connect();
    const firstSession = lastConnectParams().callbacks;
    firstSession.onmessage({ setupComplete: {} });
    connectMock
      .mockRejectedValueOnce(new Error("connect failed 1"))
      .mockRejectedValueOnce(new Error("connect failed 2"))
      .mockRejectedValueOnce(new Error("connect failed 3"));
    firstSession.onclose({ code: 1011, reason: "temporary" });

    await vi.advanceTimersByTimeAsync(1_750);

    expect(connectMock).toHaveBeenCalledTimes(4);
    expect(onEvent.mock.calls).toEqual([
      [{ direction: "client", type: "session.continuity.reset" }],
    ]);
    expect(onClose).toHaveBeenCalledWith("error");
  });

  it("rearms continuity reset after pre-return setup selects a fresh session", async () => {
    vi.useFakeTimers();
    const pendingSession = createDeferred<MockGoogleLiveSession>();
    const freshSession = createMockGoogleLiveSession();
    connectMock
      .mockReturnValueOnce(Promise.resolve(session))
      .mockReturnValueOnce(pendingSession.promise);
    const provider = buildGoogleRealtimeVoiceProvider();
    const onEvent = vi.fn();
    const onReady = vi.fn();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key", sessionResumption: false },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onEvent,
      onReady,
      onTranscript,
    });

    await bridge.connect();
    const firstCallbacks = lastConnectParams().callbacks;
    firstCallbacks.onopen();
    firstCallbacks.onmessage({ setupComplete: {} });
    firstCallbacks.onclose({ code: 1011, reason: "temporary" });
    const queuedAudio = Buffer.from([0x7f]);
    bridge.sendAudio(queuedAudio);
    await vi.advanceTimersByTimeAsync(250);

    const freshCallbacks = lastConnectParams().callbacks;
    expect(onEvent).toHaveBeenCalledTimes(1);
    freshCallbacks.onopen();
    freshCallbacks.onmessage({
      setupComplete: {},
      serverContent: { inputTranscription: { text: "Fresh partial " } },
    });
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "session.continuity.reset",
      "session.created",
    ]);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(freshSession.sendRealtimeInput).not.toHaveBeenCalled();

    pendingSession.resolve(freshSession);
    await vi.waitFor(() => {
      expect(onReady).toHaveBeenCalledTimes(2);
    });
    const sessionCreatedOrder = onEvent.mock.invocationCallOrder[1];
    const queuedAudioOrder = freshSession.sendRealtimeInput.mock.invocationCallOrder[0];
    const freshReadyOrder = onReady.mock.invocationCallOrder[1];
    if (
      sessionCreatedOrder === undefined ||
      queuedAudioOrder === undefined ||
      freshReadyOrder === undefined
    ) {
      throw new Error("expected fresh session creation, queued audio, and readiness");
    }
    expect(sessionCreatedOrder).toBeLessThan(queuedAudioOrder);
    expect(queuedAudioOrder).toBeLessThan(freshReadyOrder);
    expect(freshSession.sendRealtimeInput).toHaveBeenCalledOnce();
    expect(freshSession.sendRealtimeInput).toHaveBeenCalledWith({
      audio: {
        data: expect.any(String),
        mimeType: "audio/pcm;rate=16000",
      },
    });
    freshCallbacks.onclose({ code: 1011, reason: "temporary again" });
    await vi.advanceTimersByTimeAsync(250);

    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "session.continuity.reset",
      "session.created",
      "session.continuity.reset",
    ]);
    lastConnectParams().callbacks.onmessage({
      serverContent: { inputTranscription: { text: "Next", finished: true } },
    });
    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([
      ["user", "Next", true],
    ]);
  });

  it("waits for the returned session after setup completion before activating", async () => {
    const pendingSession = createDeferred<MockGoogleLiveSession>();
    const connectedSession = createMockGoogleLiveSession();
    connectMock.mockReturnValueOnce(pendingSession.promise);
    const provider = buildGoogleRealtimeVoiceProvider();
    const onReady = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onReady,
    });

    const connect = bridge.connect();
    lastConnectParams().callbacks.onopen();
    bridge.sendAudio(Buffer.from([0xff, 0xff]));

    expect(connectedSession.sendRealtimeInput).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(bridge.isConnected()).toBe(false);

    lastConnectParams().callbacks.onmessage({ setupComplete: { sessionId: "session-1" } });

    expect(connectedSession.sendRealtimeInput).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(bridge.isConnected()).toBe(false);

    pendingSession.resolve(connectedSession);
    await connect;

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(bridge.isConnected()).toBe(true);
    expect(connectedSession.sendRealtimeInput).toHaveBeenCalledTimes(1);
    const audio = connectedSession.sendRealtimeInput.mock.calls[0]?.[0]?.audio as
      | { data?: unknown; mimeType?: unknown }
      | undefined;
    expect(typeof audio?.data).toBe("string");
    expect(audio?.mimeType).toBe("audio/pcm;rate=16000");

    lastConnectParams().callbacks.onmessage({ setupComplete: { sessionId: "session-1" } });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(connectedSession.sendRealtimeInput).toHaveBeenCalledTimes(1);
  });

  it("copies and bounds pending audio by aggregate bytes before activation", async () => {
    const connectedSession = createMockGoogleLiveSession();
    connectMock.mockResolvedValueOnce(connectedSession);
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });
    const backing = Buffer.alloc(2 * 1024 * 1024);
    const firstChunk = backing.subarray(0, 512 * 1024);
    firstChunk.writeInt16LE(513);
    const expectedFirstSample = resamplePcm(Buffer.from(firstChunk), 24_000, 16_000).readInt16LE(0);

    bridge.sendAudio(firstChunk);
    bridge.sendAudio(Buffer.alloc(512 * 1024, 0x7f));
    bridge.sendAudio(Buffer.from([0x01]));
    firstChunk.fill(0);

    await bridge.connect();
    lastConnectParams().callbacks.onopen();
    lastConnectParams().callbacks.onmessage({ setupComplete: { sessionId: "session-1" } });

    expect(connectedSession.sendRealtimeInput).toHaveBeenCalledTimes(2);
    const firstAudio = connectedSession.sendRealtimeInput.mock.calls[0]?.[0]?.audio as
      | { data?: unknown }
      | undefined;
    expect(Buffer.from(String(firstAudio?.data), "base64").readInt16LE(0)).toBe(
      expectedFirstSample,
    );
  });

  it("bounds pending audio by chunk count before activation", async () => {
    const connectedSession = createMockGoogleLiveSession();
    connectMock.mockResolvedValueOnce(connectedSession);
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    for (let index = 0; index < 321; index += 1) {
      bridge.sendAudio(Buffer.alloc(2, index & 0xff));
    }

    await bridge.connect();
    lastConnectParams().callbacks.onopen();
    lastConnectParams().callbacks.onmessage({ setupComplete: { sessionId: "session-1" } });

    expect(connectedSession.sendRealtimeInput).toHaveBeenCalledTimes(320);
  });

  it("drops reconnect audio on terminal exhaustion until an explicit reconnect owns admission", async () => {
    vi.useFakeTimers();
    const reconnectedSession = createMockGoogleLiveSession();
    const provider = buildGoogleRealtimeVoiceProvider();
    const onClose = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onClose,
    });

    await bridge.connect();
    const firstSession = lastConnectParams().callbacks;
    firstSession.onopen();
    firstSession.onmessage({ setupComplete: { sessionId: "session-1" } });
    connectMock
      .mockRejectedValueOnce(new Error("connect failed 1"))
      .mockRejectedValueOnce(new Error("connect failed 2"))
      .mockRejectedValueOnce(new Error("connect failed 3"))
      .mockResolvedValueOnce(reconnectedSession);
    firstSession.onclose({ code: 1011, reason: "temporary" });
    bridge.sendAudio(Buffer.from([0x01, 0x00]));

    await vi.advanceTimersByTimeAsync(1_750);
    bridge.sendAudio(Buffer.from([0x02, 0x00]));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error");

    await bridge.connect();
    const reconnected = lastConnectParams().callbacks;
    reconnected.onopen();
    reconnected.onmessage({ setupComplete: { sessionId: "session-2" } });
    bridge.sendAudio(Buffer.alloc(480, 0x03));

    expect(reconnectedSession.sendRealtimeInput).toHaveBeenCalledOnce();
    const sent = reconnectedSession.sendRealtimeInput.mock.calls[0]?.[0]?.audio as
      | { data?: unknown }
      | undefined;
    expect(sent?.data).toBeTypeOf("string");
    bridge.close();
  });

  it("does not activate a late session after close during setup", async () => {
    const pendingSession = createDeferred<MockGoogleLiveSession>();
    const lateSession = createMockGoogleLiveSession();
    connectMock.mockReturnValueOnce(pendingSession.promise);
    const provider = buildGoogleRealtimeVoiceProvider();
    const onReady = vi.fn();
    const onClose = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onReady,
      onClose,
    });

    const connect = bridge.connect();
    lastConnectParams().callbacks.onopen();
    lastConnectParams().callbacks.onmessage({ setupComplete: { sessionId: "session-1" } });
    bridge.close();
    await connect;

    expect(onReady).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("completed");
    expect(bridge.isConnected()).toBe(false);

    pendingSession.resolve(lateSession);
    await vi.waitFor(() => {
      expect(lateSession.close).toHaveBeenCalledTimes(1);
    });
    expect(onReady).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes the session when the ready callback rejects activation", async () => {
    const pendingSession = createDeferred<MockGoogleLiveSession>();
    const connectedSession = createMockGoogleLiveSession();
    connectMock.mockReturnValueOnce(pendingSession.promise);
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onReady: () => {
        throw new Error("ready callback failed");
      },
    });

    const connect = bridge.connect();
    lastConnectParams().callbacks.onopen();
    lastConnectParams().callbacks.onmessage({ setupComplete: { sessionId: "session-1" } });
    pendingSession.resolve(connectedSession);

    await expect(connect).rejects.toThrow("ready callback failed");
    expect(connectedSession.close).toHaveBeenCalledTimes(1);
    expect(bridge.isConnected()).toBe(false);
  });

  it("marks the Google audio stream complete after sustained telephony silence", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key", silenceDurationMs: 60 },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await bridge.connect();
    lastConnectParams().callbacks.onopen();
    lastConnectParams().callbacks.onmessage({ setupComplete: { sessionId: "session-1" } });

    const silence20ms = Buffer.alloc(160, 0xff);
    bridge.sendAudio(silence20ms);
    bridge.sendAudio(silence20ms);
    bridge.sendAudio(silence20ms);

    expect(session.sendRealtimeInput).toHaveBeenCalledWith({ audioStreamEnd: true });

    const callsAfterStreamEnd = session.sendRealtimeInput.mock.calls.length;
    bridge.sendAudio(silence20ms);
    expect(session.sendRealtimeInput).toHaveBeenCalledTimes(callsAfterStreamEnd);

    session.sendRealtimeInput.mockClear();
    bridge.sendAudio(Buffer.alloc(160, 0x7f));
    bridge.sendAudio(silence20ms);
    bridge.sendAudio(silence20ms);
    bridge.sendAudio(silence20ms);

    expect(session.sendRealtimeInput).toHaveBeenCalledWith({ audioStreamEnd: true });
  });

  it("fuses telephony mu-law conversion into the Gemini 16 kHz PCM input frame", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await bridge.connect();
    lastConnectParams().callbacks.onopen();
    lastConnectParams().callbacks.onmessage({ setupComplete: { sessionId: "session-1" } });

    bridge.sendAudio(Buffer.from([0xff, 0x00]));

    const audio = sentAudio();
    expect(typeof audio.data).toBe("string");
    expect(audio.mimeType).toBe("audio/pcm;rate=16000");
    const sent = Buffer.from(audio.data as string, "base64");
    expect(Array.from({ length: sent.length / 2 }, (_, i) => sent.readInt16LE(i * 2))).toEqual([
      0, -16062, -32124, -32124,
    ]);
  });

  it("accepts PCM16 24 kHz audio without the telephony mu-law hop", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await bridge.connect();
    lastConnectParams().callbacks.onopen();
    lastConnectParams().callbacks.onmessage({ setupComplete: { sessionId: "session-1" } });

    bridge.sendAudio(Buffer.alloc(480));

    const audio = sentAudio();
    expect(typeof audio.data).toBe("string");
    expect(audio.mimeType).toBe("audio/pcm;rate=16000");
    const sent = Buffer.from(audio.data as string, "base64");
    expect(sent).toHaveLength(320);
  });

  it("can disable automatic VAD for manual activity signaling experiments", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: {
        apiKey: "gemini-key",
        automaticActivityDetectionDisabled: true,
      },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await bridge.connect();

    const config = lastConnectParams().config as {
      realtimeInputConfig?: { automaticActivityDetection?: { disabled?: boolean } };
    };
    expect(config.realtimeInputConfig?.automaticActivityDetection?.disabled).toBe(true);
  });

  it("sends Gemini 3.1 text prompts as realtime input", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await bridge.connect();
    lastConnectParams().callbacks.onopen();
    lastConnectParams().callbacks.onmessage({ setupComplete: { sessionId: "session-1" } });

    bridge.sendUserMessage?.(" Say hello. ");

    expect(session.sendRealtimeInput).toHaveBeenCalledWith({ text: "Say hello." });
    expect(session.sendClientContent).not.toHaveBeenCalled();
  });

  it("keeps ordered client turns for explicit Gemini 2.5 sessions", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: {
        apiKey: "gemini-key",
        model: "gemini-live-2.5-flash-preview",
      },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await bridge.connect();
    lastConnectParams().callbacks.onopen();
    lastConnectParams().callbacks.onmessage({ setupComplete: { sessionId: "session-1" } });

    bridge.sendUserMessage?.(" Say hello. ");

    expect(session.sendClientContent).toHaveBeenCalledWith({
      turns: [{ role: "user", parts: [{ text: "Say hello." }] }],
      turnComplete: true,
    });
  });

  it("converts Google PCM output to mu-law audio", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const onAudio = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio,
      onClearAudio: vi.fn(),
    });
    const pcm24k = Buffer.alloc(480);
    pcm24k.set([0xfb, 0xff]);

    await bridge.connect();
    lastConnectParams().callbacks.onmessage({
      setupComplete: { sessionId: "session-1" },
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: {
                mimeType: "audio/L16;codec=pcm;rate=24000",
                data: pcm24k.toString("base64url"),
              },
            },
          ],
        },
      },
    });

    expect(onAudio).toHaveBeenCalledTimes(1);
    const audio = requireFirstAudio(onAudio);
    expect(audio).toBeInstanceOf(Buffer);
    expect(audio).toHaveLength(80);
  });

  it("can keep Google PCM output as PCM16 24 kHz audio", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const onAudio = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio,
      onClearAudio: vi.fn(),
    });
    const pcm24k = Buffer.alloc(480);

    await bridge.connect();
    lastConnectParams().callbacks.onmessage({
      setupComplete: { sessionId: "session-1" },
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: {
                mimeType: "audio/L16;codec=pcm;rate=24000",
                data: pcm24k.toString("base64"),
              },
            },
          ],
        },
      },
    });

    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(requireFirstAudio(onAudio)).toEqual(pcm24k);
  });

  it.each([
    ["invalid alphabet", "not-base64!"],
    ["non-canonical pad bits", "ZE=="],
    ["mixed alphabet", "aGVsbG8+_"],
  ])("terminates the session for %s in output audio", async (_scenario, data) => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const onAudio = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio,
      onClearAudio: vi.fn(),
      onError,
      onClose,
      onTranscript,
    });

    await bridge.connect();
    lastConnectParams().callbacks.onmessage({
      setupComplete: { sessionId: "session-1" },
      serverContent: {
        outputTranscription: { text: "finalize me" },
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data } }],
        },
      },
    });

    expect(onAudio).not.toHaveBeenCalled();
    expect(onTranscript.mock.calls).toEqual([
      ["assistant", "finalize me", false],
      ["assistant", "finalize me", true],
    ]);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Google Live stream returned malformed base64 audio data",
      }),
    );
    expect(onClose).toHaveBeenCalledWith("error");
    expect(session.close).toHaveBeenCalledTimes(1);
    await expect(bridge.connect()).rejects.toThrow(
      "Google Live stream returned malformed base64 audio data",
    );
  });

  it("uses official output transcription instead of model-turn text", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onTranscript,
    });

    await bridge.connect();
    lastConnectParams().callbacks.onmessage({
      setupComplete: {},
      serverContent: {
        modelTurn: {
          parts: [
            { text: "internal reasoning", thought: true },
            { text: "uncorrelated model text" },
          ],
        },
      },
    });

    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("emits one complete transcript after Google marks a transcription finished", async () => {
    vi.useFakeTimers();
    const provider = buildGoogleRealtimeVoiceProvider();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onTranscript,
    });

    await bridge.connect();
    const onmessage = lastConnectParams().callbacks.onmessage;
    onmessage({ serverContent: { outputTranscription: { text: "Hi, " } } });
    onmessage({
      serverContent: { outputTranscription: { text: "how can I help?", finished: true } },
    });
    onmessage({ serverContent: { modelTurn: { parts: [{ text: "ignored fallback" }] } } });
    onmessage({ serverContent: { turnComplete: true } });

    expect(onTranscript.mock.calls).toEqual([
      ["assistant", "Hi, ", false],
      ["assistant", "how can I help?", false],
      ["assistant", "Hi, how can I help?", true],
    ]);
  });

  it("honors a finish-only transcription message", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onTranscript,
    });

    await bridge.connect();
    const onmessage = lastConnectParams().callbacks.onmessage;
    onmessage({ serverContent: { inputTranscription: { text: "Last words" } } });
    onmessage({ serverContent: { inputTranscription: { finished: true } } });

    expect(onTranscript.mock.calls).toEqual([
      ["user", "Last words", false],
      ["user", "Last words", true],
    ]);
  });

  it("allows each role's UTF-8 transcript limit and releases it on finished", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onTranscript,
    });

    await bridge.connect();
    const onmessage = lastConnectParams().callbacks.onmessage;
    const halfLimit = "é".repeat(64 * 1024);
    onmessage({
      serverContent: {
        inputTranscription: { text: halfLimit },
        outputTranscription: { text: halfLimit },
      },
    });
    onmessage({
      serverContent: {
        inputTranscription: { text: halfLimit },
        outputTranscription: { text: halfLimit },
      },
    });
    onmessage({ serverContent: { outputTranscription: { finished: true } } });
    onmessage({ serverContent: { inputTranscription: { finished: true } } });

    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([
      ["assistant", `${halfLimit}${halfLimit}`, true],
      ["user", `${halfLimit}${halfLimit}`, true],
    ]);
    expect(session.close).not.toHaveBeenCalled();
  });

  it("terminates and clears a runaway transcript stream at the UTF-8 byte limit", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const onError = vi.fn();
    const onClose = vi.fn();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onError,
      onClose,
      onTranscript,
    });

    await bridge.connect();
    const callbacks = lastConnectParams().callbacks;
    const transcriptChunk = "€".repeat(16);
    const acceptedChunks = Math.floor((256 * 1024) / Buffer.byteLength(transcriptChunk, "utf8"));
    for (let index = 0; index < 10_000; index += 1) {
      callbacks.onmessage({
        serverContent: {
          inputTranscription: { text: transcriptChunk },
        },
      });
    }
    callbacks.onclose({ code: 1000, reason: "late clean close", wasClean: true });

    expect(onTranscript).toHaveBeenCalledTimes(acceptedChunks);
    expect(onTranscript.mock.calls.at(-1)).toEqual(["user", transcriptChunk, false]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Google Live transcript exceeded the 256 KiB UTF-8 pending buffer limit",
      }),
    );
    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("error");
    expect(session.close).toHaveBeenCalledTimes(1);
    await expect(bridge.connect()).rejects.toThrow(
      "Google Live transcript exceeded the 256 KiB UTF-8 pending buffer limit",
    );
  });

  it("retains unordered transcript chunks until a protocol terminal or close", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onTranscript,
    });

    await bridge.connect();
    const onmessage = lastConnectParams().callbacks.onmessage;
    onmessage({ serverContent: { inputTranscription: { text: "Earlier question. " } } });
    onmessage({ serverContent: { outputTranscription: { text: "Interrupted response " } } });
    onmessage({ serverContent: { interrupted: true } });
    onmessage({ serverContent: { turnComplete: true } });
    onmessage({
      serverContent: {
        inputTranscription: { text: "New question" },
        outputTranscription: { text: "ending" },
        turnComplete: true,
      },
    });

    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([]);

    bridge.close();
    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([
      ["user", "Earlier question. New question", true],
      ["assistant", "Interrupted response ending", true],
    ]);
  });

  it("flushes pending transcripts when the bridge closes", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onTranscript,
    });

    await bridge.connect();
    lastConnectParams().callbacks.onmessage({
      serverContent: { inputTranscription: { text: "Last words" } },
    });
    bridge.close();

    expect(onTranscript.mock.calls.at(-1)).toEqual(["user", "Last words", true]);
  });

  it("closes the Live session when the final transcript callback throws", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const callbackError = new Error("transcript persistence failed");
    const onError = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onError,
      onTranscript: vi.fn((_role, _text, isFinal) => {
        if (isFinal) {
          throw callbackError;
        }
      }),
    });

    await bridge.connect();
    lastConnectParams().callbacks.onmessage({
      serverContent: { inputTranscription: { text: "Last words" } },
    });

    expect(() => bridge.close()).not.toThrow();
    expect(onError).toHaveBeenCalledWith(callbackError);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("reports provider-confirmed input interruption as barge-in", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const onClearAudio = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio,
    });

    await bridge.connect();
    lastConnectParams().callbacks.onmessage({
      setupComplete: {},
      serverContent: { interrupted: true },
    });

    expect(onClearAudio).toHaveBeenCalledWith("barge-in");
  });

  it("forwards Live API tool calls and submits matching function responses", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const onToolCall = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall,
    });

    await bridge.connect();
    lastConnectParams().callbacks.onmessage({
      setupComplete: { sessionId: "session-1" },
      toolCall: {
        functionCalls: [{ id: "call-1", name: "lookup", args: { query: "hi" } }],
      },
    });

    expect(onToolCall).toHaveBeenCalledWith({
      itemId: "call-1",
      callId: "call-1",
      name: "lookup",
      args: { query: "hi" },
    });

    void bridge.submitToolResult("call-1", { result: "ok" });

    expect(session.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        {
          id: "call-1",
          name: "lookup",
          response: { result: "ok" },
        },
      ],
    });
  });

  it("deduplicates replayed Google Live tool calls by call id", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const onToolCall = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall,
    });

    await bridge.connect();
    const callbacks = lastConnectParams().callbacks;
    callbacks.onmessage({
      toolCall: {
        functionCalls: [{ id: "call-1", name: "lookup", args: { query: "first" } }],
      },
    });
    callbacks.onmessage({
      toolCall: {
        functionCalls: [{ id: "call-1", name: "different", args: { query: "replay" } }],
      },
    });

    expect(onToolCall).toHaveBeenCalledOnce();
    void bridge.submitToolResult("call-1", { result: "ok" });
    expect(session.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        {
          id: "call-1",
          name: "lookup",
          response: { result: "ok" },
        },
      ],
    });
    callbacks.onmessage({
      toolCall: {
        functionCalls: [{ id: "call-1", name: "lookup", args: { query: "late replay" } }],
      },
    });
    expect(onToolCall).toHaveBeenCalledOnce();
  });

  it("ignores late results after Google cancels a tool call", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const onEvent = vi.fn();
    const onError = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall: vi.fn(),
      onEvent,
      onError,
    });

    await bridge.connect();
    const callbacks = lastConnectParams().callbacks;
    callbacks.onmessage({
      toolCall: {
        functionCalls: [{ id: "call-1", name: "lookup", args: { query: "hi" } }],
      },
    });
    callbacks.onmessage({
      toolCallCancellation: { ids: ["call-1"] },
    });

    void bridge.submitToolResult("call-1", { result: "late" });

    expect(session.sendToolResponse).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "tool.call.cancelled",
      itemId: "call-1",
    });
  });

  it("fails closed when Google exceeds the tool-call session limit", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const onToolCall = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall,
      onError,
      onClose,
    });

    await bridge.connect();
    lastConnectParams().callbacks.onmessage({
      toolCall: {
        functionCalls: Array.from({ length: 1_025 }, (_, index) => ({
          id: `call-${index}`,
          name: "lookup",
          args: {},
        })),
      },
    });

    expect(onToolCall).toHaveBeenCalledTimes(1_024);
    expect(requireFirstError(onError).message).toBe("Google Live tool-call session limit exceeded");
    expect(session.close).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error");
  });

  it("keeps Google Live consult calls open after continuing tool responses", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: {
        apiKey: "gemini-key",
        model: "gemini-live-2.5-flash-preview",
      },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall: vi.fn(),
    });

    await bridge.connect();
    lastConnectParams().callbacks.onmessage({
      setupComplete: { sessionId: "session-1" },
      toolCall: {
        functionCalls: [
          { id: "consult-call", name: "openclaw_agent_consult", args: { prompt: "hi" } },
        ],
      },
    });

    void bridge.submitToolResult(
      "consult-call",
      { status: "working", message: "Tell the participant you are checking." },
      { willContinue: true },
    );
    void bridge.submitToolResult("consult-call", { text: "The meeting starts at 3." });

    expect(session.sendToolResponse).toHaveBeenNthCalledWith(1, {
      functionResponses: [
        {
          id: "consult-call",
          name: "openclaw_agent_consult",
          scheduling: "WHEN_IDLE",
          willContinue: true,
          response: { status: "working", message: "Tell the participant you are checking." },
        },
      ],
    });
    expect(session.sendToolResponse).toHaveBeenNthCalledWith(2, {
      functionResponses: [
        {
          id: "consult-call",
          name: "openclaw_agent_consult",
          scheduling: "WHEN_IDLE",
          response: { text: "The meeting starts at 3." },
        },
      ],
    });
  });

  it("keeps Gemini 3.1 consult calls pending after rejecting continuation", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const onError = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onToolCall: vi.fn(),
      onError,
    });

    await bridge.connect();
    lastConnectParams().callbacks.onmessage({
      setupComplete: { sessionId: "session-1" },
      toolCall: {
        functionCalls: [
          { id: "consult-call", name: "openclaw_agent_consult", args: { prompt: "hi" } },
        ],
      },
    });

    void bridge.submitToolResult("consult-call", { status: "working" }, { willContinue: true });
    expect(session.sendToolResponse).not.toHaveBeenCalled();
    expect(requireFirstError(onError).message).toContain(
      "does not support continuing tool responses",
    );

    void bridge.submitToolResult("consult-call", { text: "The meeting starts at 3." });

    expect(session.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        {
          id: "consult-call",
          name: "openclaw_agent_consult",
          response: { text: "The meeting starts at 3." },
        },
      ],
    });
  });

  it("does not send malformed Live API tool responses without a matching call name", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const onError = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onError,
    });

    await bridge.connect();

    void bridge.submitToolResult("missing-call", { result: "ok" });

    expect(session.sendToolResponse).not.toHaveBeenCalled();
    const error = requireFirstError(onError);
    expect(error.message).toBe(
      "Google Live function response is missing a matching function call for missing-call",
    );
  });

  it("reports Google Live tool response send failures without losing the call name", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const onError = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onError,
    });

    await bridge.connect();
    lastConnectParams().callbacks.onmessage({
      setupComplete: { sessionId: "session-1" },
      toolCall: {
        functionCalls: [{ id: "call-1", name: "lookup", args: { query: "hi" } }],
      },
    });

    const sendError = new Error("SDK send failed");
    session.sendToolResponse.mockImplementationOnce(() => {
      throw sendError;
    });

    void bridge.submitToolResult("call-1", ["retryable"]);

    expect(onError).toHaveBeenCalledWith(sendError);

    void bridge.submitToolResult("call-1", { result: "ok" });

    expect(session.sendToolResponse).toHaveBeenLastCalledWith({
      functionResponses: [
        {
          id: "call-1",
          name: "lookup",
          response: { result: "ok" },
        },
      ],
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
