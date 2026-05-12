import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
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
  const session: MockGoogleLiveSession = {
    close: vi.fn(),
    sendClientContent: vi.fn(),
    sendRealtimeInput: vi.fn(),
    sendToolResponse: vi.fn(),
  };
  const connectMock = vi.fn(async (_params: MockGoogleLiveConnectParams) => session);
  const createTokenMock = vi.fn(async (_params: unknown) => ({
    name: "auth_tokens/browser-session",
  }));
  return { connectMock, createTokenMock, session };
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
      supportsToolCalls: true,
      supportsVideoFrames: true,
      supportsSessionResumption: true,
    });
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
          parametersJsonSchema?: unknown;
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
    expect(declarations[0]?.parametersJsonSchema).toEqual({
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    });
    expect(declarations[1]?.name).toBe("openclaw_agent_consult");
    expect(declarations[1]?.description).toBe("Ask OpenClaw");
    expect(declarations[1]?.parametersJsonSchema).toEqual({
      type: "object",
      properties: {
        question: { type: "string" },
      },
      required: ["question"],
    });
    expect(declarations[1]?.behavior).toBe("NON_BLOCKING");
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

  it("creates constrained browser sessions for Google Live Talk", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();

    const session = await provider.createBrowserSession?.({
      providerConfig: {
        apiKey: "gemini-key",
        model: "gemini-live-2.5-flash-preview",
        voice: "Puck",
        temperature: 0.4,
      },
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
            responseModalities?: string[];
            speechConfig?: { voiceConfig?: { prebuiltVoiceConfig?: { voiceName?: string } } };
            systemInstruction?: string;
            temperature?: number;
            tools?: Array<{ functionDeclarations?: Array<{ behavior?: string; name?: string }> }>;
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
    expect(liveConstraints?.config?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe(
      "Puck",
    );
    expect(liveConstraints?.config?.tools?.[0]?.functionDeclarations?.[0]?.name).toBe(
      "openclaw_agent_consult",
    );
    expect(liveConstraints?.config?.tools?.[0]?.functionDeclarations?.[0]?.behavior).toBe(
      "NON_BLOCKING",
    );
    expect(session?.provider).toBe("google");
    expect(session?.transport).toBe("provider-websocket");
    const websocketSession = session as {
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

  it("captures Google Live resumption handles and reuses them on reconnect", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await bridge.connect();
    lastConnectParams().callbacks.onmessage({
      sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
    });

    await bridge.connect();

    expect(lastConnectParams().config.sessionResumption).toEqual({ handle: "resume-1" });
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

  it("sends text prompts as ordered client turns", async () => {
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

  it("does not forward Google thought text as assistant transcript", async () => {
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
          parts: [{ text: "internal reasoning", thought: true }],
        },
      },
    });

    expect(onTranscript).not.toHaveBeenCalled();
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

    bridge.submitToolResult("call-1", { result: "ok" });

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
      providerConfig: { apiKey: "gemini-key" },
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

    bridge.submitToolResult(
      "consult-call",
      { status: "working", message: "Tell the participant you are checking." },
      { willContinue: true },
    );
    bridge.submitToolResult("consult-call", { text: "The meeting starts at 3." });

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

    bridge.submitToolResult("missing-call", { result: "ok" });

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

    bridge.submitToolResult("call-1", ["retryable"]);

    expect(onError).toHaveBeenCalledWith(sendError);

    bridge.submitToolResult("call-1", { result: "ok" });

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
