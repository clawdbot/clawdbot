import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resolveRealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceAgentConsultToolPolicy,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export type GoogleMeetTransport = "chrome" | "chrome-node" | "twilio";
export type GoogleMeetMode = "agent" | "bidi" | "transcribe";
export type GoogleMeetModeInput = GoogleMeetMode | "realtime";
export type GoogleMeetRealtimeStrategy = "agent" | "bidi";
type GoogleMeetChromeAudioFormat = "pcm16-24khz" | "g711-ulaw-8khz";
export type GoogleMeetToolPolicy = RealtimeVoiceAgentConsultToolPolicy;

export type GoogleMeetConfig = {
  enabled: boolean;
  defaults: {
    meeting?: string;
  };
  preview: {
    enrollmentAcknowledged: boolean;
  };
  defaultTransport: GoogleMeetTransport;
  defaultMode: GoogleMeetMode;
  chrome: {
    audioBackend: "blackhole-2ch";
    audioFormat: GoogleMeetChromeAudioFormat;
    audioBufferBytes: number;
    launch: boolean;
    browserProfile?: string;
    guestName: string;
    reuseExistingTab: boolean;
    autoJoin: boolean;
    joinTimeoutMs: number;
    waitForInCallMs: number;
    audioInputCommand?: string[];
    audioOutputCommand?: string[];
    bargeInInputCommand?: string[];
    bargeInRmsThreshold: number;
    bargeInPeakThreshold: number;
    bargeInCooldownMs: number;
    audioBridgeCommand?: string[];
    audioBridgeHealthCommand?: string[];
  };
  chromeNode: {
    node?: string;
  };
  twilio: {
    defaultDialInNumber?: string;
    defaultPin?: string;
    defaultDtmfSequence?: string;
  };
  voiceCall: {
    enabled: boolean;
    gatewayUrl?: string;
    token?: string;
    requestTimeoutMs: number;
    dtmfDelayMs: number;
    postDtmfSpeechDelayMs: number;
    introMessage?: string;
  };
  realtime: {
    strategy: GoogleMeetRealtimeStrategy;
    provider?: string;
    transcriptionProvider?: string;
    voiceProvider?: string;
    model?: string;
    instructions?: string;
    introMessage?: string;
    agentId?: string;
    toolPolicy: GoogleMeetToolPolicy;
    providers: Record<string, Record<string, unknown>>;
  };
  oauth: {
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    accessToken?: string;
    expiresAt?: number;
  };
  auth: {
    provider: "google-oauth";
    clientId?: string;
    clientSecret?: string;
    tokenPath?: string;
  };
};

const SOX_DEFAULT_BUFFER_BYTES = 8192;
const SOX_MIN_BUFFER_BYTES = 17;
export const DEFAULT_GOOGLE_MEET_AUDIO_BUFFER_BYTES = SOX_DEFAULT_BUFFER_BYTES / 2;

function withSoxBuffer(command: readonly string[], bufferBytes: number): string[] {
  return [command[0] ?? "sox", "-q", "--buffer", String(bufferBytes), ...command.slice(2)];
}

const DEFAULT_GOOGLE_MEET_AUDIO_INPUT_COMMAND_BASE = [
  "sox",
  "-q",
  "-t",
  "coreaudio",
  "BlackHole 2ch",
  "-t",
  "raw",
  "-r",
  "24000",
  "-c",
  "1",
  "-e",
  "signed-integer",
  "-b",
  "16",
  "-L",
  "-",
] as const;

const DEFAULT_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND_BASE = [
  "sox",
  "-q",
  "-t",
  "raw",
  "-r",
  "24000",
  "-c",
  "1",
  "-e",
  "signed-integer",
  "-b",
  "16",
  "-L",
  "-",
  "-t",
  "coreaudio",
  "BlackHole 2ch",
] as const;

const LEGACY_GOOGLE_MEET_AUDIO_INPUT_COMMAND_BASE = [
  "rec",
  "-q",
  "-t",
  "raw",
  "-r",
  "8000",
  "-c",
  "1",
  "-e",
  "mu-law",
  "-b",
  "8",
  "-",
] as const;

const LEGACY_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND_BASE = [
  "play",
  "-q",
  "-t",
  "raw",
  "-r",
  "8000",
  "-c",
  "1",
  "-e",
  "mu-law",
  "-b",
  "8",
  "-",
] as const;

export const DEFAULT_GOOGLE_MEET_AUDIO_INPUT_COMMAND = withSoxBuffer(
  DEFAULT_GOOGLE_MEET_AUDIO_INPUT_COMMAND_BASE,
  DEFAULT_GOOGLE_MEET_AUDIO_BUFFER_BYTES,
);

export const DEFAULT_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND = withSoxBuffer(
  DEFAULT_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND_BASE,
  DEFAULT_GOOGLE_MEET_AUDIO_BUFFER_BYTES,
);

const DEFAULT_GOOGLE_MEET_CHROME_AUDIO_FORMAT: GoogleMeetChromeAudioFormat = "pcm16-24khz";
const DEFAULT_GOOGLE_MEET_BARGE_IN_RMS_THRESHOLD = 650;
const DEFAULT_GOOGLE_MEET_BARGE_IN_PEAK_THRESHOLD = 2500;
const DEFAULT_GOOGLE_MEET_BARGE_IN_COOLDOWN_MS = 900;

const DEFAULT_GOOGLE_MEET_REALTIME_INSTRUCTIONS = `You are joining a private Google Meet as an OpenClaw voice transport. Keep spoken replies brief and natural. In agent mode, wait for OpenClaw consult results and speak them exactly. In bidi mode, answer directly and call ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} for deeper reasoning, current information, or tools.`;
const DEFAULT_GOOGLE_MEET_REALTIME_INTRO_MESSAGE = "Say exactly: I'm here and listening.";

const DEFAULT_GOOGLE_MEET_CONFIG: GoogleMeetConfig = {
  enabled: true,
  defaults: {},
  preview: {
    enrollmentAcknowledged: false,
  },
  defaultTransport: "chrome",
  defaultMode: "agent",
  chrome: {
    audioBackend: "blackhole-2ch",
    audioFormat: DEFAULT_GOOGLE_MEET_CHROME_AUDIO_FORMAT,
    audioBufferBytes: DEFAULT_GOOGLE_MEET_AUDIO_BUFFER_BYTES,
    launch: true,
    guestName: "OpenClaw Agent",
    reuseExistingTab: true,
    autoJoin: true,
    joinTimeoutMs: 30_000,
    waitForInCallMs: 20_000,
    audioInputCommand: [...DEFAULT_GOOGLE_MEET_AUDIO_INPUT_COMMAND],
    audioOutputCommand: [...DEFAULT_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND],
    bargeInRmsThreshold: DEFAULT_GOOGLE_MEET_BARGE_IN_RMS_THRESHOLD,
    bargeInPeakThreshold: DEFAULT_GOOGLE_MEET_BARGE_IN_PEAK_THRESHOLD,
    bargeInCooldownMs: DEFAULT_GOOGLE_MEET_BARGE_IN_COOLDOWN_MS,
  },
  chromeNode: {},
  twilio: {},
  voiceCall: {
    enabled: true,
    requestTimeoutMs: 30_000,
    dtmfDelayMs: 12_000,
    postDtmfSpeechDelayMs: 5_000,
  },
  realtime: {
    strategy: "agent",
    provider: "openai",
    transcriptionProvider: "openai",
    instructions: DEFAULT_GOOGLE_MEET_REALTIME_INSTRUCTIONS,
    introMessage: DEFAULT_GOOGLE_MEET_REALTIME_INTRO_MESSAGE,
    toolPolicy: "safe-read-only",
    providers: {},
  },
  oauth: {},
  auth: {
    provider: "google-oauth",
  },
};

const GOOGLE_MEET_CLIENT_ID_KEYS = ["OPENCLAW_GOOGLE_MEET_CLIENT_ID", "GOOGLE_MEET_CLIENT_ID"];
const GOOGLE_MEET_CLIENT_SECRET_KEYS = [
  "OPENCLAW_GOOGLE_MEET_CLIENT_SECRET",
  "GOOGLE_MEET_CLIENT_SECRET",
] as const;
const GOOGLE_MEET_REFRESH_TOKEN_KEYS = [
  "OPENCLAW_GOOGLE_MEET_REFRESH_TOKEN",
  "GOOGLE_MEET_REFRESH_TOKEN",
] as const;
const GOOGLE_MEET_ACCESS_TOKEN_KEYS = [
  "OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN",
  "GOOGLE_MEET_ACCESS_TOKEN",
] as const;
const GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT_KEYS = [
  "OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT",
  "GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT",
] as const;
const GOOGLE_MEET_DEFAULT_MEETING_KEYS = [
  "OPENCLAW_GOOGLE_MEET_DEFAULT_MEETING",
  "GOOGLE_MEET_DEFAULT_MEETING",
] as const;
const GOOGLE_MEET_PREVIEW_ACK_KEYS = [
  "OPENCLAW_GOOGLE_MEET_PREVIEW_ACK",
  "GOOGLE_MEET_PREVIEW_ACK",
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readEnvString(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = normalizeOptionalString(env[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeStringAllowEmpty(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function readEnvBoolean(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean | undefined {
  const normalized = normalizeOptionalLowercaseString(readEnvString(env, keys));
  if (!normalized) {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function readEnvNumber(env: NodeJS.ProcessEnv, keys: readonly string[]): number | undefined {
  return resolveOptionalNumber(readEnvString(env, keys));
}

function resolveStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return normalized.length > 0 ? normalized : undefined;
}

function resolveProvidersConfig(value: unknown): Record<string, Record<string, unknown>> {
  const raw = asRecord(value);
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [key, entry] of Object.entries(raw)) {
    const providerId = normalizeOptionalLowercaseString(key);
    if (!providerId) {
      continue;
    }
    providers[providerId] = asRecord(entry);
  }
  return providers;
}

function resolveTransport(value: unknown, fallback: GoogleMeetTransport): GoogleMeetTransport {
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized === "chrome" || normalized === "chrome-node" || normalized === "twilio"
    ? normalized
    : fallback;
}

function resolveMode(value: unknown, fallback: GoogleMeetMode): GoogleMeetMode {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "realtime") {
    return "agent";
  }
  return normalized === "agent" || normalized === "bidi" || normalized === "transcribe"
    ? normalized
    : fallback;
}

function resolveRealtimeStrategy(
  value: unknown,
  fallback: GoogleMeetRealtimeStrategy,
): GoogleMeetRealtimeStrategy {
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized === "agent" || normalized === "bidi" ? normalized : fallback;
}

function resolveChromeAudioFormat(value: unknown): GoogleMeetChromeAudioFormat | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase().replaceAll("_", "-");
  switch (normalized) {
    case "pcm16-24khz":
    case "pcm16-24k":
    case "pcm24":
    case "pcm":
      return "pcm16-24khz";
    case "g711-ulaw-8khz":
    case "g711-ulaw-8k":
    case "g711-ulaw":
    case "mulaw":
    case "mu-law":
      return "g711-ulaw-8khz";
    default:
      return undefined;
  }
}

function resolveAudioBufferBytes(value: unknown, fallback: number): number {
  const number = resolveNumber(value, fallback);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return Math.max(SOX_MIN_BUFFER_BYTES, Math.trunc(number));
}

function defaultAudioInputCommand(
  format: GoogleMeetChromeAudioFormat,
  bufferBytes: number,
): string[] {
  return withSoxBuffer(
    format === "g711-ulaw-8khz"
      ? LEGACY_GOOGLE_MEET_AUDIO_INPUT_COMMAND_BASE
      : DEFAULT_GOOGLE_MEET_AUDIO_INPUT_COMMAND_BASE,
    bufferBytes,
  );
}

function defaultAudioOutputCommand(
  format: GoogleMeetChromeAudioFormat,
  bufferBytes: number,
): string[] {
  return withSoxBuffer(
    format === "g711-ulaw-8khz"
      ? LEGACY_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND_BASE
      : DEFAULT_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND_BASE,
    bufferBytes,
  );
}

export function resolveGoogleMeetConfig(input: unknown): GoogleMeetConfig {
  return resolveGoogleMeetConfigWithEnv(input);
}

export function resolveGoogleMeetConfigWithEnv(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
): GoogleMeetConfig {
  const raw = asRecord(input);
  const defaults = asRecord(raw.defaults);
  const preview = asRecord(raw.preview);
  const chrome = asRecord(raw.chrome);
  const configuredAudioInputCommand = resolveStringArray(chrome.audioInputCommand);
  const configuredAudioOutputCommand = resolveStringArray(chrome.audioOutputCommand);
  const hasCustomAudioCommand =
    configuredAudioInputCommand !== undefined || configuredAudioOutputCommand !== undefined;
  const audioFormat =
    resolveChromeAudioFormat(chrome.audioFormat) ??
    (hasCustomAudioCommand ? "g711-ulaw-8khz" : DEFAULT_GOOGLE_MEET_CONFIG.chrome.audioFormat);
  const audioBufferBytes = resolveAudioBufferBytes(
    chrome.audioBufferBytes,
    DEFAULT_GOOGLE_MEET_CONFIG.chrome.audioBufferBytes,
  );
  const chromeNode = asRecord(raw.chromeNode);
  const twilio = asRecord(raw.twilio);
  const voiceCall = asRecord(raw.voiceCall);
  const realtime = asRecord(raw.realtime);
  const realtimeProvider = normalizeOptionalString(realtime.provider);
  const resolvedRealtimeProvider = realtimeProvider ?? DEFAULT_GOOGLE_MEET_CONFIG.realtime.provider;
  const oauth = asRecord(raw.oauth);
  const auth = asRecord(raw.auth);

  return {
    enabled: resolveBoolean(raw.enabled, DEFAULT_GOOGLE_MEET_CONFIG.enabled),
    defaults: {
      meeting:
        normalizeOptionalString(defaults.meeting) ??
        readEnvString(env, GOOGLE_MEET_DEFAULT_MEETING_KEYS),
    },
    preview: {
      enrollmentAcknowledged: resolveBoolean(
        preview.enrollmentAcknowledged,
        readEnvBoolean(env, GOOGLE_MEET_PREVIEW_ACK_KEYS) ??
          DEFAULT_GOOGLE_MEET_CONFIG.preview.enrollmentAcknowledged,
      ),
    },
    defaultTransport: resolveTransport(
      raw.defaultTransport,
      DEFAULT_GOOGLE_MEET_CONFIG.defaultTransport,
    ),
    defaultMode: resolveMode(raw.defaultMode, DEFAULT_GOOGLE_MEET_CONFIG.defaultMode),
    chrome: {
      audioBackend: "blackhole-2ch",
      audioFormat,
      audioBufferBytes,
      launch: resolveBoolean(chrome.launch, DEFAULT_GOOGLE_MEET_CONFIG.chrome.launch),
      browserProfile: normalizeOptionalString(chrome.browserProfile),
      guestName:
        normalizeOptionalString(chrome.guestName) ?? DEFAULT_GOOGLE_MEET_CONFIG.chrome.guestName,
      reuseExistingTab: resolveBoolean(
        chrome.reuseExistingTab,
        DEFAULT_GOOGLE_MEET_CONFIG.chrome.reuseExistingTab,
      ),
      autoJoin: resolveBoolean(chrome.autoJoin, DEFAULT_GOOGLE_MEET_CONFIG.chrome.autoJoin),
      joinTimeoutMs: resolveNumber(
        chrome.joinTimeoutMs,
        DEFAULT_GOOGLE_MEET_CONFIG.chrome.joinTimeoutMs,
      ),
      waitForInCallMs: resolveNumber(
        chrome.waitForInCallMs,
        DEFAULT_GOOGLE_MEET_CONFIG.chrome.waitForInCallMs,
      ),
      audioInputCommand:
        configuredAudioInputCommand ?? defaultAudioInputCommand(audioFormat, audioBufferBytes),
      audioOutputCommand:
        configuredAudioOutputCommand ?? defaultAudioOutputCommand(audioFormat, audioBufferBytes),
      bargeInInputCommand: resolveStringArray(chrome.bargeInInputCommand),
      bargeInRmsThreshold: resolveNumber(
        chrome.bargeInRmsThreshold,
        DEFAULT_GOOGLE_MEET_CONFIG.chrome.bargeInRmsThreshold,
      ),
      bargeInPeakThreshold: resolveNumber(
        chrome.bargeInPeakThreshold,
        DEFAULT_GOOGLE_MEET_CONFIG.chrome.bargeInPeakThreshold,
      ),
      bargeInCooldownMs: resolveNumber(
        chrome.bargeInCooldownMs,
        DEFAULT_GOOGLE_MEET_CONFIG.chrome.bargeInCooldownMs,
      ),
      audioBridgeCommand: resolveStringArray(chrome.audioBridgeCommand),
      audioBridgeHealthCommand: resolveStringArray(chrome.audioBridgeHealthCommand),
    },
    chromeNode: {
      node: normalizeOptionalString(chromeNode.node),
    },
    twilio: {
      defaultDialInNumber: normalizeOptionalString(twilio.defaultDialInNumber),
      defaultPin: normalizeOptionalString(twilio.defaultPin),
      defaultDtmfSequence: normalizeOptionalString(twilio.defaultDtmfSequence),
    },
    voiceCall: {
      enabled: resolveBoolean(voiceCall.enabled, DEFAULT_GOOGLE_MEET_CONFIG.voiceCall.enabled),
      gatewayUrl: normalizeOptionalString(voiceCall.gatewayUrl),
      token: normalizeOptionalString(voiceCall.token),
      requestTimeoutMs: resolveNumber(
        voiceCall.requestTimeoutMs,
        DEFAULT_GOOGLE_MEET_CONFIG.voiceCall.requestTimeoutMs,
      ),
      dtmfDelayMs: resolveNumber(
        voiceCall.dtmfDelayMs,
        DEFAULT_GOOGLE_MEET_CONFIG.voiceCall.dtmfDelayMs,
      ),
      postDtmfSpeechDelayMs: resolveNumber(
        voiceCall.postDtmfSpeechDelayMs,
        DEFAULT_GOOGLE_MEET_CONFIG.voiceCall.postDtmfSpeechDelayMs,
      ),
      introMessage: normalizeOptionalString(voiceCall.introMessage),
    },
    realtime: {
      strategy: resolveRealtimeStrategy(
        realtime.strategy,
        DEFAULT_GOOGLE_MEET_CONFIG.realtime.strategy,
      ),
      provider: resolvedRealtimeProvider,
      transcriptionProvider:
        normalizeOptionalString(realtime.transcriptionProvider) ??
        (realtimeProvider && realtimeProvider !== "google"
          ? resolvedRealtimeProvider
          : DEFAULT_GOOGLE_MEET_CONFIG.realtime.transcriptionProvider),
      voiceProvider: normalizeOptionalString(realtime.voiceProvider),
      model: normalizeOptionalString(realtime.model) ?? DEFAULT_GOOGLE_MEET_CONFIG.realtime.model,
      instructions:
        normalizeOptionalString(realtime.instructions) ??
        DEFAULT_GOOGLE_MEET_CONFIG.realtime.instructions,
      introMessage:
        normalizeStringAllowEmpty(realtime.introMessage) ??
        DEFAULT_GOOGLE_MEET_CONFIG.realtime.introMessage,
      agentId: normalizeOptionalString(realtime.agentId),
      toolPolicy: resolveRealtimeVoiceAgentConsultToolPolicy(
        realtime.toolPolicy,
        DEFAULT_GOOGLE_MEET_CONFIG.realtime.toolPolicy,
      ),
      providers: resolveProvidersConfig(realtime.providers),
    },
    oauth: {
      clientId:
        normalizeOptionalString(oauth.clientId) ??
        normalizeOptionalString(auth.clientId) ??
        readEnvString(env, GOOGLE_MEET_CLIENT_ID_KEYS),
      clientSecret:
        normalizeOptionalString(oauth.clientSecret) ??
        normalizeOptionalString(auth.clientSecret) ??
        readEnvString(env, GOOGLE_MEET_CLIENT_SECRET_KEYS),
      refreshToken:
        normalizeOptionalString(oauth.refreshToken) ??
        readEnvString(env, GOOGLE_MEET_REFRESH_TOKEN_KEYS),
      accessToken:
        normalizeOptionalString(oauth.accessToken) ??
        readEnvString(env, GOOGLE_MEET_ACCESS_TOKEN_KEYS),
      expiresAt:
        resolveOptionalNumber(oauth.expiresAt) ??
        readEnvNumber(env, GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT_KEYS),
    },
    auth: {
      provider: "google-oauth",
      clientId: normalizeOptionalString(auth.clientId),
      clientSecret: normalizeOptionalString(auth.clientSecret),
      tokenPath: normalizeOptionalString(auth.tokenPath),
    },
  };
}
