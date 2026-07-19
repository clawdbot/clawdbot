import { buildMeetingSoxAudioCommands } from "openclaw/plugin-sdk/meeting-runtime";
import {
  addTimerTimeoutGraceMs,
  resolvePositiveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resolveRealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceAgentConsultToolPolicy,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  asRecord,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export type ZoomMeetingsMode = "agent" | "bidi" | "transcribe";
export type ZoomMeetingsTransport = "chrome" | "chrome-node";
export type ZoomMeetingsToolPolicy = RealtimeVoiceAgentConsultToolPolicy;
type ZoomMeetingsRealtimeStrategy = "agent" | "bidi";
type ZoomMeetingsAudioFormat = "pcm16-24khz" | "g711-ulaw-8khz";

export type ZoomMeetingsConfig = {
  enabled: boolean;
  defaultMode: ZoomMeetingsMode;
  chrome: {
    audioBackend: "blackhole-2ch";
    audioFormat: ZoomMeetingsAudioFormat;
    audioBufferBytes: number;
    launch: boolean;
    browserProfile?: string;
    guestName: string;
    reuseExistingTab: boolean;
    autoJoin: boolean;
    joinTimeoutMs: number;
    waitForInCallMs: number;
    audioInputCommand: string[];
    audioOutputCommand: string[];
    bargeInInputCommand?: string[];
    bargeInRmsThreshold: number;
    bargeInPeakThreshold: number;
    bargeInCooldownMs: number;
  };
  chromeNode: {
    node?: string;
  };
  realtime: {
    strategy: ZoomMeetingsRealtimeStrategy;
    provider?: string;
    transcriptionProvider?: string;
    voiceProvider?: string;
    model?: string;
    instructions?: string;
    introMessage?: string;
    agentId?: string;
    toolPolicy: ZoomMeetingsToolPolicy;
    providers: Record<string, Record<string, unknown>>;
  };
};

export function resolveZoomMeetingsGatewayOperationTimeoutMs(config: ZoomMeetingsConfig): number {
  return Math.max(
    60_000,
    addTimerTimeoutGraceMs(
      config.chrome.joinTimeoutMs,
      config.chrome.waitForInCallMs + config.chrome.joinTimeoutMs + 30_000,
    ) ?? 1,
  );
}

const DEFAULT_AUDIO_BUFFER_BYTES = 4_096;
const DEFAULT_AUDIO_FORMAT: ZoomMeetingsAudioFormat = "pcm16-24khz";

function buildSoxCommands(format: ZoomMeetingsAudioFormat, bufferBytes: number) {
  return buildMeetingSoxAudioCommands({
    bufferBytes,
    device: "BlackHole 2ch",
    deviceType: "coreaudio",
    format:
      format === "g711-ulaw-8khz"
        ? { sampleRate: 8_000, channels: 1, encoding: "mu-law", bits: 8 }
        : {
            sampleRate: 24_000,
            channels: 1,
            encoding: "signed-integer",
            bits: 16,
            endian: "little",
          },
  });
}

const DEFAULT_SOX_COMMANDS = buildSoxCommands(DEFAULT_AUDIO_FORMAT, DEFAULT_AUDIO_BUFFER_BYTES);

export const DEFAULT_ZOOM_MEETINGS_AUDIO_INPUT_COMMAND = DEFAULT_SOX_COMMANDS.inputCommand;
export const DEFAULT_ZOOM_MEETINGS_AUDIO_OUTPUT_COMMAND = DEFAULT_SOX_COMMANDS.outputCommand;

const DEFAULT_REALTIME_INSTRUCTIONS = `You are joining a private Zoom meeting as an OpenClaw voice transport. Keep spoken replies brief and natural. In agent mode, wait for OpenClaw consult results and speak them exactly. In bidi mode, answer directly and call ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} for deeper reasoning, current information, or tools.`;

const DEFAULT_CONFIG: ZoomMeetingsConfig = {
  enabled: true,
  defaultMode: "agent",
  chrome: {
    audioBackend: "blackhole-2ch",
    audioFormat: DEFAULT_AUDIO_FORMAT,
    audioBufferBytes: DEFAULT_AUDIO_BUFFER_BYTES,
    launch: true,
    guestName: "OpenClaw Agent",
    reuseExistingTab: true,
    autoJoin: true,
    joinTimeoutMs: 30_000,
    waitForInCallMs: 60_000,
    audioInputCommand: [...DEFAULT_ZOOM_MEETINGS_AUDIO_INPUT_COMMAND],
    audioOutputCommand: [...DEFAULT_ZOOM_MEETINGS_AUDIO_OUTPUT_COMMAND],
    bargeInRmsThreshold: 650,
    bargeInPeakThreshold: 2_500,
    bargeInCooldownMs: 900,
  },
  chromeNode: {},
  realtime: {
    strategy: "agent",
    provider: "openai",
    transcriptionProvider: "openai",
    instructions: DEFAULT_REALTIME_INSTRUCTIONS,
    introMessage: "Say exactly: I'm here and listening.",
    toolPolicy: "safe-read-only",
    providers: {},
  },
};

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolvePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveTimer(value: unknown, fallback: number): number {
  return resolvePositiveTimerTimeoutMs(resolvePositiveNumber(value, fallback), fallback);
}

function resolveMode(value: unknown): ZoomMeetingsMode {
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized === "agent" || normalized === "bidi" || normalized === "transcribe"
    ? normalized
    : DEFAULT_CONFIG.defaultMode;
}

function resolveAudioFormat(value: unknown): ZoomMeetingsAudioFormat {
  const normalized = normalizeOptionalLowercaseString(value)?.replaceAll("_", "-");
  return normalized === "g711-ulaw-8khz" ? normalized : DEFAULT_AUDIO_FORMAT;
}

function resolveProviders(value: unknown): Record<string, Record<string, unknown>> {
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [key, entry] of Object.entries(asRecord(value))) {
    const id = normalizeOptionalLowercaseString(key);
    if (id) {
      providers[id] = asRecord(entry);
    }
  }
  return providers;
}

export function resolveZoomMeetingsConfig(input: unknown): ZoomMeetingsConfig {
  const raw = asRecord(input);
  const chrome = asRecord(raw.chrome);
  const chromeNode = asRecord(raw.chromeNode);
  const realtime = asRecord(raw.realtime);
  const audioFormat = resolveAudioFormat(chrome.audioFormat);
  const audioBufferBytes = Math.max(
    17,
    Math.trunc(resolvePositiveNumber(chrome.audioBufferBytes, DEFAULT_AUDIO_BUFFER_BYTES)),
  );
  const generatedCommands = buildSoxCommands(audioFormat, audioBufferBytes);
  const provider = normalizeOptionalString(realtime.provider) ?? DEFAULT_CONFIG.realtime.provider;
  return {
    enabled: resolveBoolean(raw.enabled, DEFAULT_CONFIG.enabled),
    defaultMode: resolveMode(raw.defaultMode),
    chrome: {
      audioBackend: "blackhole-2ch",
      audioFormat,
      audioBufferBytes,
      launch: resolveBoolean(chrome.launch, DEFAULT_CONFIG.chrome.launch),
      browserProfile: normalizeOptionalString(chrome.browserProfile),
      guestName: normalizeOptionalString(chrome.guestName) ?? DEFAULT_CONFIG.chrome.guestName,
      reuseExistingTab: resolveBoolean(
        chrome.reuseExistingTab,
        DEFAULT_CONFIG.chrome.reuseExistingTab,
      ),
      autoJoin: resolveBoolean(chrome.autoJoin, DEFAULT_CONFIG.chrome.autoJoin),
      joinTimeoutMs: resolveTimer(chrome.joinTimeoutMs, DEFAULT_CONFIG.chrome.joinTimeoutMs),
      waitForInCallMs: resolveTimer(chrome.waitForInCallMs, DEFAULT_CONFIG.chrome.waitForInCallMs),
      audioInputCommand:
        normalizeOptionalTrimmedStringList(chrome.audioInputCommand) ??
        generatedCommands.inputCommand,
      audioOutputCommand:
        normalizeOptionalTrimmedStringList(chrome.audioOutputCommand) ??
        generatedCommands.outputCommand,
      bargeInInputCommand: normalizeOptionalTrimmedStringList(chrome.bargeInInputCommand),
      bargeInRmsThreshold: resolvePositiveNumber(
        chrome.bargeInRmsThreshold,
        DEFAULT_CONFIG.chrome.bargeInRmsThreshold,
      ),
      bargeInPeakThreshold: resolvePositiveNumber(
        chrome.bargeInPeakThreshold,
        DEFAULT_CONFIG.chrome.bargeInPeakThreshold,
      ),
      bargeInCooldownMs: resolveTimer(
        chrome.bargeInCooldownMs,
        DEFAULT_CONFIG.chrome.bargeInCooldownMs,
      ),
    },
    chromeNode: { node: normalizeOptionalString(chromeNode.node) },
    realtime: {
      strategy: normalizeOptionalLowercaseString(realtime.strategy) === "bidi" ? "bidi" : "agent",
      provider,
      transcriptionProvider:
        normalizeOptionalString(realtime.transcriptionProvider) ??
        DEFAULT_CONFIG.realtime.transcriptionProvider,
      voiceProvider: normalizeOptionalString(realtime.voiceProvider),
      model: normalizeOptionalString(realtime.model),
      instructions:
        normalizeOptionalString(realtime.instructions) ?? DEFAULT_CONFIG.realtime.instructions,
      introMessage:
        typeof realtime.introMessage === "string"
          ? realtime.introMessage.trim()
          : DEFAULT_CONFIG.realtime.introMessage,
      agentId: normalizeOptionalString(realtime.agentId),
      toolPolicy: resolveRealtimeVoiceAgentConsultToolPolicy(
        realtime.toolPolicy,
        DEFAULT_CONFIG.realtime.toolPolicy,
      ),
      providers: resolveProviders(realtime.providers),
    },
  };
}
