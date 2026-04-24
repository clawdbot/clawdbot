import { randomUUID } from "node:crypto";
import {
  EndSensitivity,
  Modality,
  StartSensitivity,
  type FunctionDeclaration,
  type FunctionResponse,
  type LiveServerContent,
  type LiveServerMessage,
  type LiveServerToolCall,
  type RealtimeInputConfig,
  type ThinkingConfig,
} from "@google/genai";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import { convertPcmToMulaw8k, mulawToPcm, resamplePcm } from "openclaw/plugin-sdk/realtime-voice";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { createGoogleGenAI } from "./google-genai-runtime.js";

const GOOGLE_REALTIME_DEFAULT_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
const GOOGLE_REALTIME_DEFAULT_VOICE = "Kore";
const GOOGLE_REALTIME_DEFAULT_API_VERSION = "v1beta";
const GOOGLE_REALTIME_INPUT_SAMPLE_RATE = 16_000;
const TELEPHONY_SAMPLE_RATE = 8000;
const MAX_PENDING_AUDIO_CHUNKS = 320;
const DEFAULT_AUDIO_STREAM_END_SILENCE_MS = 700;

type GoogleRealtimeSensitivity = "low" | "high";
type GoogleRealtimeThinkingLevel = "minimal" | "low" | "medium" | "high";

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
  enableAffectiveDialog?: boolean;
  thinkingLevel?: GoogleRealtimeThinkingLevel;
  thinkingBudget?: number;
};

type GoogleRealtimeVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  apiKey: string;
  model?: string;
  voice?: string;
  temperature?: number;
  apiVersion?: string;
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
  startSensitivity?: GoogleRealtimeSensitivity;
  endSensitivity?: GoogleRealtimeSensitivity;
  enableAffectiveDialog?: boolean;
  thinkingLevel?: GoogleRealtimeThinkingLevel;
  thinkingBudget?: number;
};

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
    enableAffectiveDialog: asBoolean(raw?.enableAffectiveDialog),
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
      return StartSensitivity.START_SENSITIVITY_HIGH;
    case "low":
      return StartSensitivity.START_SENSITIVITY_LOW;
    default:
      return undefined;
  }
}

function mapEndSensitivity(
  value: GoogleRealtimeSensitivity | undefined,
): EndSensitivity | undefined {
  switch (value) {
    case "high":
      return EndSensitivity.END_SENSITIVITY_HIGH;
    case "low":
      return EndSensitivity.END_SENSITIVITY_LOW;
    default:
      return undefined;
  }
}

function buildThinkingConfig(config: GoogleRealtimeVoiceBridgeConfig): ThinkingConfig | undefined {
  if (config.thinkingLevel) {
    return { thinkingLevel: config.thinkingLevel.toUpperCase() as ThinkingConfig["thinkingLevel"] };
  }
  if (typeof config.thinkingBudget === "number") {
    return { thinkingBudget: config.thinkingBudget };
  }
  return undefined;
}

function buildRealtimeInputConfig(
  config: GoogleRealtimeVoiceBridgeConfig,
): RealtimeInputConfig | undefined {
  const startSensitivity = mapStartSensitivity(config.startSensitivity);
  const endSensitivity = mapEndSensitivity(config.endSensitivity);
  const automaticActivityDetection = {
    ...(startSensitivity ? { startOfSpeechSensitivity: startSensitivity } : {}),
    ...(endSensitivity ? { endOfSpeechSensitivity: endSensitivity } : {}),
    ...(typeof config.prefixPaddingMs === "number"
      ? { prefixPaddingMs: Math.max(0, Math.floor(config.prefixPaddingMs)) }
      : {}),
    ...(typeof config.silenceDurationMs === "number"
      ? { silenceDurationMs: Math.max(0, Math.floor(config.silenceDurationMs)) }
      : {}),
  };
  return Object.keys(automaticActivityDetection).length > 0
    ? { automaticActivityDetection }
    : undefined;
}

function buildFunctionDeclarations(tools: RealtimeVoiceTool[] | undefined): FunctionDeclaration[] {
  return (tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.parameters,
  }));
}

function parsePcmSampleRate(mimeType: string | undefined): number {
  const match = mimeType?.match(/(?:^|[;,\s])rate=(\d+)/i);
  const parsed = match ? Number.parseInt(match[1] ?? "", 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24_000;
}

function isMulawSilence(audio: Buffer): boolean {
  return audio.length > 0 && audio.every((sample) => sample === 0xff);
}

class GoogleRealtimeVoiceBridge implements RealtimeVoiceBridge {
  private session: GoogleLiveSession | null = null;
  private connected = false;
  private sessionConfigured = false;
  private intentionallyClosed = false;
  private pendingAudio: Buffer[] = [];
  private sessionReadyFired = false;
  private consecutiveSilenceMs = 0;
  private audioStreamEnded = false;

  constructor(private readonly config: GoogleRealtimeVoiceBridgeConfig) {}

  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    this.sessionConfigured = false;
    this.sessionReadyFired = false;
    this.consecutiveSilenceMs = 0;
    this.audioStreamEnded = false;

    const ai = createGoogleGenAI({
      apiKey: this.config.apiKey,
      httpOptions: {
        apiVersion: this.config.apiVersion ?? GOOGLE_REALTIME_DEFAULT_API_VERSION,
      },
    });

    const functionDeclarations = buildFunctionDeclarations(this.config.tools);
    this.session = (await ai.live.connect({
      model: this.config.model ?? GOOGLE_REALTIME_DEFAULT_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        ...(typeof this.config.temperature === "number" && this.config.temperature > 0
          ? { temperature: this.config.temperature }
          : {}),
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: this.config.voice ?? GOOGLE_REALTIME_DEFAULT_VOICE,
            },
          },
        },
        systemInstruction: this.config.instructions,
        ...(functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {}),
        ...(this.realtimeInputConfig ? { realtimeInputConfig: this.realtimeInputConfig } : {}),
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        ...(typeof this.config.enableAffectiveDialog === "boolean"
          ? { enableAffectiveDialog: this.config.enableAffectiveDialog }
          : {}),
        ...(this.thinkingConfig ? { thinkingConfig: this.thinkingConfig } : {}),
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
    const silent = isMulawSilence(audio);
    if (silent && this.audioStreamEnded) {
      return;
    }
    if (!silent) {
      this.consecutiveSilenceMs = 0;
      this.audioStreamEnded = false;
    }

    const pcm16k = resamplePcm(
      mulawToPcm(audio),
      TELEPHONY_SAMPLE_RATE,
      GOOGLE_REALTIME_INPUT_SAMPLE_RATE,
    );
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
    this.consecutiveSilenceMs += Math.round((audio.length / TELEPHONY_SAMPLE_RATE) * 1000);
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

  submitToolResult(callId: string, result: unknown): void {
    if (!this.session) {
      return;
    }
    this.session.sendToolResponse({
      functionResponses: [
        {
          id: callId,
          response:
            result && typeof result === "object"
              ? (result as Record<string, unknown>)
              : { output: result },
        },
      ],
    });
  }

  acknowledgeMark(): void {}

  close(): void {
    this.intentionallyClosed = true;
    this.connected = false;
    this.sessionConfigured = false;
    this.pendingAudio = [];
    this.consecutiveSilenceMs = 0;
    this.audioStreamEnded = false;
    const session = this.session;
    this.session = null;
    session?.close();
  }

  isConnected(): boolean {
    return this.connected && this.sessionConfigured;
  }

  private handleMessage(message: LiveServerMessage): void {
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
        const muLaw = convertPcmToMulaw8k(pcm, sampleRate);
        if (muLaw.length > 0) {
          this.config.onAudio(muLaw);
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
      this.config.onToolCall?.({
        itemId: callId,
        callId,
        name,
        args: call.args ?? {},
      });
    }
  }

  private get realtimeInputConfig(): RealtimeInputConfig | undefined {
    return buildRealtimeInputConfig(this.config);
  }

  private get thinkingConfig(): ThinkingConfig | undefined {
    return buildThinkingConfig(this.config);
  }
}

export function buildGoogleRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: "google",
    label: "Google Live Voice",
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
        enableAffectiveDialog: config.enableAffectiveDialog,
        thinkingLevel: config.thinkingLevel,
        thinkingBudget: config.thinkingBudget,
      });
    },
  };
}

export {
  GOOGLE_REALTIME_DEFAULT_API_VERSION,
  GOOGLE_REALTIME_DEFAULT_MODEL,
  GOOGLE_REALTIME_DEFAULT_VOICE,
};
export type { GoogleRealtimeVoiceProviderConfig };
