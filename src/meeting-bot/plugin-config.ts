import {
  asPositiveFiniteNumber,
  resolvePositiveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
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
import {
  resolveMeetingAudioRuntimeForFormat,
  type MeetingAudioBackendSelection,
} from "./audio-backend.js";
import type { MeetingRealtimeAudioFormat } from "./realtime-audio-format.js";
import type { MeetingRealtimeEngineConfig } from "./realtime-engine.js";

type MeetingPluginMode = "agent" | "bidi" | "transcribe";

export type MeetingPluginConfig = MeetingRealtimeEngineConfig & {
  enabled: boolean;
  defaultMode: MeetingPluginMode;
  chrome: MeetingRealtimeEngineConfig["chrome"] & {
    audioBackend: MeetingAudioBackendSelection;
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
    audioInputCommandOverride?: string[];
    audioOutputCommandOverride?: string[];
    bargeInInputCommand?: string[];
    bargeInRmsThreshold: number;
    bargeInPeakThreshold: number;
    bargeInCooldownMs: number;
  };
  chromeNode: { node?: string };
  realtime: MeetingRealtimeEngineConfig["realtime"] & {
    strategy: "agent" | "bidi";
    toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
  };
};

type MeetingPluginConfigOptions = {
  defaultRealtimeInstructions: string;
  resolveGatewayOperationTimeoutMs(config: MeetingPluginConfig): number;
};

const DEFAULT_AUDIO_BUFFER_BYTES = 4_096;
const DEFAULT_AUDIO_FORMAT: MeetingRealtimeAudioFormat = "pcm16-24khz";
const DEFAULT_MODE_HELP =
  "Agent consults OpenClaw, bidi uses direct realtime voice, and transcribe observes only.";
const CHROME_NODE_HELP = "Node id/name/IP that owns Chrome and the native virtual-audio backend.";

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolvePositiveNumber(value: unknown, fallback: number): number {
  return asPositiveFiniteNumber(value) ?? fallback;
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

function resolveAudioBackend(value: unknown): MeetingAudioBackendSelection {
  const normalized = normalizeOptionalLowercaseString(value)?.replaceAll("_", "-");
  return normalized === "blackhole-2ch" || normalized === "pipewire-pulse" ? normalized : "auto";
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
  const buildAudioCommands = (
    backend: MeetingAudioBackendSelection,
    format: MeetingRealtimeAudioFormat,
    bufferBytes: number,
  ) => {
    const platform =
      backend === "blackhole-2ch"
        ? "darwin"
        : backend === "pipewire-pulse"
          ? "linux"
          : process.platform;
    try {
      return resolveMeetingAudioRuntimeForFormat({ backend, bufferBytes, format, platform });
    } catch {
      return resolveMeetingAudioRuntimeForFormat({
        backend: "blackhole-2ch",
        bufferBytes,
        format,
        platform: "darwin",
      });
    }
  };
  const defaultAudioRuntime = buildAudioCommands(
    "auto",
    DEFAULT_AUDIO_FORMAT,
    DEFAULT_AUDIO_BUFFER_BYTES,
  );
  const defaults: MeetingPluginConfig = {
    enabled: true,
    defaultMode: "agent",
    chrome: {
      audioBackend: "auto",
      audioFormat: DEFAULT_AUDIO_FORMAT,
      audioBufferBytes: DEFAULT_AUDIO_BUFFER_BYTES,
      launch: true,
      guestName: "OpenClaw Agent",
      reuseExistingTab: true,
      autoJoin: true,
      joinTimeoutMs: 30_000,
      waitForInCallMs: 60_000,
      audioInputCommand: defaultAudioRuntime.inputCommand,
      audioOutputCommand: defaultAudioRuntime.outputCommand,
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
    const audioBackend = resolveAudioBackend(chrome.audioBackend);
    const generatedCommands = buildAudioCommands(audioBackend, audioFormat, audioBufferBytes);
    const audioInputCommandOverride = normalizeOptionalTrimmedStringList(chrome.audioInputCommand);
    const audioOutputCommandOverride = normalizeOptionalTrimmedStringList(
      chrome.audioOutputCommand,
    );
    const provider = normalizeOptionalString(realtime.provider) ?? defaults.realtime.provider;
    return {
      enabled: resolveBoolean(raw.enabled, defaults.enabled),
      defaultMode: resolveMode(raw.defaultMode),
      chrome: {
        audioBackend,
        audioFormat,
        audioBufferBytes,
        launch: resolveBoolean(chrome.launch, defaults.chrome.launch),
        browserProfile: normalizeOptionalString(chrome.browserProfile),
        guestName: normalizeOptionalString(chrome.guestName) ?? defaults.chrome.guestName,
        reuseExistingTab: resolveBoolean(chrome.reuseExistingTab, defaults.chrome.reuseExistingTab),
        autoJoin: resolveBoolean(chrome.autoJoin, defaults.chrome.autoJoin),
        joinTimeoutMs: resolveTimer(chrome.joinTimeoutMs, defaults.chrome.joinTimeoutMs),
        waitForInCallMs: resolveTimer(chrome.waitForInCallMs, defaults.chrome.waitForInCallMs),
        audioInputCommand: audioInputCommandOverride ?? generatedCommands.inputCommand,
        audioOutputCommand: audioOutputCommandOverride ?? generatedCommands.outputCommand,
        audioInputCommandOverride,
        audioOutputCommandOverride,
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
      "chrome.audioBackend": {
        label: "Chrome Audio Backend",
        help: "Auto selects BlackHole 2ch on macOS or PipeWire-Pulse on Linux.",
      },
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
    defaultAudioInputCommand: defaultAudioRuntime.inputCommand,
    defaultAudioOutputCommand: defaultAudioRuntime.outputCommand,
    resolveConfig,
    resolveGatewayOperationTimeoutMs: (config: MeetingPluginConfig) =>
      options.resolveGatewayOperationTimeoutMs(config),
  };
}
