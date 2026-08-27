// Google provider module implements model/runtime integration.
import { randomUUID } from "node:crypto";
import {
  ActivityHandling,
  Behavior,
  EndSensitivity,
  type FunctionDeclaration,
  type FunctionResponse,
  FunctionResponseScheduling,
  type LiveConnectConfig,
  type LiveServerContent,
  type LiveServerMessage,
  type LiveServerToolCall,
  Modality,
  type RealtimeInputConfig,
  type Session,
  StartSensitivity,
  type ThinkingConfig,
  TurnCoverage,
} from "@google/genai";
import {
  resolveExpiresAtMsFromDurationMs,
  timestampMsToIsoString,
} from "openclaw/plugin-sdk/number-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBridge,
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceRole,
  RealtimeVoiceTool,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  convertPcmToMulaw8k,
  createRealtimeVoiceAudioQueue,
  mulawToPcm,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  realtimeVoiceAudioDurationMs,
  resamplePcm,
} from "openclaw/plugin-sdk/realtime-voice";
import { warn } from "openclaw/plugin-sdk/runtime-env";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asBoolean,
  asFiniteNumber,
  asOptionalRecord,
  asSafeIntegerInRange,
  isRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { canonicalizeGoogleProviderBase64 } from "./base64.js";
import { createGoogleGenAI } from "./google-genai-runtime.js";
import { resolveGoogleGemini3ThinkingLevel } from "./thinking-api.js";

const GOOGLE_REALTIME_DEFAULT_MODEL = "gemini-3.1-flash-live-preview";
const GOOGLE_REALTIME_DEFAULT_VOICE = "Kore";
const GOOGLE_REALTIME_DEFAULT_API_VERSION = "v1beta";
const GOOGLE_REALTIME_INPUT_SAMPLE_RATE = 16_000;
const GOOGLE_REALTIME_BROWSER_API_VERSION = "v1alpha";
const GOOGLE_REALTIME_BROWSER_WEBSOCKET_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
const DEFAULT_AUDIO_STREAM_END_SILENCE_MS = 500;
const GOOGLE_REALTIME_BROWSER_SESSION_TTL_MS = 30 * 60 * 1000;
const GOOGLE_REALTIME_BROWSER_NEW_SESSION_TTL_MS = 60 * 1000;
const GOOGLE_REALTIME_RECONNECT_MAX_ATTEMPTS = 3;
const GOOGLE_REALTIME_RECONNECT_BASE_DELAY_MS = 250;
const GOOGLE_REALTIME_RECONNECT_MAX_DELAY_MS = 2_000;
const GOOGLE_REALTIME_MAX_TOOL_CALL_IDS = 1_024;
const GOOGLE_REALTIME_MAX_PENDING_TOOL_RESPONSES = 1_024;
const GOOGLE_REALTIME_MAX_PENDING_TOOL_RESPONSE_BYTES = 1024 * 1024;
const GOOGLE_REALTIME_MAX_PENDING_TRANSCRIPT_BYTES = 256 * 1024;
const GOOGLE_REALTIME_TRANSCRIPT_OVERFLOW_MESSAGE =
  "Google Live transcript exceeded the 256 KiB UTF-8 pending buffer limit";
// Google Live requires a leading letter/underscore and caps function names at 128 characters.
const GOOGLE_REALTIME_TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const MULAW_LINEAR_SAMPLES = new Int16Array(256);

for (let i = 0; i < MULAW_LINEAR_SAMPLES.length; i += 1) {
  MULAW_LINEAR_SAMPLES[i] = decodeMulawSample(i);
}

type GoogleRealtimeSensitivity = "low" | "high";
type GoogleRealtimeThinkingLevel = "minimal" | "low" | "medium" | "high";
type GoogleRealtimeActivityHandling = "start-of-activity-interrupts" | "no-interruption";
type GoogleRealtimeTurnCoverage = "only-activity" | "all-input" | "audio-activity-and-all-video";

const START_SENSITIVITY = {
  high: StartSensitivity.START_SENSITIVITY_HIGH,
  low: StartSensitivity.START_SENSITIVITY_LOW,
} satisfies Record<GoogleRealtimeSensitivity, StartSensitivity>;
const END_SENSITIVITY = {
  high: EndSensitivity.END_SENSITIVITY_HIGH,
  low: EndSensitivity.END_SENSITIVITY_LOW,
} satisfies Record<GoogleRealtimeSensitivity, EndSensitivity>;
const ACTIVITY_HANDLING = {
  "start-of-activity-interrupts": ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
  "no-interruption": ActivityHandling.NO_INTERRUPTION,
} satisfies Record<GoogleRealtimeActivityHandling, ActivityHandling>;
const TURN_COVERAGE = {
  "only-activity": TurnCoverage.TURN_INCLUDES_ONLY_ACTIVITY,
  "all-input": TurnCoverage.TURN_INCLUDES_ALL_INPUT,
  "audio-activity-and-all-video": TurnCoverage.TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO,
} satisfies Record<GoogleRealtimeTurnCoverage, TurnCoverage>;

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
type GoogleLiveTranscription = NonNullable<LiveServerContent["inputTranscription"]>;
type GoogleLiveTranscriptAccumulator = {
  text: string;
  byteCount: number;
};

function trimToUndefined(value: unknown): string | undefined {
  return normalizeOptionalString(value);
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

function asNonNegativeInteger(value: unknown): number | undefined {
  return asSafeIntegerInRange(value, { min: 0 });
}

function asGoogleRealtimeThinkingBudget(value: unknown): number | undefined {
  const budget = asFiniteNumber(value);
  return budget !== undefined &&
    Number.isSafeInteger(budget) &&
    (budget === -1 || (budget >= 0 && budget <= 24_576))
    ? budget
    : undefined;
}

function resolveGoogleRealtimeProviderConfigRecord(
  config: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const providers = asOptionalRecord(config.providers);
  return asOptionalRecord(providers?.google) ?? asOptionalRecord(config.google) ?? config;
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
    voice: trimToUndefined(raw?.speakerVoice) ?? trimToUndefined(raw?.voice),
    temperature: asFiniteNumber(raw?.temperature),
    apiVersion: trimToUndefined(raw?.apiVersion),
    prefixPaddingMs: asNonNegativeInteger(raw?.prefixPaddingMs),
    silenceDurationMs: asNonNegativeInteger(raw?.silenceDurationMs),
    startSensitivity: asSensitivity(raw?.startSensitivity),
    endSensitivity: asSensitivity(raw?.endSensitivity),
    activityHandling: asActivityHandling(raw?.activityHandling),
    turnCoverage: asTurnCoverage(raw?.turnCoverage),
    automaticActivityDetectionDisabled: asBoolean(raw?.automaticActivityDetectionDisabled),
    enableAffectiveDialog: asBoolean(raw?.enableAffectiveDialog),
    sessionResumption: asBoolean(raw?.sessionResumption),
    contextWindowCompression: asBoolean(raw?.contextWindowCompression),
    thinkingLevel: asThinkingLevel(raw?.thinkingLevel),
    thinkingBudget: asGoogleRealtimeThinkingBudget(raw?.thinkingBudget),
  };
}

function resolveEnvApiKey(): string | undefined {
  return trimToUndefined(process.env.GEMINI_API_KEY) ?? trimToUndefined(process.env.GOOGLE_API_KEY);
}

// Gemini 3.1 Live replaces client-content text and async tools with realtime text
// and sequential function responses; explicit older models keep their prior contract.
function isGemini31LiveModel(model: string): boolean {
  const modelId = model.startsWith("models/") ? model.slice("models/".length) : model;
  return modelId.startsWith("gemini-3.1-") && modelId.includes("-live");
}

function supportsAsyncFunctionCalling(model: string): boolean {
  return !isGemini31LiveModel(model);
}

function buildThinkingConfig(
  config: GoogleRealtimeLiveConfig,
  model: string,
): ThinkingConfig | undefined {
  if (isGemini31LiveModel(model)) {
    const thinkingLevel = resolveGoogleGemini3ThinkingLevel({
      modelId: model,
      thinkingLevel: config.thinkingLevel,
      thinkingBudget: config.thinkingBudget,
    });
    return thinkingLevel
      ? { thinkingLevel: thinkingLevel as ThinkingConfig["thinkingLevel"] }
      : undefined;
  }
  if (typeof config.thinkingBudget === "number") {
    return { thinkingBudget: config.thinkingBudget };
  }
  return undefined;
}

function buildRealtimeInputConfig(
  config: GoogleRealtimeLiveConfig,
): RealtimeInputConfig | undefined {
  const startSensitivity = config.startSensitivity
    ? START_SENSITIVITY[config.startSensitivity]
    : undefined;
  const endSensitivity = config.endSensitivity ? END_SENSITIVITY[config.endSensitivity] : undefined;
  const activityHandling = config.activityHandling
    ? ACTIVITY_HANDLING[config.activityHandling]
    : undefined;
  const turnCoverage = config.turnCoverage ? TURN_COVERAGE[config.turnCoverage] : undefined;
  const automaticActivityDetection = {
    ...(typeof config.automaticActivityDetectionDisabled === "boolean"
      ? { disabled: config.automaticActivityDetectionDisabled }
      : {}),
    ...(startSensitivity ? { startOfSpeechSensitivity: startSensitivity } : {}),
    ...(endSensitivity ? { endOfSpeechSensitivity: endSensitivity } : {}),
    ...(typeof config.prefixPaddingMs === "number"
      ? { prefixPaddingMs: config.prefixPaddingMs }
      : {}),
    ...(typeof config.silenceDurationMs === "number"
      ? { silenceDurationMs: config.silenceDurationMs }
      : {}),
  };
  const realtimeInputConfig = {
    ...(Object.keys(automaticActivityDetection).length > 0 ? { automaticActivityDetection } : {}),
    ...(activityHandling ? { activityHandling } : {}),
    ...(turnCoverage ? { turnCoverage } : {}),
  };
  return Object.keys(realtimeInputConfig).length > 0 ? realtimeInputConfig : undefined;
}

function buildFunctionDeclarations(
  tools: RealtimeVoiceTool[] | undefined,
  allowNonBlocking: boolean,
): FunctionDeclaration[] {
  const declarations: FunctionDeclaration[] = [];
  let omitted = 0;
  for (const tool of tools ?? []) {
    try {
      const name = tool.name;
      if (typeof name !== "string" || !GOOGLE_REALTIME_TOOL_NAME_RE.test(name)) {
        omitted += 1;
        continue;
      }
      // Live preview models honor the OpenAPI `parameters` field; the SDK normalizes
      // our lowercase JSON Schema types before sending the mutually exclusive field.
      const declaration: FunctionDeclaration = {
        name,
        description: tool.description,
        parameters: tool.parameters as unknown as FunctionDeclaration["parameters"],
      };
      if (allowNonBlocking && name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
        declaration.behavior = Behavior.NON_BLOCKING;
      }
      declarations.push(declaration);
    } catch {
      omitted += 1;
    }
  }
  if (omitted > 0) {
    warn(`google realtime: omitted ${omitted} tool definition(s) with unsupported names`);
  }
  return declarations;
}

function buildGoogleLiveConnectConfig(
  config: GoogleRealtimeLiveConfig,
  model: string,
): LiveConnectConfig {
  const functionDeclarations = buildFunctionDeclarations(
    config.tools,
    supportsAsyncFunctionCalling(model),
  );
  const realtimeInputConfig = buildRealtimeInputConfig(config);
  const thinkingConfig = buildThinkingConfig(config, model);
  return {
    responseModalities: [Modality.AUDIO],
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
    ...(!isGemini31LiveModel(model) && typeof config.enableAffectiveDialog === "boolean"
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
        responseModalities: [Modality.AUDIO],
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

function formatGoogleLiveCloseEvent(
  event:
    | {
        code?: number;
        reason?: string;
        wasClean?: boolean;
      }
    | undefined,
): string {
  if (!event) {
    return "code=unknown reason=unknown";
  }
  const code = typeof event.code === "number" ? event.code : "unknown";
  const reason = event.reason?.trim() || "none";
  const clean = typeof event.wasClean === "boolean" ? ` clean=${event.wasClean}` : "";
  return `code=${code} reason=${reason}${clean}`;
}

type GoogleLiveConnectionAttempt = {
  promise: Promise<void>;
  cancel: () => void;
};

type GooglePendingToolResponse = {
  callId: string;
  payload: string;
  byteLength: number;
};

class GoogleRealtimeVoiceBridge implements RealtimeVoiceBridge {
  readonly supportsToolResultContinuation: boolean;
  readonly supportsToolResultSuppression = false;

  private session: Session | null = null;
  private connected = false;
  private setupCompleteReceived = false;
  private sessionConfigured = false;
  private intentionallyClosed = false;
  // Native reconnect keeps the already accepted FIFO prefix stable.
  private readonly pendingAudio = createRealtimeVoiceAudioQueue("reject-newest");
  private sessionReadyFired = false;
  private consecutiveSilenceMs = 0;
  private audioStreamEnded = false;
  private pendingFunctionNames = new Map<string, string>();
  private seenFunctionCallIds = new Set<string>();
  private pendingToolResponses: GooglePendingToolResponse[] = [];
  private pendingToolResponseBytes = 0;
  private readonly audioFormat: RealtimeVoiceAudioFormat;
  private readonly model: string;
  private resumptionHandle: string | undefined;
  private resumingSession = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private hasConnectedSession = false;
  private continuityResetEmitted = false;
  private terminalError: Error | undefined;
  private closeNotified = false;
  private connectionOwner: GoogleLiveConnectionAttempt | undefined;
  private connectAttempt: GoogleLiveConnectionAttempt | undefined;
  // Google can interleave independent input/output transcripts, so each role
  // owns its own in-progress byte budget until `finished` or terminal cleanup.
  private readonly pendingTranscripts: Record<RealtimeVoiceRole, GoogleLiveTranscriptAccumulator> =
    {
      user: { text: "", byteCount: 0 },
      assistant: { text: "", byteCount: 0 },
    };

  constructor(private readonly config: GoogleRealtimeVoiceBridgeConfig) {
    this.audioFormat = config.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ;
    this.model = config.model ?? GOOGLE_REALTIME_DEFAULT_MODEL;
    this.supportsToolResultContinuation = supportsAsyncFunctionCalling(this.model);
  }

  async connect(): Promise<void> {
    if (this.terminalError) {
      throw this.terminalError;
    }
    if (this.session) {
      return;
    }
    if (this.connectAttempt) {
      return this.connectAttempt.promise;
    }
    let cancel = () => {};
    const cancelled = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    const attempt: GoogleLiveConnectionAttempt = {
      promise: cancelled,
      cancel,
    };
    this.connectionOwner = attempt;
    this.connectAttempt = attempt;
    const connection = this.connectOwned(attempt);
    attempt.promise = Promise.race([connection, cancelled]).finally(() => {
      if (this.connectAttempt === attempt) {
        this.connectAttempt = undefined;
      }
    });
    return attempt.promise;
  }

  private async connectOwned(attempt: GoogleLiveConnectionAttempt): Promise<void> {
    this.intentionallyClosed = false;
    this.closeNotified = false;
    this.setupCompleteReceived = false;
    this.sessionConfigured = false;
    this.sessionReadyFired = false;
    this.consecutiveSilenceMs = 0;
    this.audioStreamEnded = false;
    const resumesExistingSession =
      this.config.sessionResumption !== false && Boolean(this.resumptionHandle);
    this.resumingSession = resumesExistingSession;
    if (!resumesExistingSession) {
      this.resetToolCallOwnership();
    }
    const ai = createGoogleGenAI({
      apiKey: this.config.apiKey,
      httpOptions: {
        apiVersion: this.config.apiVersion ?? GOOGLE_REALTIME_DEFAULT_API_VERSION,
      },
    });

    try {
      const session = await ai.live.connect({
        model: this.model,
        config: {
          ...buildGoogleLiveConnectConfig(this.config, this.model),
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
            if (this.connectionOwner !== attempt) {
              return;
            }
            this.connected = true;
            this.maybeActivateSession();
          },
          onmessage: (message) => {
            if (this.connectionOwner !== attempt) {
              return;
            }
            this.handleMessage(message);
          },
          onerror: (event) => {
            if (this.connectionOwner !== attempt) {
              return;
            }
            const error =
              event.error instanceof Error
                ? event.error
                : new Error(
                    typeof event.message === "string" ? event.message : "Google Live API error",
                  );
            this.config.onError?.(error);
          },
          onclose: (event) => {
            if (this.connectionOwner !== attempt) {
              return;
            }
            this.connectionOwner = undefined;
            this.cancelConnectAttempt(attempt);
            this.connected = false;
            this.setupCompleteReceived = false;
            this.sessionConfigured = false;
            this.session = null;
            if (this.terminalError) {
              this.notifyClose("error");
              return;
            }
            if (this.intentionallyClosed) {
              this.notifyClose("completed");
              return;
            }
            const closeDetails = formatGoogleLiveCloseEvent(event);
            if (this.scheduleReconnect(closeDetails)) {
              return;
            }
            this.resetToolCallOwnership();
            // Transport failure is not an utterance boundary. Preserve transcript
            // fragments across reconnects and finalize only when recovery is exhausted.
            this.flushPendingTranscripts();
            this.config.onError?.(
              new Error(`Google Live session closed after reconnect attempts: ${closeDetails}`),
            );
            this.notifyClose("error");
          },
        },
      });
      if (this.connectionOwner !== attempt) {
        session.close();
        return;
      }
      this.session = session;
      this.hasConnectedSession = true;
      this.maybeActivateSession();
    } catch (error) {
      if (this.connectionOwner === attempt) {
        this.connectionOwner = undefined;
        this.connected = false;
        this.setupCompleteReceived = false;
        this.sessionConfigured = false;
        const session = this.session;
        this.session = null;
        session?.close();
      }
      throw error;
    }
  }

  sendAudio(audio: Buffer): void {
    if (this.terminalError || this.intentionallyClosed || this.closeNotified) {
      return;
    }
    if (!this.session || !this.connected || !this.sessionConfigured) {
      this.pendingAudio.enqueue(audio);
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
    this.consecutiveSilenceMs += Math.round(
      realtimeVoiceAudioDurationMs(this.audioFormat, audio.length),
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
    if (isGemini31LiveModel(this.model)) {
      this.session.sendRealtimeInput({ text: normalized });
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

  private rejectToolResult(error: Error): never {
    this.config.onError?.(error);
    throw error;
  }

  submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    const name = this.pendingFunctionNames.get(callId);
    if (!name) {
      if (this.seenFunctionCallIds.has(callId)) {
        return;
      }
      this.rejectToolResult(
        new Error(
          `Google Live function response is missing a matching function call for ${callId}`,
        ),
      );
    }
    const isConsultTool = name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME;
    if (options?.willContinue === true && !this.supportsToolResultContinuation) {
      this.rejectToolResult(
        new Error(`Google Live model ${this.model} does not support continuing tool responses`),
      );
    }
    const wrapsResult = !result || typeof result !== "object" || Array.isArray(result);
    const functionResponse: FunctionResponse = {
      id: callId,
      name,
      response: wrapsResult ? { output: result } : (result as Record<string, unknown>),
    };
    if (isConsultTool && this.supportsToolResultContinuation) {
      functionResponse.scheduling = FunctionResponseScheduling.WHEN_IDLE;
      if (options?.willContinue === true) {
        functionResponse.willContinue = true;
      }
    } else if (options?.willContinue === true) {
      this.rejectToolResult(
        new Error(
          `Google Live continuation is only supported for ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME}`,
        ),
      );
    }

    let serializedResponse: string;
    let normalizedResponse: FunctionResponse;
    try {
      serializedResponse = JSON.stringify(functionResponse);
      normalizedResponse = JSON.parse(serializedResponse) as FunctionResponse;
      if (
        !isRecord(normalizedResponse.response) ||
        (wrapsResult && !Object.hasOwn(normalizedResponse.response, "output"))
      ) {
        throw new Error("Google Live function response is missing required JSON output");
      }
    } catch (cause) {
      this.rejectToolResult(
        new Error("Google Live function response result is not JSON-serializable", { cause }),
      );
    }

    try {
      const session = this.session;
      const canSendImmediately = Boolean(
        session && (!this.resumingSession || this.sessionConfigured),
      );
      if (session && canSendImmediately) {
        session.sendToolResponse({
          functionResponses: [normalizedResponse],
        });
      } else {
        this.queueToolResponseForReconnect(callId, serializedResponse);
      }
      if (options?.willContinue !== true) {
        this.pendingFunctionNames.delete(callId);
      }
    } catch (error) {
      const sendError =
        error instanceof Error ? error : new Error("Failed to send Google Live function response");
      if (this.session && (!this.resumingSession || this.sessionConfigured)) {
        this.config.onError?.(sendError);
      } else {
        this.failConnection(sendError);
      }
      throw sendError;
    }
  }

  acknowledgeMark(_markName?: string): void {}

  close(): void {
    const hadConnection = Boolean(
      this.connectionOwner || this.connectAttempt || this.session || this.reconnectTimer,
    );
    this.intentionallyClosed = true;
    this.connected = false;
    this.setupCompleteReceived = false;
    this.sessionConfigured = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearPendingAudio();
    this.consecutiveSilenceMs = 0;
    this.audioStreamEnded = false;
    this.resetToolCallOwnership();
    this.flushPendingTranscripts();
    const owner = this.connectionOwner;
    this.connectionOwner = undefined;
    this.cancelConnectAttempt(owner);
    const session = this.session;
    this.session = null;
    session?.close();
    if (hadConnection) {
      this.notifyClose("completed");
    }
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
    if (message.toolCallCancellation) {
      this.handleToolCallCancellation(message.toolCallCancellation.ids);
    }
    if (message.setupComplete) {
      // Apply cancellation and tool facts from the same server message before
      // setup activation flushes responses retained across a resumable reconnect.
      this.maybeActivateSession();
    }
  }

  private captureSessionLifecycle(message: LiveServerMessage): void {
    const raw = message as unknown as {
      goAway?: { timeLeft?: string };
      sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
    };
    const update = raw.sessionResumptionUpdate;
    if (update?.resumable === false) {
      this.resumptionHandle = undefined;
    } else if (update?.resumable && update.newHandle) {
      this.resumptionHandle = update.newHandle;
    }
    if (raw.goAway?.timeLeft) {
      this.config.onError?.(new Error(`Google Live session goAway: ${raw.goAway.timeLeft}`));
    }
  }

  private handleSetupComplete(): void {
    if (!this.setupCompleteReceived) {
      // setupComplete proves Google selected a new server session. A later
      // continuity loss therefore owns a new reset generation.
      if (this.continuityResetEmitted) {
        this.config.onEvent?.({ direction: "server", type: "session.created" });
      }
      this.continuityResetEmitted = false;
    }
    this.setupCompleteReceived = true;
  }

  private maybeActivateSession(): void {
    // The SDK delivers setupComplete before Live.connect() returns its Session.
    // Readiness requires both facts or queued audio can be drained without a transport.
    if (this.sessionConfigured || !this.connected || !this.setupCompleteReceived || !this.session) {
      return;
    }
    this.sessionConfigured = true;
    this.reconnectAttempts = 0;
    if (!this.flushPendingToolResponses()) {
      return;
    }
    this.resumingSession = false;
    for (const chunk of this.pendingAudio.drain()) {
      this.sendAudio(chunk);
    }
    if (!this.sessionReadyFired) {
      this.sessionReadyFired = true;
      this.config.onReady?.();
    }
  }

  private handleServerContent(content: LiveServerContent): void {
    if (content.interrupted) {
      this.config.onClearAudio("barge-in");
    }

    if (content.inputTranscription) {
      if (!this.appendTranscript("user", content.inputTranscription)) {
        return;
      }
    }

    if (content.outputTranscription) {
      // outputAudioTranscription is requested in the session config. Keep that
      // official stream canonical; modelTurn text has no transcript turn identity.
      if (!this.appendTranscript("assistant", content.outputTranscription)) {
        return;
      }
    }

    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        const canonicalAudio = canonicalizeGoogleProviderBase64(part.inlineData.data);
        if (!canonicalAudio) {
          this.failConnection(new Error("Google Live stream returned malformed base64 audio data"));
          return;
        }
        const pcm = Buffer.from(canonicalAudio, "base64");
        const sampleRate = parsePcmSampleRate(part.inlineData.mimeType);
        const audio = this.toOutputAudio(pcm, sampleRate);
        if (audio.length > 0) {
          this.config.onAudio(audio);
          this.config.onMark?.(`audio-${randomUUID()}`);
        }
        continue;
      }
    }
  }

  private appendTranscript(role: RealtimeVoiceRole, transcript: GoogleLiveTranscription): boolean {
    const text = transcript.text;
    if (text) {
      const pending = this.pendingTranscripts[role];
      const textBytes = Buffer.byteLength(text, "utf8");
      if (pending.byteCount + textBytes > GOOGLE_REALTIME_MAX_PENDING_TRANSCRIPT_BYTES) {
        this.resetPendingTranscripts();
        this.failConnection(new Error(GOOGLE_REALTIME_TRANSCRIPT_OVERFLOW_MESSAGE));
        return false;
      }
      pending.text += text;
      pending.byteCount += textBytes;
      this.emitTranscript(role, text, false);
    }
    // turnComplete belongs to model generation and is unordered with transcription.
    // Finalize only on the protocol terminal or when the bridge permanently closes.
    if (transcript.finished) {
      this.flushPendingTranscript(role);
    }
    return true;
  }

  private flushPendingTranscript(role: RealtimeVoiceRole): void {
    const pending = this.pendingTranscripts[role];
    const completeText = pending.text.trim();
    pending.text = "";
    pending.byteCount = 0;
    if (completeText) {
      this.emitTranscript(role, completeText, true);
    }
  }

  private emitTranscript(role: RealtimeVoiceRole, text: string, isFinal: boolean): void {
    try {
      this.config.onTranscript?.(role, text, isFinal);
    } catch (error) {
      try {
        this.config.onError?.(
          error instanceof Error ? error : new Error("Google Live transcript callback failed"),
        );
      } catch {
        // Consumer callback failures must not abort provider cleanup.
      }
    }
  }

  private flushPendingTranscripts(): void {
    this.flushPendingTranscript("user");
    this.flushPendingTranscript("assistant");
  }

  private resetPendingTranscripts(): void {
    this.pendingTranscripts.user = { text: "", byteCount: 0 };
    this.pendingTranscripts.assistant = { text: "", byteCount: 0 };
  }

  private failConnection(error: Error): void {
    if (this.terminalError) {
      return;
    }
    this.terminalError = error;
    this.intentionallyClosed = true;
    this.connected = false;
    this.setupCompleteReceived = false;
    this.sessionConfigured = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.resetToolCallOwnership();
    this.flushPendingTranscripts();
    const owner = this.connectionOwner;
    this.connectionOwner = undefined;
    this.cancelConnectAttempt(owner);
    const session = this.session;
    this.session = null;
    try {
      this.config.onError?.(error);
    } finally {
      try {
        session?.close();
      } finally {
        this.notifyClose("error");
      }
    }
  }

  private notifyClose(reason: "completed" | "error"): void {
    if (this.closeNotified) {
      return;
    }
    this.clearPendingAudio();
    this.closeNotified = true;
    this.config.onClose?.(reason);
  }

  private clearPendingAudio(): void {
    this.pendingAudio.clear();
  }

  private cancelConnectAttempt(attempt: GoogleLiveConnectionAttempt | undefined): void {
    if (!attempt) {
      return;
    }
    if (this.connectAttempt === attempt) {
      this.connectAttempt = undefined;
    }
    attempt.cancel();
  }

  private handleToolCall(toolCall: LiveServerToolCall): void {
    for (const call of toolCall.functionCalls ?? []) {
      const name = call.name?.trim();
      if (!name) {
        continue;
      }
      const callId = call.id?.trim() || `google-live-${randomUUID()}`;
      if (this.seenFunctionCallIds.has(callId)) {
        continue;
      }
      // The Live protocol defines no replay window, so dropping old IDs could execute
      // a very late duplicate. End an extreme session instead of weakening dedupe.
      if (this.seenFunctionCallIds.size >= GOOGLE_REALTIME_MAX_TOOL_CALL_IDS) {
        this.failConnection(new Error("Google Live tool-call session limit exceeded"));
        return;
      }
      this.seenFunctionCallIds.add(callId);
      this.pendingFunctionNames.set(callId, name);
      this.config.onToolCall?.({
        itemId: callId,
        callId,
        name,
        args: call.args ?? {},
      });
    }
  }

  private handleToolCallCancellation(ids: string[] | undefined): void {
    for (const rawId of ids ?? []) {
      const callId = rawId.trim();
      if (!callId) {
        continue;
      }
      const removedPendingCall = this.pendingFunctionNames.delete(callId);
      const removedQueuedResponse = this.removePendingToolResponses(callId);
      if (!removedPendingCall && !removedQueuedResponse) {
        continue;
      }
      // Provider cancellation invalidates any late consumer result for this call ID.
      this.config.onEvent?.({
        direction: "server",
        type: "tool.call.cancelled",
        itemId: callId,
      });
    }
  }

  private resetToolCallOwnership(): void {
    this.pendingFunctionNames.clear();
    this.seenFunctionCallIds.clear();
    this.pendingToolResponses = [];
    this.pendingToolResponseBytes = 0;
  }

  private queueToolResponseForReconnect(callId: string, payload: string): void {
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (
      this.pendingToolResponses.length >= GOOGLE_REALTIME_MAX_PENDING_TOOL_RESPONSES ||
      this.pendingToolResponseBytes + payloadBytes > GOOGLE_REALTIME_MAX_PENDING_TOOL_RESPONSE_BYTES
    ) {
      throw new Error("Google Live reconnect tool-response buffer limit exceeded");
    }
    // Store the serialized wire shape so a stalled reconnect cannot retain an
    // arbitrarily large caller-owned object graph through the tool result.
    this.pendingToolResponses.push({ callId, payload, byteLength: payloadBytes });
    this.pendingToolResponseBytes += payloadBytes;
  }

  private removePendingToolResponses(callId: string): boolean {
    const retained: GooglePendingToolResponse[] = [];
    let removed = false;
    for (const response of this.pendingToolResponses) {
      if (response.callId === callId) {
        this.pendingToolResponseBytes -= response.byteLength;
        removed = true;
      } else {
        retained.push(response);
      }
    }
    this.pendingToolResponses = retained;
    return removed;
  }

  private flushPendingToolResponses(): boolean {
    const session = this.session;
    if (!session) {
      return false;
    }
    try {
      while (this.pendingToolResponses.length > 0) {
        const response = this.pendingToolResponses[0];
        if (!response) {
          break;
        }
        session.sendToolResponse({
          functionResponses: [JSON.parse(response.payload) as FunctionResponse],
        });
        this.pendingToolResponses.shift();
        this.pendingToolResponseBytes -= response.byteLength;
      }
      return true;
    } catch (error) {
      this.failConnection(
        error instanceof Error
          ? error
          : new Error("Failed to flush Google Live function responses"),
      );
      return false;
    }
  }

  private scheduleReconnect(closeDetails: string): boolean {
    if (this.reconnectAttempts >= GOOGLE_REALTIME_RECONNECT_MAX_ATTEMPTS) {
      return false;
    }
    const canResumeSession =
      this.config.sessionResumption !== false && Boolean(this.resumptionHandle);
    if (this.hasConnectedSession && !canResumeSession && !this.continuityResetEmitted) {
      // A non-resumable close ends the provider generation immediately. Reset
      // consumers before backoff so stale work cannot finish into the replacement.
      this.continuityResetEmitted = true;
      this.resetPendingTranscripts();
      this.resetToolCallOwnership();
      this.config.onEvent?.({
        direction: "client",
        type: "session.continuity.reset",
      });
    }
    const attempt = ++this.reconnectAttempts;
    const delayMs = Math.min(
      GOOGLE_REALTIME_RECONNECT_MAX_DELAY_MS,
      GOOGLE_REALTIME_RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
    );
    this.config.onError?.(
      new Error(
        `Google Live session closed unexpectedly (${closeDetails}); reconnecting ${attempt}/${GOOGLE_REALTIME_RECONNECT_MAX_ATTEMPTS} in ${delayMs}ms`,
      ),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.intentionallyClosed) {
        return;
      }
      this.connect().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.config.onError?.(error instanceof Error ? error : new Error(message));
        if (!this.scheduleReconnect(`connect failed: ${message}`)) {
          this.resetToolCallOwnership();
          this.flushPendingTranscripts();
          this.notifyClose("error");
        }
      });
    }, delayMs);
    return true;
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
  const providerConfig = normalizeProviderConfig(req.providerConfig);
  const prefixPaddingMs = asNonNegativeInteger(req.prefixPaddingMs);
  const silenceDurationMs = asNonNegativeInteger(req.silenceDurationMs);
  const config = {
    ...providerConfig,
    ...(prefixPaddingMs !== undefined ? { prefixPaddingMs } : {}),
    ...(silenceDurationMs !== undefined ? { silenceDurationMs } : {}),
  };
  const apiKey = config.apiKey || resolveEnvApiKey();
  if (!apiKey) {
    throw new Error("Google Gemini API key missing");
  }
  const model = req.model ?? config.model ?? GOOGLE_REALTIME_DEFAULT_MODEL;
  const voice = req.voice ?? config.voice ?? GOOGLE_REALTIME_DEFAULT_VOICE;
  const nowMs = Date.now();
  const expiresAtMs = resolveExpiresAtMsFromDurationMs(GOOGLE_REALTIME_BROWSER_SESSION_TTL_MS, {
    nowMs,
  });
  const newSessionExpiresAtMs = resolveExpiresAtMsFromDurationMs(
    GOOGLE_REALTIME_BROWSER_NEW_SESSION_TTL_MS,
    { nowMs },
  );
  const expireTime = timestampMsToIsoString(expiresAtMs);
  const newSessionExpireTime = timestampMsToIsoString(newSessionExpiresAtMs);
  if (expiresAtMs === undefined || !expireTime || !newSessionExpireTime) {
    throw new Error("Google realtime browser session expiry is outside the supported Date range");
  }
  const ai = createGoogleGenAI({
    apiKey,
    httpOptions: {
      apiVersion: GOOGLE_REALTIME_BROWSER_API_VERSION,
      timeout: 30_000,
    },
  });
  const token = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime,
      newSessionExpireTime,
      liveConnectConstraints: {
        model,
        config: buildGoogleLiveConnectConfig(
          {
            ...config,
            apiKey,
            model,
            voice,
            instructions: req.instructions,
            tools: req.tools,
          },
          model,
        ),
      },
    },
  });
  const clientSecret = token.name?.trim();
  if (!clientSecret) {
    throw new Error("Google Live browser session did not return an ephemeral token");
  }

  return {
    provider: "google",
    transport: "provider-websocket",
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
    expiresAt: newSessionExpiresAtMs,
  };
}

export function buildGoogleRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: "google",
    label: "Google Live Voice",
    defaultModel: GOOGLE_REALTIME_DEFAULT_MODEL,
    autoSelectOrder: 20,
    capabilities: {
      transports: ["provider-websocket", "gateway-relay"],
      inputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      outputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      supportsBrowserSession: true,
      supportsBargeIn: true,
      handlesInputAudioBargeIn: true,
      supportsToolCalls: true,
      supportsVideoFrames: true,
      supportsSessionResumption: true,
    },
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
