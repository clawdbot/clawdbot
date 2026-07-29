import { resolvePositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawPluginConfigSchema } from "../plugins/plugin-config-schema.types.js";
import {
  resolveRealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceAgentConsultToolPolicy,
} from "../talk/agent-consult-tool.js";
import type { MeetingRealtimeAudioFormat } from "./realtime-audio-format.js";
import type { MeetingRealtimeEngineConfig } from "./realtime-engine.js";
import {
  buildMeetingSoxAudioCommands,
  type MeetingSoxAudioCommandParams,
} from "./sox-audio-command.js";

type MeetingPluginMode = "agent" | "bidi" | "transcribe";

export type MeetingPluginConfig = MeetingRealtimeEngineConfig & {
  enabled: boolean;
  defaultMode: MeetingPluginMode;
  chrome: MeetingRealtimeEngineConfig["chrome"] & {
    audioBackend: "blackhole-2ch";
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
  chromeNode: { node?: string };
  realtime: MeetingRealtimeEngineConfig["realtime"] & {
    strategy: "agent" | "bidi";
    agentId?: string;
    toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
  };
};

type MeetingSoxAudioDevice = Pick<MeetingSoxAudioCommandParams, "device" | "deviceType">;

type MeetingPluginConfigOptions = {
  defaultRealtimeInstructions: string;
  resolveGatewayOperationTimeoutMs(config: MeetingPluginConfig): number;
  resolveSoxAudioDevice(params: {
    format: MeetingRealtimeAudioFormat;
  }): MeetingSoxAudioDevice | undefined;
};

const DEFAULT_AUDIO_BUFFER_BYTES = 4_096;
const DEFAULT_AUDIO_FORMAT: MeetingRealtimeAudioFormat = "pcm16-24khz";
const DEFAULT_MODE_HELP =
  "Agent consults OpenClaw, bidi uses direct realtime voice, and transcribe observes only.";
const CHROME_NODE_HELP = "Node id/name/IP that owns Chrome, BlackHole, and SoX.";

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolvePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveTimer(value: unknown, fallback: number): number {
  return resolvePositiveTimerTimeoutMs(resolvePositiveNumber(value, fallback), fallback);
}

function resolveMode(value: unknown): MeetingPluginMode {
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized === "agent" || normalized === "bidi" || normalized === "transcribe"
    ? normalized
    : "agent";
}

function resolveAudioFormat(value: unknown): MeetingRealtimeAudioFormat {
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

export function createMeetingPluginConfigSchema(options: MeetingPluginConfigOptions) {
  const buildSoxCommands = (format: MeetingRealtimeAudioFormat, bufferBytes: number) =>
    buildMeetingSoxAudioCommands({
      bufferBytes,
      ...options.resolveSoxAudioDevice({ format }),
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
  const defaultSoxCommands = buildSoxCommands(DEFAULT_AUDIO_FORMAT, DEFAULT_AUDIO_BUFFER_BYTES);
  const defaults: MeetingPluginConfig = {
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
      audioInputCommand: defaultSoxCommands.inputCommand,
      audioOutputCommand: defaultSoxCommands.outputCommand,
      bargeInRmsThreshold: 650,
      bargeInPeakThreshold: 2_500,
      bargeInCooldownMs: 900,
    },
    chromeNode: {},
    realtime: {
      strategy: "agent",
      provider: "openai",
      transcriptionProvider: "openai",
      instructions: options.defaultRealtimeInstructions,
      introMessage: "Say exactly: I'm here and listening.",
      toolPolicy: "safe-read-only",
      providers: {},
    },
  };
  const resolveConfig = (input: unknown): MeetingPluginConfig => {
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
    const provider = normalizeOptionalString(realtime.provider) ?? defaults.realtime.provider;
    return {
      enabled: resolveBoolean(raw.enabled, defaults.enabled),
      defaultMode: resolveMode(raw.defaultMode),
      chrome: {
        audioBackend: "blackhole-2ch",
        audioFormat,
        audioBufferBytes,
        launch: resolveBoolean(chrome.launch, defaults.chrome.launch),
        browserProfile: normalizeOptionalString(chrome.browserProfile),
        guestName: normalizeOptionalString(chrome.guestName) ?? defaults.chrome.guestName,
        reuseExistingTab: resolveBoolean(chrome.reuseExistingTab, defaults.chrome.reuseExistingTab),
        autoJoin: resolveBoolean(chrome.autoJoin, defaults.chrome.autoJoin),
        joinTimeoutMs: resolveTimer(chrome.joinTimeoutMs, defaults.chrome.joinTimeoutMs),
        waitForInCallMs: resolveTimer(chrome.waitForInCallMs, defaults.chrome.waitForInCallMs),
        audioInputCommand:
          normalizeOptionalTrimmedStringList(chrome.audioInputCommand) ??
          generatedCommands.inputCommand,
        audioOutputCommand:
          normalizeOptionalTrimmedStringList(chrome.audioOutputCommand) ??
          generatedCommands.outputCommand,
        bargeInInputCommand: normalizeOptionalTrimmedStringList(chrome.bargeInInputCommand),
        bargeInRmsThreshold: resolvePositiveNumber(
          chrome.bargeInRmsThreshold,
          defaults.chrome.bargeInRmsThreshold,
        ),
        bargeInPeakThreshold: resolvePositiveNumber(
          chrome.bargeInPeakThreshold,
          defaults.chrome.bargeInPeakThreshold,
        ),
        bargeInCooldownMs: resolveTimer(
          chrome.bargeInCooldownMs,
          defaults.chrome.bargeInCooldownMs,
        ),
      },
      chromeNode: { node: normalizeOptionalString(chromeNode.node) },
      realtime: {
        strategy: normalizeOptionalLowercaseString(realtime.strategy) === "bidi" ? "bidi" : "agent",
        provider,
        transcriptionProvider:
          normalizeOptionalString(realtime.transcriptionProvider) ??
          defaults.realtime.transcriptionProvider,
        voiceProvider: normalizeOptionalString(realtime.voiceProvider),
        model: normalizeOptionalString(realtime.model),
        instructions:
          normalizeOptionalString(realtime.instructions) ?? defaults.realtime.instructions,
        introMessage:
          typeof realtime.introMessage === "string"
            ? realtime.introMessage.trim()
            : defaults.realtime.introMessage,
        agentId: normalizeOptionalString(realtime.agentId),
        toolPolicy: resolveRealtimeVoiceAgentConsultToolPolicy(
          realtime.toolPolicy,
          defaults.realtime.toolPolicy,
        ),
        providers: resolveProviders(realtime.providers),
      },
    };
  };
  const configSchema = {
    parse: resolveConfig,
    uiHints: {
      defaultMode: { label: "Default Mode", help: DEFAULT_MODE_HELP },
      "chrome.browserProfile": { label: "Chrome Profile", advanced: true },
      "chrome.guestName": { label: "Guest Name" },
      "chrome.waitForInCallMs": { label: "Wait For In-Call (ms)", advanced: true },
      "chrome.audioInputCommand": { label: "Audio Input Command", advanced: true },
      "chrome.audioOutputCommand": { label: "Audio Output Command", advanced: true },
      "chromeNode.node": { label: "Chrome Node", help: CHROME_NODE_HELP, advanced: true },
      "realtime.transcriptionProvider": { label: "Realtime Transcription Provider" },
      "realtime.voiceProvider": { label: "Bidi Voice Provider" },
      "realtime.model": { label: "Bidi Realtime Model", advanced: true },
      "realtime.instructions": { label: "Realtime Instructions", advanced: true },
      "realtime.introMessage": { label: "Realtime Intro Message" },
      "realtime.agentId": { label: "Realtime Consult Agent", advanced: true },
      "realtime.toolPolicy": { label: "Realtime Tool Policy", advanced: true },
    },
  } satisfies OpenClawPluginConfigSchema;
  return {
    configSchema,
    defaultAudioInputCommand: defaultSoxCommands.inputCommand,
    defaultAudioOutputCommand: defaultSoxCommands.outputCommand,
    resolveConfig,
    resolveGatewayOperationTimeoutMs: (config: MeetingPluginConfig) =>
      options.resolveGatewayOperationTimeoutMs(config),
  };
}
