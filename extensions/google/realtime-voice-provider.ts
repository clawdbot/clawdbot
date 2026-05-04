import { randomUUID } from "node:crypto";
import type {
  ActivityHandling,
  Behavior,
  EndSensitivity,
  FunctionDeclaration,
  FunctionResponse,
  FunctionResponseScheduling,
  LiveConnectConfig,
  LiveServerContent,
  LiveServerMessage,
  LiveServerToolCall,
  Modality,
  RealtimeInputConfig,
  StartSensitivity,
  ThinkingConfig,
  TurnCoverage,
} from "@google/genai";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBridge,
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceTool,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  convertPcmToMulaw8k,
  mulawToPcm,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resamplePcm,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { createGoogleGenAI } from "./google-genai-runtime.js";

const GOOGLE_REALTIME_DEFAULT_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
const GOOGLE_REALTIME_DEFAULT_VOICE = "Kore";
const GOOGLE_REALTIME_DEFAULT_API_VERSION = "v1beta";
const GOOGLE_REALTIME_INPUT_SAMPLE_RATE = 16_000;
const GOOGLE_REALTIME_BROWSER_API_VERSION = "v1alpha";
const GOOGLE_REALTIME_BROWSER_WEBSOCKET_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
const MAX_PENDING_AUDIO_CHUNKS = 320;
const DEFAULT_AUDIO_STREAM_END_SILENCE_MS = 500;
const GOOGLE_REALTIME_BROWSER_SESSION_TTL_MS = 30 * 60 * 1000;
const GOOGLE_REALTIME_BROWSER_NEW_SESSION_TTL_MS = 60 * 1000;
const MULAW_LINEAR_SAMPLES = new Int16Array(256);

for (let i = 0; i < MULAW_LINEAR_SAMPLES.length; i += 1) {
  MULAW_LINEAR_SAMPLES[i] = decodeMulawSample(i);
}

type GoogleRealtimeSensitivity = "low" | "high";
type GoogleRealtimeThinkingLevel = "minimal" | "low" | "medium" | "high";
type GoogleRealtimeActivityHandling = "start-of-activity-interrupts" | "no-interruption";
type GoogleRealtimeTurnCoverage = "only-activity" | "all-input" | "audio-activity-and-all-video";

type GoogleRealtimeVoiceProviderConfig = {
  apiKey?: string;
  model?: string;
  voice?: string;
  temperature?: number;
  apiVersion?: string;
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
  startSensitivity?: GoogleRealtimeSensitivity;
  endSensitivity?: GoogleRealtimeSensitivity;
  activityHandling?: GoogleRealtimeActivityHandling;
  turnCoverage?: GoogleRealtimeTurnCoverage;
  automaticActivityDetectionDisabled?: boolean;
  enableAffectiveDialog?: boolean;
  sessionResumption?: boolean;
  contextWindowCompression?: boolean;
  thinkingLevel?: GoogleRealtimeThinkingLevel;
  thinkingBudget?: number;
};

type GoogleRealtimeLiveConfig = {
  apiKey: string;
  instructions?: string;
  tools?: RealtimeVoiceTool[];
  model?: string;
  voice?: string;
  temperature?: number;
  apiVersion?: string;
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
  startSensitivity?: GoogleRealtimeSensitivity;
  endSensitivity?: GoogleRealtimeSensitivity;
  activityHandling?: GoogleRealtimeActivityHandling;
  turnCoverage?: GoogleRealtimeTurnCoverage;
  automaticActivityDetectionDisabled?: boolean;
  enableAffectiveDialog?: boolean;
  sessionResumption?: boolean;
  contextWindowCompression?: boolean;
  thinkingLevel?: GoogleRealtimeThinkingLevel;
  thinkingBudget?: number;
};

type GoogleRealtimeVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest & GoogleRealtimeLiveConfig;

type GoogleLiveSession = {
  sendClientContent: (params: {
    turns?: Array<{ role: string; parts: Array<{ text: string }> }>;
    turnComplete?: boolean;
  }) => void;
  sendRealtimeInput: (params: {
    audio?: { data: string; mimeType: string };
    audioStreamEnd?: boolean;
  }) => void;
  sendToolResponse: (params: { functionResponses: FunctionResponse[] | FunctionResponse }) => void;
  close: () => void;
};

function trimToUndefined(value: unknown): string | undefined {
  return normalizeOptionalString(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asSensitivity(value: unknown): GoogleRealtimeSensitivity | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return normalized === "low" || normalized === "high" ? normalized : undefined;
}

function asThinkingLevel(value: unknown): GoogleRealtimeThinkingLevel | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
    ? normalized
    : undefined;
}

function asActivityHandling(value: unknown): GoogleRealtimeActivityHandling | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase().replaceAll("_", "-");
  switch (normalized) {
    case "start-of-activity-interrupts":
    case "start-of-activity-interrupt":
    case "interrupt":
    case "interrupts":
      return "start-of-activity-interrupts";
    case "no-interruption":
    case "no-interruptions":
    case "none":
      return "no-interruption";
    default:
      return undefined;
  }
}

function asTurnCoverage(value: unknown): GoogleRealtimeTurnCoverage | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase().replaceAll("_", "-");
  switch (normalized) {
    case "only-activity":
    case "turn-includes-only-activity":
      return "only-activity";
    case "all-input":
    case "turn-includes-all-input":
      return "all-input";
    case "audio-activity-and-all-video":
    case "turn-includes-audio-activity-and-all-video":
      return "audio-activity-and-all-video";
    default:
      return undefined;
  }
}

function resolveGoogleRealtimeProviderConfigRecord(
  config: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const providers =
    typeof config.providers === "object" &&
    config.providers !== null &&
    !Array.isArray(config.providers)
      ? (config.providers as Record<string, unknown>)
      : undefined;
  const nested = providers?.google;
  return typeof nested === "object" && nested !== null && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : typeof config.google === "object" && config.google !== null && !Array.isArray(config.google)
      ? (config.google as Record<string, unknown>)
      : config;
}

function normalizeProviderConfig(
  config: RealtimeVoiceProviderConfig,
  cfg?: OpenClawConfig,
): GoogleRealtimeVoiceProviderConfig {
  const raw = resolveGoogleRealtimeProviderConfigRecord(config);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey ?? cfg?.models?.providers?.google?.apiKey,
      path: "plugins.entries.voice-call.config.realtime.providers.google.apiKey",
    }),
    model: trimToUndefined(raw?.model),
    voice: trimToUndefined(raw?.voice),
    temperature: asFiniteNumber(raw?.temperature),
    apiVersion: trimToUndefined(raw?.apiVersion),
    prefixPaddingMs: asFiniteNumber(raw?.prefixPaddingMs),
    silenceDurationMs: asFiniteNumber(raw?.silenceDurationMs),
    startSensitivity: asSensitivity(raw?.startSensitivity),
    endSensitivity: asSensitivity(raw?.endSensitivity),
    activityHandling: asActivityHandling(raw?.activityHandling),
    turnCoverage: asTurnCoverage(raw?.turnCoverage),
    automaticActivityDetectionDisabled: asBoolean(raw?.automaticActivityDetectionDisabled),
    enableAffectiveDialog: asBoolean(raw?.enableAffectiveDialog),
    sessionResumption: asBoolean(raw?.sessionResumption),
    contextWindowCompression: asBoolean(raw?.contextWindowCompression),
    thinkingLevel: asThinkingLevel(raw?.thinkingLevel),
    thinkingBudget: asFiniteNumber(raw?.thinkingBudget),
  };
}

function resolveEnvApiKey(): string | undefined {
  return trimToUndefined(process.env.GEMINI_API_KEY) ?? trimToUndefined(process.env.GOOGLE_API_KEY);
}

function mapStartSensitivity(
  value: GoogleRealtimeSensitivity | undefined,
): StartSensitivity | undefined {
  switch (value) {
    case "high":
      return "START_SENSITIVITY_HIGH" as StartSensitivity;
    case "low":
      return "START_SENSITIVITY_LOW" as StartSensitivity;
    default:
      return undefined;
  }
}

function mapEndSensitivity(
  value: GoogleRealtimeSensitivity | undefined,
): EndSensitivity | undefined {
  switch (value) {
    case "high":
      return "END_SENSITIVITY_HIGH" as EndSensitivity;
    case "low":
      return "END_SENSITIVITY_LOW" as EndSensitivity;
    default:
      return undefined;
  }
}

function mapActivityHandling(
  value: GoogleRealtimeActivityHandling | undefined,
): ActivityHandling | undefined {
  switch (value) {
    case "no-interruption":
      return "NO_INTERRUPTION" as ActivityHandling;
    case "start-of-activity-interrupts":
      return "START_OF_ACTIVITY_INTERRUPTS" as ActivityHandling;
    default:
      return undefined;
  }
}

function mapTurnCoverage(value: GoogleRealtimeTurnCoverage | undefined): TurnCoverage | undefined {
  switch (value) {
    case "only-activity":
      return "TURN_INCLUDES_ONLY_ACTIVITY" as TurnCoverage;
    case "all-input":
      return "TURN_INCLUDES_ALL_INPUT" as TurnCoverage;
    case "audio-activity-and-all-video":
      return "TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO" as TurnCoverage;
    default:
      return undefined;
  }
}

function buildThinkingConfig(config: GoogleRealtimeLiveConfig): ThinkingConfig | undefined {
  if (config.thinkingLevel) {
    return { thinkingLevel: config.thinkingLevel.toUpperCase() as ThinkingConfig["thinkingLevel"] };
  }
  if (typeof config.thinkingBudget === "number") {
    return { thinkingBudget: config.thinkingBudget };
  }
  return undefined;
}

function buildRealtimeInputConfig(
  config: GoogleRealtimeLiveConfig,
): RealtimeInputConfig | undefined {
  const startSensitivity = mapStartSensitivity(config.startSensitivity);
  const endSensitivity = mapEndSensitivity(config.endSensitivity);
  const activityHandling = mapActivityHandling(config.activityHandling);
  const turnCoverage = mapTurnCoverage(config.turnCoverage);
  const automaticActivityDetection = {
    ...(typeof config.automaticActivityDetectionDisabled === "boolean"
      ? { disabled: config.automaticActivityDetectionDisabled }
      : {}),
    ...(startSensitivity ? { startOfSpeechSensitivity: startSensitivity } : {}),
    ...(endSensitivity ? { endOfSpeechSensitivity: endSensitivity } : {}),
    ...(typeof config.prefixPaddingMs === "number"
      ? { prefixPaddingMs: Math.max(0, Math.floor(config.prefixPaddingMs)) }
      : {}),
    ...(typeof config.silenceDurationMs === "number"
      ? { silenceDurationMs: Math.max(0, Math.floor(config.silenceDurationMs)) }
      : {}),
  };
  const realtimeInputConfig = {
    ...(Object.keys(automaticActivityDetection).length > 0 ? { automaticActivityDetection } : {}),
    ...(activityHandling ? { activityHandling } : {}),
    ...(turnCoverage ? { turnCoverage } : {}),
  };
  return Object.keys(realtimeInputConfig).length > 0 ? realtimeInputConfig : undefined;
}

function buildFunctionDeclarations(tools: RealtimeVoiceTool[] | undefined): FunctionDeclaration[] {
  return (tools ?? []).map((tool) => {
    const declaration: FunctionDeclaration = {
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.parameters,
    };
    if (tool.name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      declaration.behavior = "NON_BLOCKING" as Behavior;
    }
    return declaration;
  });
}

function buildGoogleLiveConnectConfig(config: GoogleRealtimeLiveConfig): LiveConnectConfig {
  const functionDeclarations = buildFunctionDeclarations(config.tools);
  const realtimeInputConfig = buildRealtimeInputConfig(config);
  const thinkingConfig = buildThinkingConfig(config);
  return {
    responseModalities: ["AUDIO" as Modality],
    ...(typeof config.temperature === "number" && config.temperature > 0
      ? { temperature: config.temperature }
      : {}),
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: config.voice ?? GOOGLE_REALTIME_DEFAULT_VOICE,
        },
      },
    },
    systemInstruction: config.instructions,
    ...(functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {}),
    ...(realtimeInputConfig ? { realtimeInputConfig } : {}),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    ...(typeof config.enableAffectiveDialog === "boolean"
      ? { enableAffectiveDialog: config.enableAffectiveDialog }
      : {}),
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };
}

function toGoogleModelResource(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

function buildBrowserInitialSetup(model: string) {
  return {
    setup: {
      model: toGoogleModelResource(model),
      generationConfig: {
        responseModalities: ["AUDIO" as Modality],
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

function parsePcmSampleRate(mimeType: string | undefined): number {
  const match = mimeType?.match(/(?:^|[;,\s])rate=(\d+)/i);
  const parsed = match ? Number.parseInt(match[1] ?? "", 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24_000;
}

function isMulawSilence(audio: Buffer): boolean {
  return audio.length > 0 && audio.every((sample) => sample === 0xff);
}

function isPcm16Silence(audio: Buffer): boolean {
  const samples = Math.floor(audio.length / 2);
  if (samples === 0) {
    return false;
  }
  for (let i = 0; i < samples; i += 1) {
    if (audio.readInt16LE(i * 2) !== 0) {
      return false;
    }
  }
  return true;
}

class GoogleRealtimeVoiceBridge implements RealtimeVoiceBridge {
  readonly supportsToolResultContinuation = true;

  private session: GoogleLiveSession | null = null;
  private connected = false;
  private sessionConfigured = false;
  private intentionallyClosed = false;
  private pendingAudio: Buffer[] = [];
  private sessionReadyFired = false;
  private consecutiveSilenceMs = 0;
  private audioStreamEnded = false;
  private pendingFunctionNames = new Map<string, string>();
  private readonly audioFormat: RealtimeVoiceAudioFormat;
  private resumptionHandle: string | undefined;

  constructor(private readonly config: GoogleRealtimeVoiceBridgeConfig) {
    this.audioFormat = config.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ;
  }

  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    this.sessionConfigured = false;
    this.sessionReadyFired = false;
    this.consecutiveSilenceMs = 0;
    this.audioStreamEnded = false;
    this.pendingFunctionNames.clear();

    const ai = createGoogleGenAI({
      apiKey: this.config.apiKey,
      httpOptions: {
        apiVersion: this.config.apiVersion ?? GOOGLE_REALTIME_DEFAULT_API_VERSION,
      },
    });

    this.session = (await ai.live.connect({
      model: this.config.model ?? GOOGLE_REALTIME_DEFAULT_MODEL,
      config: {
        ...buildGoogleLiveConnectConfig(this.config),
        ...(this.config.sessionResumption === false
          ? {}
          : {
              sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {},
            }),
        ...(this.config.contextWindowCompression === false
          ? {}
          : { contextWindowCompression: { slidingWindow: {} } }),
      },
      callbacks: {
        onopen: () => {
          this.connected = true;
        },
        onmessage: (message) => {
          this.handleMessage(message);
        },
        onerror: (event) => {
          const error =
            event.error instanceof Error
              ? event.error
              : new Error(
                  typeof event.message === "string" ? event.message : "Google Live API error",
                );
          this.config.onError?.(error);
        },
        onclose: () => {
          this.connected = false;
          this.sessionConfigured = false;
          this.pendingFunctionNames.clear();
          const reason = this.intentionallyClosed ? "completed" : "error";
          this.session = null;
          this.config.onClose?.(reason);
        },
      },
    })) as GoogleLiveSession;
  }

  sendAudio(audio: Buffer): void {
    if (!this.session || !this.connected || !this.sessionConfigured) {
      if (this.pendingAudio.length < MAX_PENDING_AUDIO_CHUNKS) {
        this.pendingAudio.push(audio);
      }
      return;
    }
    const silent = this.isSilence(audio);
    if (silent && this.audioStreamEnded) {
      return;
    }
    if (!silent) {
      this.consecutiveSilenceMs = 0;
      this.audioStreamEnded = false;
    }

    const pcm16k = this.toGoogleInputPcm16k(audio);
    this.session.sendRealtimeInput({
      audio: {
        data: pcm16k.toString("base64"),
        mimeType: `audio/pcm;rate=${GOOGLE_REALTIME_INPUT_SAMPLE_RATE}`,
      },
    });

    if (!silent) {
      return;
    }

    const silenceThresholdMs =
      typeof this.config.silenceDurationMs === "number"
        ? Math.max(0, Math.floor(this.config.silenceDurationMs))
        : DEFAULT_AUDIO_STREAM_END_SILENCE_MS;
    const bytesPerSample = this.audioFormat.encoding === "pcm16" ? 2 : 1;
    this.consecutiveSilenceMs += Math.round(
      (audio.length / bytesPerSample / this.audioFormat.sampleRateHz) * 1000,
    );
    if (!this.audioStreamEnded && this.consecutiveSilenceMs >= silenceThresholdMs) {
      this.session.sendRealtimeInput({ audioStreamEnd: true });
      this.audioStreamEnded = true;
    }
  }

  setMediaTimestamp(_ts: number): void {}

  sendUserMessage(text: string): void {
    const normalized = text.trim();
    if (!normalized || !this.session || !this.connected || !this.sessionConfigured) {
      return;
    }
    this.session.sendClientContent({
      turns: [{ role: "user", parts: [{ text: normalized }] }],
      turnComplete: true,
    });
  }

  triggerGreeting(instructions?: string): void {
    const greetingPrompt =
      instructions?.trim() || "Start the call now. Greet the caller naturally and keep it brief.";
    this.sendUserMessage(greetingPrompt);
  }

  submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    if (!this.session) {
      return;
    }
    const name = this.pendingFunctionNames.get(callId);
    if (!name) {
      this.config.onError?.(
        new Error(
          `Google Live function response is missing a matching function call for ${callId}`,
        ),
      );
      return;
    }
    try {
      const isConsultTool = name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME;
      const functionResponse: FunctionResponse = {
        id: callId,
        name,
        response:
          result && typeof result === "object" && !Array.isArray(result)
            ? (result as Record<string, unknown>)
            : { output: result },
      };
      if (isConsultTool) {
        functionResponse.scheduling = "WHEN_IDLE" as FunctionResponseScheduling;
        if (options?.willContinue === true) {
          functionResponse.willContinue = true;
        }
      } else if (options?.willContinue === true) {
        this.config.onError?.(
          new Error(
            `Google Live continuation is only supported for ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME}`,
          ),
        );
        return;
      }
      this.session.sendToolResponse({
        functionResponses: [functionResponse],
      });
      if (options?.willContinue !== true) {
        this.pendingFunctionNames.delete(callId);
      }
    } catch (error) {
      this.config.onError?.(
        error instanceof Error ? error : new Error("Failed to send Google Live function response"),
      );
    }
  }

  acknowledgeMark(): void {}

  close(): void {
    this.intentionallyClosed = true;
    this.connected = false;
    this.sessionConfigured = false;
    this.pendingAudio = [];
    this.consecutiveSilenceMs = 0;
    this.audioStreamEnded = false;
    this.pendingFunctionNames.clear();
    const session = this.session;
    this.session = null;
    session?.close();
  }

  isConnected(): boolean {
    return this.connected && this.sessionConfigured;
  }

  private isSilence(audio: Buffer): boolean {
    return this.audioFormat.encoding === "pcm16" ? isPcm16Silence(audio) : isMulawSilence(audio);
  }

  private toInputPcm(audio: Buffer): Buffer {
    return this.audioFormat.encoding === "pcm16" ? audio : mulawToPcm(audio);
  }

  private toGoogleInputPcm16k(audio: Buffer): Buffer {
    if (
      this.audioFormat.encoding === "g711_ulaw" &&
      this.audioFormat.sampleRateHz === 8_000 &&
      GOOGLE_REALTIME_INPUT_SAMPLE_RATE === 16_000
    ) {
      return convertMulaw8kToPcm16k(audio);
    }
    return resamplePcm(
      this.toInputPcm(audio),
      this.audioFormat.sampleRateHz,
      GOOGLE_REALTIME_INPUT_SAMPLE_RATE,
    );
  }

  private toOutputAudio(pcm: Buffer, sampleRate: number): Buffer {
    return this.audioFormat.encoding === "pcm16"
      ? resamplePcm(pcm, sampleRate, this.audioFormat.sampleRateHz)
      : convertPcmToMulaw8k(pcm, sampleRate);
  }

  private handleMessage(message: LiveServerMessage): void {
    this.captureSessionLifecycle(message);
    if (message.setupComplete) {
      this.handleSetupComplete();
    }
    if (message.serverContent) {
      this.handleServerContent(message.serverContent);
    }
    if (message.toolCall) {
      this.handleToolCall(message.toolCall);
    }
  }

  private captureSessionLifecycle(message: LiveServerMessage): void {
    const raw = message as unknown as {
      goAway?: { timeLeft?: string };
      sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
    };
    const update = raw.sessionResumptionUpdate;
    if (update?.resumable && update.newHandle) {
      this.resumptionHandle = update.newHandle;
    }
    if (raw.goAway?.timeLeft) {
      this.config.onError?.(new Error(`Google Live session goAway: ${raw.goAway.timeLeft}`));
    }
  }

  private handleSetupComplete(): void {
    this.sessionConfigured = true;
    for (const chunk of this.pendingAudio.splice(0)) {
      this.sendAudio(chunk);
    }
    if (!this.sessionReadyFired) {
      this.sessionReadyFired = true;
      this.config.onReady?.();
    }
  }

  private handleServerContent(content: LiveServerContent): void {
    if (content.interrupted) {
      this.config.onClearAudio();
    }

    if (content.inputTranscription?.text) {
      this.config.onTranscript?.(
        "user",
        content.inputTranscription.text,
        content.inputTranscription.finished ?? false,
      );
    }

    if (content.outputTranscription?.text) {
      this.config.onTranscript?.(
        "assistant",
        content.outputTranscription.text,
        content.outputTranscription.finished ?? false,
      );
    }

    let emittedAssistantText = false;
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        const pcm = Buffer.from(part.inlineData.data, "base64");
        const sampleRate = parsePcmSampleRate(part.inlineData.mimeType);
        const audio = this.toOutputAudio(pcm, sampleRate);
        if (audio.length > 0) {
          this.config.onAudio(audio);
          this.config.onMark?.(`audio-${randomUUID()}`);
        }
        continue;
      }
      if (part.thought) {
        continue;
      }
      if (!content.outputTranscription?.text && typeof part.text === "string" && part.text.trim()) {
        emittedAssistantText = true;
        this.config.onTranscript?.("assistant", part.text, content.turnComplete ?? false);
      }
    }

    if (!emittedAssistantText && content.turnComplete && content.waitingForInput === false) {
      return;
    }
  }

  private handleToolCall(toolCall: LiveServerToolCall): void {
    for (const call of toolCall.functionCalls ?? []) {
      const name = call.name?.trim();
      if (!name) {
        continue;
      }
      const callId = call.id?.trim() || `google-live-${randomUUID()}`;
      this.pendingFunctionNames.set(callId, name);
      this.config.onToolCall?.({
        itemId: callId,
        callId,
        name,
        args: call.args ?? {},
      });
    }
  }
}

function convertMulaw8kToPcm16k(muLaw: Buffer): Buffer {
  if (muLaw.length === 0) {
    return Buffer.alloc(0);
  }
  const pcm = Buffer.alloc(muLaw.length * 4);
  for (let i = 0; i < muLaw.length; i += 1) {
    const current = MULAW_LINEAR_SAMPLES[muLaw[i] ?? 0] ?? 0;
    const next = MULAW_LINEAR_SAMPLES[muLaw[i + 1] ?? muLaw[i] ?? 0] ?? current;
    pcm.writeInt16LE(current, i * 4);
    pcm.writeInt16LE(Math.round((current + next) / 2), i * 4 + 2);
  }
  return pcm;
}

function decodeMulawSample(value: number): number {
  const muLaw = ~value & 0xff;
  const sign = muLaw & 0x80;
  const exponent = (muLaw >> 4) & 0x07;
  const mantissa = muLaw & 0x0f;
  let sample = ((mantissa << 3) + 132) << exponent;
  sample -= 132;
  return sign ? -sample : sample;
}

async function createGoogleRealtimeBrowserSession(
  req: RealtimeVoiceBrowserSessionCreateRequest,
): Promise<RealtimeVoiceBrowserSession> {
  const config = normalizeProviderConfig(req.providerConfig);
  const apiKey = config.apiKey || resolveEnvApiKey();
  if (!apiKey) {
    throw new Error("Google Gemini API key missing");
  }

  const model = req.model ?? config.model ?? GOOGLE_REALTIME_DEFAULT_MODEL;
  const voice = req.voice ?? config.voice ?? GOOGLE_REALTIME_DEFAULT_VOICE;
  const expiresAtMs = Date.now() + GOOGLE_REALTIME_BROWSER_SESSION_TTL_MS;
  const newSessionExpiresAtMs = Date.now() + GOOGLE_REALTIME_BROWSER_NEW_SESSION_TTL_MS;
  const ai = createGoogleGenAI({
    apiKey,
    httpOptions: {
      apiVersion: GOOGLE_REALTIME_BROWSER_API_VERSION,
    },
  });
  const token = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(expiresAtMs).toISOString(),
      newSessionExpireTime: new Date(newSessionExpiresAtMs).toISOString(),
      liveConnectConstraints: {
        model,
        config: buildGoogleLiveConnectConfig({
          ...config,
          apiKey,
          model,
          voice,
          instructions: req.instructions,
          tools: req.tools,
        }),
      },
    },
  });
  const clientSecret = token.name?.trim();
  if (!clientSecret) {
    throw new Error("Google Live browser session did not return an ephemeral token");
  }

  return {
    provider: "google",
    transport: "json-pcm-websocket",
    protocol: "google-live-bidi",
    clientSecret,
    websocketUrl: GOOGLE_REALTIME_BROWSER_WEBSOCKET_URL,
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: GOOGLE_REALTIME_INPUT_SAMPLE_RATE,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24_000,
    },
    initialMessage: buildBrowserInitialSetup(model),
    model,
    voice,
    expiresAt: Math.floor(expiresAtMs / 1000),
  };
}

export function buildGoogleRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: "google",
    label: "Google Live Voice",
    defaultModel: GOOGLE_REALTIME_DEFAULT_MODEL,
    autoSelectOrder: 20,
    resolveConfig: ({ cfg, rawConfig }) => normalizeProviderConfig(rawConfig, cfg),
    isConfigured: ({ providerConfig }) =>
      Boolean(normalizeProviderConfig(providerConfig).apiKey || resolveEnvApiKey()),
    createBridge: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      const apiKey = config.apiKey || resolveEnvApiKey();
      if (!apiKey) {
        throw new Error("Google Gemini API key missing");
      }
      return new GoogleRealtimeVoiceBridge({
        ...req,
        apiKey,
        model: config.model,
        voice: config.voice,
        temperature: config.temperature,
        apiVersion: config.apiVersion,
        prefixPaddingMs: config.prefixPaddingMs,
        silenceDurationMs: config.silenceDurationMs,
        startSensitivity: config.startSensitivity,
        endSensitivity: config.endSensitivity,
        activityHandling: config.activityHandling,
        turnCoverage: config.turnCoverage,
        automaticActivityDetectionDisabled: config.automaticActivityDetectionDisabled,
        enableAffectiveDialog: config.enableAffectiveDialog,
        sessionResumption: config.sessionResumption,
        contextWindowCompression: config.contextWindowCompression,
        thinkingLevel: config.thinkingLevel,
        thinkingBudget: config.thinkingBudget,
      });
    },
    createBrowserSession: createGoogleRealtimeBrowserSession,
  };
}
