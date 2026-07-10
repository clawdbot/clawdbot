// Google tests cover realtime voice provider plugin behavior.
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
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

const { connectMock, createTokenMock, session } = vi.hoisted(() => {
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
  return {
    connectMock: connectMockLocal,
    createTokenMock: createTokenMockLocal,
    session: sessionValue,
  };
});

vi.mock("./google-genai-runtime.js", () => ({
  createGoogleGenAI: vi.fn(() => ({
    authTokens: {
      create: createTokenMock,
    },
    live: {
      connect: connectMock,
    },
  })),
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

describe("buildGoogleRealtimeVoiceProvider", () => {
  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    connectMock.mockClear();
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

  it("preserves transcript fragments while reusing a resumption handle", async () => {
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
      sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
      serverContent: { inputTranscription: { text: "Before " } },
    });

    await bridge.connect();
    lastConnectParams().callbacks.onmessage({
      serverContent: { inputTranscription: { text: "after", finished: true } },
    });

    expect(lastConnectParams().config.sessionResumption).toEqual({ handle: "resume-1" });
    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([
      ["user", "Before after", true],
    ]);
  });

  it("drops unfinished hypotheses when a new session has no continuity", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key", sessionResumption: false },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onTranscript,
    });

    await bridge.connect();
    lastConnectParams().callbacks.onmessage({
      serverContent: { inputTranscription: { text: "Old fragment " } },
    });

    await bridge.connect();
    lastConnectParams().callbacks.onmessage({
      serverContent: { inputTranscription: { text: "New turn", finished: true } },
    });

    expect(onTranscript.mock.calls.filter((call) => call[2] === true)).toEqual([
      ["user", "New turn", true],
    ]);
  });

  it("reconnects unexpected Google Live closes with the latest resumption handle", async () => {
    vi.useFakeTimers();
    try {
      const provider = buildGoogleRealtimeVoiceProvider();
      const onClose = vi.fn();
      const onError = vi.fn();
      const bridge = provider.createBridge({
        providerConfig: { apiKey: "gemini-key" },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        onClose,
        onError,
      });

      await bridge.connect();
      lastConnectParams().callbacks.onmessage({
        setupComplete: { sessionId: "session-1" },
        sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
      });
      lastConnectParams().callbacks.onmessage({
        sessionResumptionUpdate: { resumable: false },
      });
      lastConnectParams().callbacks.onclose({
        code: 1011,
        reason: "temporary upstream close",
        wasClean: false,
      });

      expect(onClose).not.toHaveBeenCalled();
      const error = requireFirstError(onError);
      expect(error.message).toContain("reconnecting 1/3");

      await vi.advanceTimersByTimeAsync(250);

      expect(connectMock).toHaveBeenCalledTimes(2);
      expect(lastConnectParams().config.sessionResumption).toEqual({ handle: "resume-1" });
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

  it("waits for setup completion before draining audio and firing ready", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const onReady = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onReady,
    });

    await bridge.connect();
    lastConnectParams().callbacks.onopen();
    bridge.sendAudio(Buffer.from([0xff, 0xff]));

    expect(session.sendRealtimeInput).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();

    lastConnectParams().callbacks.onmessage({ setupComplete: { sessionId: "session-1" } });

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(session.sendRealtimeInput).toHaveBeenCalledTimes(1);
    const audio = sentAudio();
    expect(typeof audio.data).toBe("string");
    expect(audio.mimeType).toBe("audio/pcm;rate=16000");
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
