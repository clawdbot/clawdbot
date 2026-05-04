import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import {
  getRealtimeTranscriptionProvider,
  listRealtimeTranscriptionProviders,
  type RealtimeTranscriptionProviderConfig,
  type RealtimeTranscriptionProviderPlugin,
  type RealtimeTranscriptionSession,
} from "openclaw/plugin-sdk/realtime-transcription";
import {
  createRealtimeVoiceBridgeSession,
  convertPcmToMulaw8k,
  mulawToPcm,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  resamplePcm,
  resolveConfiguredRealtimeVoiceProvider,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceBridgeEvent,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  consultOpenClawAgentForGoogleMeet,
  GOOGLE_MEET_AGENT_CONSULT_TOOL_NAME,
  resolveGoogleMeetRealtimeTools,
  submitGoogleMeetConsultWorkingResponse,
} from "./agent-consult.js";
import type { GoogleMeetConfig } from "./config.js";
import type { GoogleMeetChromeHealth } from "./transports/types.js";

type BridgeProcess = {
  pid?: number;
  killed?: boolean;
  stdin?: Writable | null;
  stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: ["pipe" | "ignore", "pipe" | "ignore", "pipe" | "ignore"] },
) => BridgeProcess;

export type ChromeRealtimeAudioBridgeHandle = {
  providerId: string;
  inputCommand: string[];
  outputCommand: string[];
  speak: (instructions?: string) => void;
  getHealth: () => GoogleMeetChromeHealth;
  stop: () => Promise<void>;
};

type ResolvedRealtimeProvider = {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
};

type ResolvedRealtimeTranscriptionProvider = {
  provider: RealtimeTranscriptionProviderPlugin;
  providerConfig: RealtimeTranscriptionProviderConfig;
};

export type GoogleMeetRealtimeTranscriptEntry = {
  at: string;
  role: "user" | "assistant";
  text: string;
};

export function recordGoogleMeetRealtimeTranscript(
  transcript: GoogleMeetRealtimeTranscriptEntry[],
  role: "user" | "assistant",
  text: string,
): GoogleMeetRealtimeTranscriptEntry {
  const entry = { at: new Date().toISOString(), role, text };
  transcript.push(entry);
  if (transcript.length > 40) {
    transcript.splice(0, transcript.length - 40);
  }
  return entry;
}

export function getGoogleMeetRealtimeTranscriptHealth(
  transcript: GoogleMeetRealtimeTranscriptEntry[],
): Pick<
  GoogleMeetChromeHealth,
  | "realtimeTranscriptLines"
  | "lastRealtimeTranscriptAt"
  | "lastRealtimeTranscriptRole"
  | "lastRealtimeTranscriptText"
  | "recentRealtimeTranscript"
> {
  const last = transcript.at(-1);
  return {
    realtimeTranscriptLines: transcript.length,
    lastRealtimeTranscriptAt: last?.at,
    lastRealtimeTranscriptRole: last?.role,
    lastRealtimeTranscriptText: last?.text,
    recentRealtimeTranscript: transcript.slice(-5),
  };
}

export type GoogleMeetRealtimeEventEntry = RealtimeVoiceBridgeEvent & {
  at: string;
};

export const GOOGLE_MEET_AGENT_TRANSCRIPT_DEBOUNCE_MS = 900;
export const GOOGLE_MEET_OUTPUT_ECHO_SUPPRESSION_TAIL_MS = 3_000;
export const GOOGLE_MEET_TRANSCRIPT_ECHO_LOOKBACK_MS = 45_000;

export function recordGoogleMeetRealtimeEvent(
  events: GoogleMeetRealtimeEventEntry[],
  event: RealtimeVoiceBridgeEvent,
) {
  if (event.direction === "client" && event.type === "input_audio_buffer.append") {
    return;
  }
  events.push({ at: new Date().toISOString(), ...event });
  if (events.length > 40) {
    events.splice(0, events.length - 40);
  }
}

export function getGoogleMeetRealtimeEventHealth(
  events: GoogleMeetRealtimeEventEntry[],
): Pick<
  GoogleMeetChromeHealth,
  | "lastRealtimeEventAt"
  | "lastRealtimeEventType"
  | "lastRealtimeEventDetail"
  | "recentRealtimeEvents"
> {
  const last = events.at(-1);
  return {
    lastRealtimeEventAt: last?.at,
    lastRealtimeEventType: last ? `${last.direction}:${last.type}` : undefined,
    lastRealtimeEventDetail: last?.detail,
    recentRealtimeEvents: events.slice(-10),
  };
}

function splitCommand(argv: string[]): { command: string; args: string[] } {
  const [command, ...args] = argv;
  if (!command) {
    throw new Error("audio bridge command must not be empty");
  }
  return { command, args };
}

function readPcm16Stats(audio: Buffer): { rms: number; peak: number } {
  let sumSquares = 0;
  let peak = 0;
  let samples = 0;
  for (let offset = 0; offset + 1 < audio.byteLength; offset += 2) {
    const sample = audio.readInt16LE(offset);
    const abs = Math.abs(sample);
    peak = Math.max(peak, abs);
    sumSquares += sample * sample;
    samples += 1;
  }
  return {
    rms: samples > 0 ? Math.sqrt(sumSquares / samples) : 0,
    peak,
  };
}

function normalizeTranscriptForEchoMatch(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function hasMeaningfulEchoOverlap(userTokens: string[], assistantTokens: string[]): boolean {
  if (userTokens.length < 4 || assistantTokens.length < 4) {
    return false;
  }
  const uniqueUserTokens = [...new Set(userTokens)];
  if (uniqueUserTokens.length < 4) {
    return false;
  }
  const assistantTokenSet = new Set(assistantTokens);
  const overlap = uniqueUserTokens.filter((token) => assistantTokenSet.has(token)).length;
  return overlap / uniqueUserTokens.length >= 0.58;
}

export function isGoogleMeetLikelyAssistantEchoTranscript(params: {
  transcript: GoogleMeetRealtimeTranscriptEntry[];
  text: string;
  nowMs?: number;
}): boolean {
  const userTokens = normalizeTranscriptForEchoMatch(params.text);
  if (userTokens.length < 4) {
    return false;
  }
  const nowMs = params.nowMs ?? Date.now();
  const recentAssistantText = params.transcript
    .filter((entry) => {
      if (entry.role !== "assistant") {
        return false;
      }
      const at = Date.parse(entry.at);
      return Number.isFinite(at) && nowMs - at <= GOOGLE_MEET_TRANSCRIPT_ECHO_LOOKBACK_MS;
    })
    .slice(-6)
    .map((entry) => entry.text)
    .join(" ");
  if (!recentAssistantText.trim()) {
    return false;
  }
  const userNormalized = userTokens.join(" ");
  const assistantTokens = normalizeTranscriptForEchoMatch(recentAssistantText);
  const assistantNormalized = assistantTokens.join(" ");
  return (
    (userNormalized.length >= 18 && assistantNormalized.includes(userNormalized)) ||
    (assistantNormalized.length >= 18 && userNormalized.includes(assistantNormalized)) ||
    hasMeaningfulEchoOverlap(userTokens, assistantTokens)
  );
}

export function extendGoogleMeetOutputEchoSuppression(params: {
  audio: Buffer;
  audioFormat: GoogleMeetConfig["chrome"]["audioFormat"];
  nowMs: number;
  lastOutputPlayableUntilMs: number;
  suppressInputUntilMs: number;
}): { lastOutputPlayableUntilMs: number; suppressInputUntilMs: number; durationMs: number } {
  const bytesPerMs = params.audioFormat === "g711-ulaw-8khz" ? 8 : 48;
  const durationMs = Math.ceil(params.audio.byteLength / bytesPerMs);
  const playbackStartMs = Math.max(params.nowMs, params.lastOutputPlayableUntilMs);
  const playbackEndMs = playbackStartMs + durationMs;
  return {
    durationMs,
    lastOutputPlayableUntilMs: playbackEndMs,
    suppressInputUntilMs: Math.max(
      params.suppressInputUntilMs,
      playbackEndMs + GOOGLE_MEET_OUTPUT_ECHO_SUPPRESSION_TAIL_MS,
    ),
  };
}

export function resolveGoogleMeetRealtimeAudioFormat(config: GoogleMeetConfig) {
  return config.chrome.audioFormat === "g711-ulaw-8khz"
    ? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ
    : REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ;
}

export function convertGoogleMeetBridgeAudioForStt(
  audio: Buffer,
  config: GoogleMeetConfig,
): Buffer {
  if (config.chrome.audioFormat === "g711-ulaw-8khz") {
    return audio;
  }
  return convertPcmToMulaw8k(audio, 24_000);
}

export function convertGoogleMeetTtsAudioForBridge(
  audio: Buffer,
  sampleRate: number,
  config: GoogleMeetConfig,
  outputFormat?: string,
): Buffer {
  const sourceFormat = sourceTelephonyTtsFormat(outputFormat);
  if (
    config.chrome.audioFormat === "g711-ulaw-8khz" &&
    sourceFormat === "mulaw" &&
    sampleRate === 8_000
  ) {
    return audio;
  }
  const pcm = decodeGoogleMeetTelephonyTtsAudio(audio, sourceFormat);
  return config.chrome.audioFormat === "g711-ulaw-8khz"
    ? convertPcmToMulaw8k(pcm, sampleRate)
    : resamplePcm(pcm, sampleRate, 24_000);
}

type GoogleMeetTelephonyTtsFormat = "pcm" | "mulaw" | "alaw";

function sourceTelephonyTtsFormat(outputFormat: string | undefined): GoogleMeetTelephonyTtsFormat {
  const normalized = outputFormat?.trim().toLowerCase().replaceAll("_", "-") ?? "";
  if (
    !normalized ||
    normalized === "pcm" ||
    normalized.startsWith("pcm-") ||
    normalized.includes("pcm16") ||
    normalized.includes("16bit-mono-pcm")
  ) {
    return "pcm";
  }
  if (
    normalized === "mulaw" ||
    normalized === "ulaw" ||
    normalized.includes("mu-law") ||
    normalized.includes("mulaw") ||
    normalized.includes("ulaw")
  ) {
    return "mulaw";
  }
  if (normalized === "alaw" || normalized.includes("a-law") || normalized.includes("alaw")) {
    return "alaw";
  }
  throw new Error(`Unsupported telephony TTS output format for Google Meet: ${outputFormat}`);
}

function decodeGoogleMeetTelephonyTtsAudio(
  audio: Buffer,
  sourceFormat: GoogleMeetTelephonyTtsFormat,
): Buffer {
  switch (sourceFormat) {
    case "pcm":
      return audio;
    case "mulaw":
      return mulawToPcm(audio);
    case "alaw":
      return alawToPcm(audio);
  }
  return unsupportedGoogleMeetTelephonyTtsFormat(sourceFormat);
}

function unsupportedGoogleMeetTelephonyTtsFormat(_format: never): never {
  throw new Error("Unsupported telephony TTS output format for Google Meet");
}

function alawToPcm(alaw: Buffer): Buffer {
  const pcm = Buffer.alloc(alaw.length * 2);
  for (let index = 0; index < alaw.length; index += 1) {
    pcm.writeInt16LE(alawByteToLinear(alaw[index] ?? 0), index * 2);
  }
  return pcm;
}

function alawByteToLinear(value: number): number {
  const aLaw = value ^ 0x55;
  const sign = aLaw & 0x80;
  const exponent = (aLaw & 0x70) >> 4;
  const mantissa = aLaw & 0x0f;
  let sample = exponent === 0 ? (mantissa << 4) + 8 : ((mantissa << 4) + 0x108) << (exponent - 1);
  return sign ? sample : -sample;
}

export function resolveGoogleMeetRealtimeProvider(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  providers?: RealtimeVoiceProviderPlugin[];
}): ResolvedRealtimeProvider {
  const providerId = params.config.realtime.voiceProvider ?? params.config.realtime.provider;
  return resolveConfiguredRealtimeVoiceProvider({
    configuredProviderId: providerId,
    providerConfigs: params.config.realtime.providers,
    cfg: params.fullConfig,
    providers: params.providers,
    defaultModel: params.config.realtime.model,
    noRegisteredProviderMessage: "No configured realtime voice provider registered",
  });
}

export function resolveGoogleMeetRealtimeTranscriptionProvider(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  providers?: RealtimeTranscriptionProviderPlugin[];
}): ResolvedRealtimeTranscriptionProvider {
  const providers = params.providers ?? listRealtimeTranscriptionProviders(params.fullConfig);
  if (providers.length === 0) {
    throw new Error("No configured realtime transcription provider registered");
  }
  const providerId =
    params.config.realtime.transcriptionProvider ?? params.config.realtime.provider;
  const configuredProvider = providerId
    ? (params.providers?.find(
        (entry) => entry.id === providerId || entry.aliases?.includes(providerId),
      ) ?? getRealtimeTranscriptionProvider(providerId, params.fullConfig))
    : undefined;
  const provider = configuredProvider ?? providers[0];
  if (!provider) {
    throw new Error("No configured realtime transcription provider registered");
  }
  const rawConfig = providerId
    ? (params.config.realtime.providers[providerId] ??
      params.config.realtime.providers[provider.id] ??
      {})
    : (params.config.realtime.providers[provider.id] ?? {});
  const providerConfig = provider.resolveConfig
    ? provider.resolveConfig({ cfg: params.fullConfig, rawConfig })
    : rawConfig;
  if (!provider.isConfigured({ cfg: params.fullConfig, providerConfig })) {
    throw new Error(`Realtime transcription provider "${provider.id}" is not configured`);
  }
  return { provider, providerConfig };
}

export function buildGoogleMeetSpeakExactUserMessage(text: string): string {
  return [
    "Speak this exact OpenClaw answer to the meeting, without adding, removing, or rephrasing words.",
    `Answer: ${JSON.stringify(text)}`,
  ].join("\n");
}

function readLogString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatLogValue(value: string | undefined): string {
  const normalized = value?.replace(/\s+/g, "_").slice(0, 180);
  return normalized || "unknown";
}

function resolveProviderModelForLog(params: {
  provider: { defaultModel?: string };
  providerConfig: RealtimeVoiceProviderConfig | RealtimeTranscriptionProviderConfig;
  fallbackModel?: string;
}): string {
  return (
    readLogString(params.providerConfig.model) ??
    readLogString(params.providerConfig.modelId) ??
    readLogString(params.fallbackModel) ??
    readLogString(params.provider.defaultModel) ??
    "provider-default"
  );
}

export function formatGoogleMeetRealtimeVoiceModelLog(params: {
  strategy: string;
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  fallbackModel?: string;
  audioFormat: GoogleMeetConfig["chrome"]["audioFormat"];
}): string {
  return [
    `[google-meet] realtime voice bridge starting: strategy=${formatLogValue(params.strategy)}`,
    `provider=${formatLogValue(params.provider.id)}`,
    `model=${formatLogValue(
      resolveProviderModelForLog({
        provider: params.provider,
        providerConfig: params.providerConfig,
        fallbackModel: params.fallbackModel,
      }),
    )}`,
    `audioFormat=${formatLogValue(params.audioFormat)}`,
  ].join(" ");
}

export function formatGoogleMeetAgentAudioModelLog(params: {
  provider: RealtimeTranscriptionProviderPlugin;
  providerConfig: RealtimeTranscriptionProviderConfig;
  audioFormat: GoogleMeetConfig["chrome"]["audioFormat"];
}): string {
  return [
    `[google-meet] agent audio bridge starting: transcriptionProvider=${formatLogValue(
      params.provider.id,
    )}`,
    `transcriptionModel=${formatLogValue(
      resolveProviderModelForLog({
        provider: params.provider,
        providerConfig: params.providerConfig,
      }),
    )}`,
    "tts=telephony",
    `audioFormat=${formatLogValue(params.audioFormat)}`,
  ].join(" ");
}

type GoogleMeetTtsResultLogFields = {
  provider?: string;
  providerModel?: string;
  providerVoice?: string;
  outputFormat?: string;
  sampleRate?: number;
  fallbackFrom?: string;
};

export function formatGoogleMeetAgentTtsResultLog(
  prefix: string,
  result: GoogleMeetTtsResultLogFields,
): string {
  return [
    `[google-meet] ${prefix} TTS: provider=${formatLogValue(result.provider)}`,
    `model=${formatLogValue(result.providerModel)}`,
    `voice=${formatLogValue(result.providerVoice)}`,
    `outputFormat=${formatLogValue(result.outputFormat)}`,
    `sampleRate=${result.sampleRate ?? "unknown"}`,
    ...(result.fallbackFrom ? [`fallbackFrom=${formatLogValue(result.fallbackFrom)}`] : []),
  ].join(" ");
}

function normalizeGoogleMeetTtsPromptText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sayExactly = trimmed.match(/^say exactly:\s*(?<text>.+)$/is)?.groups?.text?.trim();
  if (sayExactly) {
    return sayExactly.replace(/^["']|["']$/g, "").trim() || trimmed;
  }
  return trimmed;
}

export async function startCommandAgentAudioBridge(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  meetingSessionId: string;
  requesterSessionKey?: string;
  inputCommand: string[];
  outputCommand: string[];
  logger: RuntimeLogger;
  providers?: RealtimeTranscriptionProviderPlugin[];
  spawn?: SpawnFn;
}): Promise<ChromeRealtimeAudioBridgeHandle> {
  const input = splitCommand(params.inputCommand);
  const output = splitCommand(params.outputCommand);
  const spawnFn: SpawnFn =
    params.spawn ??
    ((command, args, options) => spawn(command, args, options) as unknown as BridgeProcess);
  const outputProcess = spawnFn(output.command, output.args, {
    stdio: ["pipe", "ignore", "pipe"],
  });
  const inputProcess = spawnFn(input.command, input.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stopped = false;
  let sttSession: RealtimeTranscriptionSession | null = null;
  let realtimeReady = false;
  let lastInputAt: string | undefined;
  let lastOutputAt: string | undefined;
  let lastInputBytes = 0;
  let lastOutputBytes = 0;
  let suppressedInputBytes = 0;
  let lastSuppressedInputAt: string | undefined;
  let suppressInputUntil = 0;
  let lastOutputPlayableUntilMs = 0;
  let agentConsultActive = false;
  let pendingAgentQuestion: string | undefined;
  let agentConsultDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let ttsQueue = Promise.resolve();
  const transcript: GoogleMeetRealtimeTranscriptEntry[] = [];
  const resolved = resolveGoogleMeetRealtimeTranscriptionProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  params.logger.info(
    formatGoogleMeetAgentAudioModelLog({
      provider: resolved.provider,
      providerConfig: resolved.providerConfig,
      audioFormat: params.config.chrome.audioFormat,
    }),
  );

  const terminateProcess = (proc: BridgeProcess, signal: NodeJS.Signals = "SIGTERM") => {
    if (proc.killed && signal !== "SIGKILL") {
      return;
    }
    let exited = false;
    proc.on("exit", () => {
      exited = true;
    });
    try {
      proc.kill(signal);
    } catch {
      return;
    }
    if (signal === "SIGKILL") {
      return;
    }
    const timer = setTimeout(() => {
      if (!exited) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Process may have exited after the grace check.
        }
      }
    }, 1000);
    timer.unref?.();
  };

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (agentConsultDebounceTimer) {
      clearTimeout(agentConsultDebounceTimer);
      agentConsultDebounceTimer = undefined;
    }
    try {
      sttSession?.close();
    } catch (error) {
      params.logger.debug?.(
        `[google-meet] agent transcription bridge close ignored: ${formatErrorMessage(error)}`,
      );
    }
    terminateProcess(inputProcess);
    terminateProcess(outputProcess);
  };

  const fail = (label: string) => (error: Error) => {
    params.logger.warn(`[google-meet] ${label} failed: ${formatErrorMessage(error)}`);
    void stop();
  };
  inputProcess.on("error", fail("audio input command"));
  inputProcess.on("exit", (code, signal) => {
    if (!stopped) {
      params.logger.warn(`[google-meet] audio input command exited (${code ?? signal ?? "done"})`);
      void stop();
    }
  });
  inputProcess.stderr?.on("data", (chunk) => {
    params.logger.debug?.(`[google-meet] audio input: ${String(chunk).trim()}`);
  });
  outputProcess.on("error", fail("audio output command"));
  outputProcess.stdin?.on?.("error", fail("audio output command"));
  outputProcess.on("exit", (code, signal) => {
    if (!stopped) {
      params.logger.warn(`[google-meet] audio output command exited (${code ?? signal ?? "done"})`);
      void stop();
    }
  });
  outputProcess.stderr?.on("data", (chunk) => {
    params.logger.debug?.(`[google-meet] audio output: ${String(chunk).trim()}`);
  });

  const writeOutputAudio = (audio: Buffer) => {
    const suppression = extendGoogleMeetOutputEchoSuppression({
      audio,
      audioFormat: params.config.chrome.audioFormat,
      nowMs: Date.now(),
      lastOutputPlayableUntilMs,
      suppressInputUntilMs: suppressInputUntil,
    });
    suppressInputUntil = suppression.suppressInputUntilMs;
    lastOutputPlayableUntilMs = suppression.lastOutputPlayableUntilMs;
    lastOutputAt = new Date().toISOString();
    lastOutputBytes += audio.byteLength;
    try {
      outputProcess.stdin?.write(audio);
    } catch (error) {
      fail("audio output command")(error as Error);
    }
  };

  const enqueueSpeakText = (text: string | undefined) => {
    const normalized = normalizeGoogleMeetTtsPromptText(text);
    if (!normalized || stopped) {
      return;
    }
    ttsQueue = ttsQueue
      .then(async () => {
        if (stopped) {
          return;
        }
        recordGoogleMeetRealtimeTranscript(transcript, "assistant", normalized);
        params.logger.info(`[google-meet] agent assistant: ${normalized}`);
        const result = await params.runtime.tts.textToSpeechTelephony({
          text: normalized,
          cfg: params.fullConfig,
        });
        if (!result.success || !result.audioBuffer || !result.sampleRate) {
          throw new Error(result.error ?? "TTS conversion failed");
        }
        params.logger.info(formatGoogleMeetAgentTtsResultLog("agent", result));
        writeOutputAudio(
          convertGoogleMeetTtsAudioForBridge(
            result.audioBuffer,
            result.sampleRate,
            params.config,
            result.outputFormat,
          ),
        );
      })
      .catch((error) => {
        params.logger.warn(`[google-meet] agent TTS failed: ${formatErrorMessage(error)}`);
      });
  };

  const runAgentConsultForUserTranscript = async (question: string): Promise<void> => {
    const trimmed = question.trim();
    if (!trimmed || stopped) {
      return;
    }
    if (agentConsultActive) {
      pendingAgentQuestion = trimmed;
      return;
    }
    agentConsultActive = true;
    let nextQuestion: string | undefined = trimmed;
    try {
      while (nextQuestion) {
        if (stopped) {
          return;
        }
        const currentQuestion = nextQuestion;
        pendingAgentQuestion = undefined;
        params.logger.info(`[google-meet] agent consult: ${currentQuestion}`);
        const result = await consultOpenClawAgentForGoogleMeet({
          config: params.config,
          fullConfig: params.fullConfig,
          runtime: params.runtime,
          logger: params.logger,
          meetingSessionId: params.meetingSessionId,
          requesterSessionKey: params.requesterSessionKey,
          args: {
            question: currentQuestion,
            responseStyle: "Brief, natural spoken answer for a live meeting.",
          },
          transcript,
        });
        enqueueSpeakText(result.text);
        nextQuestion = pendingAgentQuestion;
      }
    } catch (error) {
      params.logger.warn(`[google-meet] agent consult failed: ${formatErrorMessage(error)}`);
      enqueueSpeakText("I hit an error while checking that. Please try again.");
    } finally {
      agentConsultActive = false;
      const queuedQuestion = pendingAgentQuestion;
      pendingAgentQuestion = undefined;
      if (queuedQuestion && !stopped) {
        void runAgentConsultForUserTranscript(queuedQuestion);
      }
    }
  };

  const enqueueAgentConsultForUserTranscript = (question: string): void => {
    const trimmed = question.trim();
    if (!trimmed || stopped) {
      return;
    }
    pendingAgentQuestion = pendingAgentQuestion ? `${pendingAgentQuestion}\n${trimmed}` : trimmed;
    if (agentConsultDebounceTimer) {
      clearTimeout(agentConsultDebounceTimer);
    }
    agentConsultDebounceTimer = setTimeout(() => {
      agentConsultDebounceTimer = undefined;
      const queuedQuestion = pendingAgentQuestion;
      pendingAgentQuestion = undefined;
      if (queuedQuestion && !stopped) {
        void runAgentConsultForUserTranscript(queuedQuestion);
      }
    }, GOOGLE_MEET_AGENT_TRANSCRIPT_DEBOUNCE_MS);
    agentConsultDebounceTimer.unref?.();
  };

  sttSession = resolved.provider.createSession({
    providerConfig: resolved.providerConfig,
    onTranscript: (text) => {
      const trimmed = text.trim();
      if (!trimmed || stopped) {
        return;
      }
      recordGoogleMeetRealtimeTranscript(transcript, "user", trimmed);
      params.logger.info(`[google-meet] agent user: ${trimmed}`);
      if (isGoogleMeetLikelyAssistantEchoTranscript({ transcript, text: trimmed })) {
        params.logger.info(`[google-meet] agent ignored assistant echo transcript: ${trimmed}`);
        return;
      }
      enqueueAgentConsultForUserTranscript(trimmed);
    },
    onError: (error) => {
      params.logger.warn(
        `[google-meet] agent transcription bridge failed: ${formatErrorMessage(error)}`,
      );
      void stop();
    },
  });

  await sttSession.connect();
  realtimeReady = true;

  inputProcess.stdout?.on("data", (chunk) => {
    if (stopped) {
      return;
    }
    const audio = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (Date.now() < suppressInputUntil) {
      lastSuppressedInputAt = new Date().toISOString();
      suppressedInputBytes += audio.byteLength;
      return;
    }
    lastInputAt = new Date().toISOString();
    lastInputBytes += audio.byteLength;
    sttSession?.sendAudio(convertGoogleMeetBridgeAudioForStt(audio, params.config));
  });

  return {
    providerId: resolved.provider.id,
    inputCommand: params.inputCommand,
    outputCommand: params.outputCommand,
    speak: enqueueSpeakText,
    getHealth: () => ({
      providerConnected: sttSession?.isConnected() ?? false,
      realtimeReady,
      audioInputActive: lastInputBytes > 0,
      audioOutputActive: lastOutputBytes > 0,
      lastInputAt,
      lastOutputAt,
      lastSuppressedInputAt,
      lastInputBytes,
      lastOutputBytes,
      suppressedInputBytes,
      ...getGoogleMeetRealtimeTranscriptHealth(transcript),
      bridgeClosed: stopped,
    }),
    stop,
  };
}

export async function startCommandRealtimeAudioBridge(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  meetingSessionId: string;
  requesterSessionKey?: string;
  inputCommand: string[];
  outputCommand: string[];
  logger: RuntimeLogger;
  providers?: RealtimeVoiceProviderPlugin[];
  spawn?: SpawnFn;
}): Promise<ChromeRealtimeAudioBridgeHandle> {
  const input = splitCommand(params.inputCommand);
  const output = splitCommand(params.outputCommand);
  const spawnFn: SpawnFn =
    params.spawn ??
    ((command, args, options) => spawn(command, args, options) as unknown as BridgeProcess);
  const spawnOutputProcess = () =>
    spawnFn(output.command, output.args, {
      stdio: ["pipe", "ignore", "pipe"],
    });
  let outputProcess = spawnOutputProcess();
  const inputProcess = spawnFn(input.command, input.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stopped = false;
  let bridge: RealtimeVoiceBridgeSession | null = null;
  let realtimeReady = false;
  let lastInputAt: string | undefined;
  let lastOutputAt: string | undefined;
  let lastInputBytes = 0;
  let lastOutputBytes = 0;
  let lastClearAt: string | undefined;
  let clearCount = 0;
  let suppressedInputBytes = 0;
  let lastSuppressedInputAt: string | undefined;
  let suppressInputUntil = 0;
  let lastOutputAtMs = 0;
  let lastOutputPlayableUntilMs = 0;
  let bargeInInputProcess: BridgeProcess | undefined;
  let agentConsultDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  const suppressInputForOutput = (audio: Buffer) => {
    const suppression = extendGoogleMeetOutputEchoSuppression({
      audio,
      audioFormat: params.config.chrome.audioFormat,
      nowMs: Date.now(),
      lastOutputPlayableUntilMs,
      suppressInputUntilMs: suppressInputUntil,
    });
    suppressInputUntil = suppression.suppressInputUntilMs;
    lastOutputPlayableUntilMs = suppression.lastOutputPlayableUntilMs;
  };

  const terminateProcess = (proc: BridgeProcess, signal: NodeJS.Signals = "SIGTERM") => {
    if (proc.killed && signal !== "SIGKILL") {
      return;
    }
    let exited = false;
    proc.on("exit", () => {
      exited = true;
    });
    try {
      proc.kill(signal);
    } catch {
      return;
    }
    if (signal === "SIGKILL") {
      return;
    }
    const timer = setTimeout(() => {
      if (!exited) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Process may have exited after the grace check.
        }
      }
    }, 1000);
    timer.unref?.();
  };

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (agentConsultDebounceTimer) {
      clearTimeout(agentConsultDebounceTimer);
      agentConsultDebounceTimer = undefined;
    }
    try {
      bridge?.close();
    } catch (error) {
      params.logger.debug?.(
        `[google-meet] realtime voice bridge close ignored: ${formatErrorMessage(error)}`,
      );
    }
    terminateProcess(inputProcess);
    terminateProcess(outputProcess);
    if (bargeInInputProcess) {
      terminateProcess(bargeInInputProcess);
    }
  };

  const fail = (label: string) => (error: Error) => {
    params.logger.warn(`[google-meet] ${label} failed: ${formatErrorMessage(error)}`);
    void stop();
  };
  const attachOutputProcessHandlers = (proc: BridgeProcess) => {
    proc.on("error", (error) => {
      if (proc !== outputProcess) {
        return;
      }
      fail("audio output command")(error);
    });
    proc.stdin?.on?.("error", (error: Error) => {
      if (proc !== outputProcess) {
        return;
      }
      fail("audio output command")(error);
    });
    proc.on("exit", (code, signal) => {
      if (proc !== outputProcess) {
        return;
      }
      if (!stopped) {
        params.logger.warn(
          `[google-meet] audio output command exited (${code ?? signal ?? "done"})`,
        );
        void stop();
      }
    });
    proc.stderr?.on("data", (chunk) => {
      params.logger.debug?.(`[google-meet] audio output: ${String(chunk).trim()}`);
    });
  };
  const clearOutputPlayback = () => {
    if (stopped) {
      return;
    }
    const previousOutput = outputProcess;
    outputProcess = spawnOutputProcess();
    attachOutputProcessHandlers(outputProcess);
    clearCount += 1;
    lastClearAt = new Date().toISOString();
    suppressInputUntil = 0;
    lastOutputPlayableUntilMs = 0;
    params.logger.debug?.(
      `[google-meet] cleared realtime audio output buffer by restarting playback command`,
    );
    terminateProcess(previousOutput, "SIGKILL");
  };
  const writeOutputAudio = (audio: Buffer) => {
    try {
      outputProcess.stdin?.write(audio);
    } catch (error) {
      fail("audio output command")(error as Error);
    }
  };
  const startHumanBargeInMonitor = () => {
    const commandArgv = params.config.chrome.bargeInInputCommand;
    if (!commandArgv) {
      return;
    }
    const command = splitCommand(commandArgv);
    let lastBargeInAt = 0;
    bargeInInputProcess = spawnFn(command.command, command.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    bargeInInputProcess.stdout?.on("data", (chunk) => {
      if (stopped || lastOutputAtMs === 0) {
        return;
      }
      const now = Date.now();
      const playbackActive = now <= Math.max(lastOutputPlayableUntilMs, suppressInputUntil);
      if (!playbackActive && now - lastOutputAtMs > 1000) {
        return;
      }
      if (now - lastBargeInAt < params.config.chrome.bargeInCooldownMs) {
        return;
      }
      const audio = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const stats = readPcm16Stats(audio);
      if (
        stats.rms < params.config.chrome.bargeInRmsThreshold &&
        stats.peak < params.config.chrome.bargeInPeakThreshold
      ) {
        return;
      }
      lastBargeInAt = now;
      suppressInputUntil = 0;
      const beforeClearCount = clearCount;
      bridge?.handleBargeIn({ audioPlaybackActive: true });
      if (beforeClearCount === clearCount) {
        clearOutputPlayback();
      }
      params.logger.debug?.(
        `[google-meet] human barge-in detected by local input (rms=${Math.round(
          stats.rms,
        )}, peak=${stats.peak})`,
      );
    });
    bargeInInputProcess.stderr?.on("data", (chunk) => {
      params.logger.debug?.(`[google-meet] barge-in input: ${String(chunk).trim()}`);
    });
    bargeInInputProcess.on("error", (error) => {
      params.logger.warn(`[google-meet] human barge-in input failed: ${formatErrorMessage(error)}`);
    });
    bargeInInputProcess.on("exit", (code, signal) => {
      if (!stopped) {
        params.logger.debug?.(
          `[google-meet] human barge-in input exited (${code ?? signal ?? "done"})`,
        );
      }
    });
  };
  inputProcess.on("error", fail("audio input command"));
  inputProcess.on("exit", (code, signal) => {
    if (!stopped) {
      params.logger.warn(`[google-meet] audio input command exited (${code ?? signal ?? "done"})`);
      void stop();
    }
  });
  attachOutputProcessHandlers(outputProcess);
  inputProcess.stderr?.on("data", (chunk) => {
    params.logger.debug?.(`[google-meet] audio input: ${String(chunk).trim()}`);
  });

  const resolved = resolveGoogleMeetRealtimeProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  const strategy = params.config.realtime.strategy;
  params.logger.info(
    formatGoogleMeetRealtimeVoiceModelLog({
      strategy,
      provider: resolved.provider,
      providerConfig: resolved.providerConfig,
      fallbackModel: params.config.realtime.model,
      audioFormat: params.config.chrome.audioFormat,
    }),
  );
  const transcript: GoogleMeetRealtimeTranscriptEntry[] = [];
  const realtimeEvents: GoogleMeetRealtimeEventEntry[] = [];
  let agentConsultActive = false;
  let pendingAgentQuestion: string | undefined;
  const enqueueAgentConsultForUserTranscript = (question: string): void => {
    const trimmed = question.trim();
    if (!trimmed || stopped) {
      return;
    }
    pendingAgentQuestion = pendingAgentQuestion ? `${pendingAgentQuestion}\n${trimmed}` : trimmed;
    if (agentConsultDebounceTimer) {
      clearTimeout(agentConsultDebounceTimer);
    }
    agentConsultDebounceTimer = setTimeout(() => {
      agentConsultDebounceTimer = undefined;
      const queuedQuestion = pendingAgentQuestion;
      pendingAgentQuestion = undefined;
      if (queuedQuestion && !stopped) {
        void runAgentConsultForUserTranscript(queuedQuestion);
      }
    }, GOOGLE_MEET_AGENT_TRANSCRIPT_DEBOUNCE_MS);
    agentConsultDebounceTimer.unref?.();
  };
  const runAgentConsultForUserTranscript = async (question: string): Promise<void> => {
    const trimmed = question.trim();
    if (!trimmed || stopped) {
      return;
    }
    if (agentConsultActive) {
      pendingAgentQuestion = trimmed;
      return;
    }
    agentConsultActive = true;
    let nextQuestion: string | undefined = trimmed;
    try {
      while (nextQuestion) {
        if (stopped) {
          return;
        }
        const currentQuestion = nextQuestion;
        pendingAgentQuestion = undefined;
        params.logger.info(`[google-meet] realtime agent consult: ${currentQuestion}`);
        const result = await consultOpenClawAgentForGoogleMeet({
          config: params.config,
          fullConfig: params.fullConfig,
          runtime: params.runtime,
          logger: params.logger,
          meetingSessionId: params.meetingSessionId,
          requesterSessionKey: params.requesterSessionKey,
          args: {
            question: currentQuestion,
            responseStyle: "Brief, natural spoken answer for a live meeting.",
          },
          transcript,
        });
        if (!stopped && result.text.trim()) {
          bridge?.sendUserMessage(buildGoogleMeetSpeakExactUserMessage(result.text.trim()));
        }
        nextQuestion = pendingAgentQuestion;
      }
    } catch (error) {
      params.logger.warn(
        `[google-meet] realtime agent consult failed: ${formatErrorMessage(error)}`,
      );
      if (!stopped) {
        bridge?.sendUserMessage(
          buildGoogleMeetSpeakExactUserMessage(
            "I hit an error while checking that. Please try again.",
          ),
        );
      }
    } finally {
      agentConsultActive = false;
      const queuedQuestion = pendingAgentQuestion;
      pendingAgentQuestion = undefined;
      if (queuedQuestion && !stopped) {
        void runAgentConsultForUserTranscript(queuedQuestion);
      }
    }
  };
  bridge = createRealtimeVoiceBridgeSession({
    provider: resolved.provider,
    providerConfig: resolved.providerConfig,
    audioFormat: resolveGoogleMeetRealtimeAudioFormat(params.config),
    instructions: params.config.realtime.instructions,
    initialGreetingInstructions: params.config.realtime.introMessage,
    autoRespondToAudio: strategy === "bidi",
    triggerGreetingOnReady: false,
    markStrategy: "ack-immediately",
    tools:
      strategy === "bidi" ? resolveGoogleMeetRealtimeTools(params.config.realtime.toolPolicy) : [],
    audioSink: {
      isOpen: () => !stopped,
      sendAudio: (audio) => {
        lastOutputAtMs = Date.now();
        lastOutputAt = new Date().toISOString();
        lastOutputBytes += audio.byteLength;
        suppressInputForOutput(audio);
        writeOutputAudio(audio);
      },
      clearAudio: clearOutputPlayback,
    },
    onTranscript: (role, text, isFinal) => {
      if (isFinal) {
        recordGoogleMeetRealtimeTranscript(transcript, role, text);
        params.logger.info(`[google-meet] realtime ${role}: ${text}`);
        if (role === "user" && strategy === "agent") {
          if (isGoogleMeetLikelyAssistantEchoTranscript({ transcript, text })) {
            params.logger.info(`[google-meet] realtime ignored assistant echo transcript: ${text}`);
            return;
          }
          enqueueAgentConsultForUserTranscript(text);
        }
      }
    },
    onEvent: (event) => {
      recordGoogleMeetRealtimeEvent(realtimeEvents, event);
      if (
        event.type === "error" ||
        event.type === "response.done" ||
        event.type === "input_audio_buffer.speech_started" ||
        event.type === "input_audio_buffer.speech_stopped" ||
        event.type === "conversation.item.input_audio_transcription.completed" ||
        event.type === "conversation.item.input_audio_transcription.failed"
      ) {
        const detail = event.detail ? ` ${event.detail}` : "";
        params.logger.info(`[google-meet] realtime ${event.direction}:${event.type}${detail}`);
      }
    },
    onToolCall: (event, session) => {
      if (strategy !== "bidi") {
        session.submitToolResult(event.callId || event.itemId, {
          error: `Tool "${event.name}" is only available in bidi realtime strategy`,
        });
        return;
      }
      if (event.name !== GOOGLE_MEET_AGENT_CONSULT_TOOL_NAME) {
        session.submitToolResult(event.callId || event.itemId, {
          error: `Tool "${event.name}" not available`,
        });
        return;
      }
      submitGoogleMeetConsultWorkingResponse(session, event.callId || event.itemId);
      void consultOpenClawAgentForGoogleMeet({
        config: params.config,
        fullConfig: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        meetingSessionId: params.meetingSessionId,
        requesterSessionKey: params.requesterSessionKey,
        args: event.args,
        transcript,
      })
        .then((result) => {
          session.submitToolResult(event.callId || event.itemId, result);
        })
        .catch((error: Error) => {
          session.submitToolResult(event.callId || event.itemId, {
            error: formatErrorMessage(error),
          });
        });
    },
    onError: fail("realtime voice bridge"),
    onClose: (reason) => {
      realtimeReady = false;
      if (reason === "error") {
        void stop();
      }
    },
    onReady: () => {
      realtimeReady = true;
    },
  });
  startHumanBargeInMonitor();

  inputProcess.stdout?.on("data", (chunk) => {
    const audio = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!stopped && audio.byteLength > 0) {
      if (Date.now() < suppressInputUntil) {
        lastSuppressedInputAt = new Date().toISOString();
        suppressedInputBytes += audio.byteLength;
        return;
      }
      lastInputAt = new Date().toISOString();
      lastInputBytes += audio.byteLength;
      bridge?.sendAudio(Buffer.from(audio));
    }
  });

  await bridge.connect();
  return {
    providerId: resolved.provider.id,
    inputCommand: params.inputCommand,
    outputCommand: params.outputCommand,
    speak: (instructions) => {
      bridge?.triggerGreeting(instructions);
    },
    getHealth: () => ({
      providerConnected: bridge?.bridge.isConnected() ?? false,
      realtimeReady,
      audioInputActive: lastInputBytes > 0,
      audioOutputActive: lastOutputBytes > 0,
      lastInputAt,
      lastOutputAt,
      lastSuppressedInputAt,
      lastInputBytes,
      lastOutputBytes,
      suppressedInputBytes,
      ...getGoogleMeetRealtimeTranscriptHealth(transcript),
      ...getGoogleMeetRealtimeEventHealth(realtimeEvents),
      lastClearAt,
      clearCount,
      bridgeClosed: stopped,
    }),
    stop,
  };
}
