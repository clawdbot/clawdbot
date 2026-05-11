import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
  createRealtimeVoiceAgentTalkbackQueue,
  createRealtimeVoiceBridgeSession,
  createTalkSessionController,
  convertPcmToMulaw8k,
  extendRealtimeVoiceOutputEchoSuppression,
  getRealtimeVoiceBridgeEventHealth,
  getRealtimeVoiceTranscriptHealth,
  isLikelyRealtimeVoiceAssistantEchoTranscript,
  mulawToPcm,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  recordRealtimeVoiceBridgeEvent,
  recordTalkObservabilityEvent,
  recordRealtimeVoiceTranscript,
  resamplePcm,
  resolveConfiguredRealtimeVoiceProvider,
  type RealtimeVoiceAgentTalkbackQueue,
  type RealtimeVoiceBridgeEventLogEntry,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceProviderPlugin,
  type RealtimeVoiceTranscriptEntry,
  type TalkEvent,
  type TalkEventInput,
  type TalkSessionController,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  consultOpenClawAgentForGoogleMeet,
  handleGoogleMeetRealtimeConsultToolCall,
  resolveGoogleMeetRealtimeTools,
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

export type GoogleMeetRealtimeTranscriptEntry = RealtimeVoiceTranscriptEntry;
export const recordGoogleMeetRealtimeTranscript = recordRealtimeVoiceTranscript;

export function getGoogleMeetRealtimeTranscriptHealth(
  transcript: GoogleMeetRealtimeTranscriptEntry[],
): Pick<GoogleMeetChromeHealth, keyof ReturnType<typeof getRealtimeVoiceTranscriptHealth>> {
  return getRealtimeVoiceTranscriptHealth(transcript);
}

export type GoogleMeetRealtimeEventEntry = RealtimeVoiceBridgeEventLogEntry;

export const GOOGLE_MEET_AGENT_TRANSCRIPT_DEBOUNCE_MS = 900;
export const GOOGLE_MEET_OUTPUT_ECHO_SUPPRESSION_TAIL_MS = 3_000;
export const GOOGLE_MEET_TRANSCRIPT_ECHO_LOOKBACK_MS = 45_000;

export function recordGoogleMeetRealtimeEvent(
  events: GoogleMeetRealtimeEventEntry[],
  event: Parameters<typeof recordRealtimeVoiceBridgeEvent>[1],
): void {
  recordRealtimeVoiceBridgeEvent(events, event);
}

export function getGoogleMeetRealtimeEventHealth(
  events: GoogleMeetRealtimeEventEntry[],
): Pick<GoogleMeetChromeHealth, keyof ReturnType<typeof getRealtimeVoiceBridgeEventHealth>> {
  return getRealtimeVoiceBridgeEventHealth(events);
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

export function isGoogleMeetLikelyAssistantEchoTranscript(params: {
  transcript: GoogleMeetRealtimeTranscriptEntry[];
  text: string;
  nowMs?: number;
}): boolean {
  return isLikelyRealtimeVoiceAssistantEchoTranscript({
    ...params,
    lookbackMs: GOOGLE_MEET_TRANSCRIPT_ECHO_LOOKBACK_MS,
  });
}

export function extendGoogleMeetOutputEchoSuppression(params: {
  audio: Buffer;
  audioFormat: GoogleMeetConfig["chrome"]["audioFormat"];
  nowMs: number;
  lastOutputPlayableUntilMs: number;
  suppressInputUntilMs: number;
}): { lastOutputPlayableUntilMs: number; suppressInputUntilMs: number; durationMs: number } {
  const bytesPerMs = params.audioFormat === "g711-ulaw-8khz" ? 8 : 48;
  return extendRealtimeVoiceOutputEchoSuppression({
    ...params,
    bytesPerMs,
    tailMs: GOOGLE_MEET_OUTPUT_ECHO_SUPPRESSION_TAIL_MS,
  });
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

export function formatGoogleMeetTranscriptSummaryLog(prefix: string, text: string): string {
  return `[google-meet] ${prefix}: chars=${text.length}`;
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

export function pushGoogleMeetTalkEvent(
  events: TalkEvent[],
  event: TalkEvent,
  maxEntries = 40,
): void {
  events.push(event);
  if (events.length > maxEntries) {
    events.splice(0, events.length - maxEntries);
  }
}

export function summarizeGoogleMeetTalkEvents(
  events: TalkEvent[],
): NonNullable<GoogleMeetChromeHealth["recentTalkEvents"]> {
  return events.slice(-20).map((event) => ({
    id: event.id,
    type: event.type,
    sessionId: event.sessionId,
    turnId: event.turnId,
    seq: event.seq,
    timestamp: event.timestamp,
    final: event.final,
  }));
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
  let agentTalkback: RealtimeVoiceAgentTalkbackQueue | undefined;
  let ttsQueue = Promise.resolve();
  const transcript: GoogleMeetRealtimeTranscriptEntry[] = [];
  const resolved = resolveGoogleMeetRealtimeTranscriptionProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  const talk = createTalkSessionController(
    {
      sessionId: `google-meet:${params.meetingSessionId}:agent`,
      mode: "stt-tts",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: resolved.provider.id,
      turnIdPrefix: `google-meet:${params.meetingSessionId}:turn`,
    },
    { onEvent: recordTalkObservabilityEvent },
  );
  const recentTalkEvents: TalkEvent[] = [];
  const emitTalkEvent = (input: TalkEventInput) =>
    pushGoogleMeetTalkEvent(recentTalkEvents, talk.emit(input));
  const ensureTalkTurn = () => {
    const turn = talk.ensureTurn({
      payload: { meetingSessionId: params.meetingSessionId },
    });
    if (turn.event) {
      pushGoogleMeetTalkEvent(recentTalkEvents, turn.event);
    }
    return turn.turnId;
  };
  const endTalkTurn = () => {
    const ended = talk.endTurn({
      payload: { meetingSessionId: params.meetingSessionId },
    });
    if (ended.ok) {
      pushGoogleMeetTalkEvent(recentTalkEvents, ended.event);
    }
  };
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
    agentTalkback?.close();
    try {
      sttSession?.close();
    } catch (error) {
      params.logger.debug?.(
        `[google-meet] agent transcription bridge close ignored: ${formatErrorMessage(error)}`,
      );
    }
    emitTalkEvent({
      type: "session.closed",
      final: true,
      payload: { meetingSessionId: params.meetingSessionId },
    });
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
    emitTalkEvent({
      type: "output.audio.delta",
      turnId: ensureTalkTurn(),
      payload: { meetingSessionId: params.meetingSessionId, bytes: audio.byteLength },
    });
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
        params.logger.info(formatGoogleMeetTranscriptSummaryLog("agent assistant", normalized));
        const turnId = ensureTalkTurn();
        emitTalkEvent({
          type: "output.text.done",
          turnId,
          final: true,
          payload: { meetingSessionId: params.meetingSessionId, text: normalized },
        });
        const result = await params.runtime.tts.textToSpeechTelephony({
          text: normalized,
          cfg: params.fullConfig,
        });
        if (!result.success || !result.audioBuffer || !result.sampleRate) {
          throw new Error(result.error ?? "TTS conversion failed");
        }
        params.logger.info(formatGoogleMeetAgentTtsResultLog("agent", result));
        emitTalkEvent({
          type: "output.audio.started",
          turnId,
          payload: { meetingSessionId: params.meetingSessionId },
        });
        writeOutputAudio(
          convertGoogleMeetTtsAudioForBridge(
            result.audioBuffer,
            result.sampleRate,
            params.config,
            result.outputFormat,
          ),
        );
        emitTalkEvent({
          type: "output.audio.done",
          turnId,
          final: true,
          payload: { meetingSessionId: params.meetingSessionId },
        });
        endTalkTurn();
      })
      .catch((error) => {
        params.logger.warn(`[google-meet] agent TTS failed: ${formatErrorMessage(error)}`);
      });
  };

  agentTalkback = createRealtimeVoiceAgentTalkbackQueue({
    debounceMs: GOOGLE_MEET_AGENT_TRANSCRIPT_DEBOUNCE_MS,
    isStopped: () => stopped,
    logger: params.logger,
    logPrefix: "[google-meet] agent",
    responseStyle: "Brief, natural spoken answer for a live meeting.",
    fallbackText: "I hit an error while checking that. Please try again.",
    consult: ({ question, responseStyle }) =>
      consultOpenClawAgentForGoogleMeet({
        config: params.config,
        fullConfig: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        meetingSessionId: params.meetingSessionId,
        requesterSessionKey: params.requesterSessionKey,
        args: { question, responseStyle },
        transcript,
      }),
    deliver: enqueueSpeakText,
  });

  sttSession = resolved.provider.createSession({
    cfg: params.fullConfig,
    providerConfig: resolved.providerConfig,
    onTranscript: (text) => {
      const trimmed = text.trim();
      if (!trimmed || stopped) {
        return;
      }
      const turnId = ensureTalkTurn();
      emitTalkEvent({
        type: "input.audio.committed",
        turnId,
        final: true,
        payload: { meetingSessionId: params.meetingSessionId },
      });
      emitTalkEvent({
        type: "transcript.done",
        turnId,
        final: true,
        payload: { meetingSessionId: params.meetingSessionId, text: trimmed, role: "user" },
      });
      recordGoogleMeetRealtimeTranscript(transcript, "user", trimmed);
      params.logger.info(formatGoogleMeetTranscriptSummaryLog("agent user", trimmed));
      if (isGoogleMeetLikelyAssistantEchoTranscript({ transcript, text: trimmed })) {
        params.logger.info(
          formatGoogleMeetTranscriptSummaryLog("agent ignored assistant echo transcript", trimmed),
        );
        return;
      }
      agentTalkback?.enqueue(trimmed);
    },
    onError: (error) => {
      params.logger.warn(
        `[google-meet] agent transcription bridge failed: ${formatErrorMessage(error)}`,
      );
      emitTalkEvent({
        type: "session.error",
        final: true,
        payload: { meetingSessionId: params.meetingSessionId, error: formatErrorMessage(error) },
      });
      void stop();
    },
  });

  emitTalkEvent({
    type: "session.started",
    payload: { meetingSessionId: params.meetingSessionId, provider: resolved.provider.id },
  });
  await sttSession.connect();
  realtimeReady = true;
  emitTalkEvent({
    type: "session.ready",
    payload: { meetingSessionId: params.meetingSessionId },
  });

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
    emitTalkEvent({
      type: "input.audio.delta",
      turnId: ensureTalkTurn(),
      payload: { meetingSessionId: params.meetingSessionId, bytes: audio.byteLength },
    });
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
      recentTalkEvents: summarizeGoogleMeetTalkEvents(recentTalkEvents),
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
  let agentTalkback: RealtimeVoiceAgentTalkbackQueue | undefined;

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
    agentTalkback?.close();
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
  const talk: TalkSessionController = createTalkSessionController(
    {
      sessionId: `google-meet:${params.meetingSessionId}:command-realtime`,
      mode: "realtime",
      transport: "gateway-relay",
      brain: strategy === "bidi" ? "direct-tools" : "agent-consult",
      provider: resolved.provider.id,
    },
    { onEvent: recordTalkObservabilityEvent },
  );
  const recentTalkEvents: TalkEvent[] = [];
  const rememberTalkEvent = (event: TalkEvent | undefined): void => {
    if (event) {
      pushGoogleMeetTalkEvent(recentTalkEvents, event);
    }
  };
  const emitTalkEvent = (input: TalkEventInput): void => {
    rememberTalkEvent(talk.emit(input));
  };
  const ensureTalkTurn = (): string => {
    const turn = talk.ensureTurn({
      payload: { meetingSessionId: params.meetingSessionId },
    });
    if (turn.event) {
      rememberTalkEvent(turn.event);
    }
    return turn.turnId;
  };
  const finishOutputAudio = (reason: string): void => {
    rememberTalkEvent(
      talk.finishOutputAudio({
        payload: { reason },
      }),
    );
  };
  const endTalkTurn = (reason = "completed"): void => {
    const ended = talk.endTurn({
      payload: { reason },
    });
    if (ended.ok) {
      rememberTalkEvent(ended.event);
    }
  };
  emitTalkEvent({
    type: "session.started",
    payload: { meetingSessionId: params.meetingSessionId },
  });
  agentTalkback = createRealtimeVoiceAgentTalkbackQueue({
    debounceMs: GOOGLE_MEET_AGENT_TRANSCRIPT_DEBOUNCE_MS,
    isStopped: () => stopped,
    logger: params.logger,
    logPrefix: "[google-meet] realtime agent",
    responseStyle: "Brief, natural spoken answer for a live meeting.",
    fallbackText: "I hit an error while checking that. Please try again.",
    consult: ({ question, responseStyle }) =>
      consultOpenClawAgentForGoogleMeet({
        config: params.config,
        fullConfig: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        meetingSessionId: params.meetingSessionId,
        requesterSessionKey: params.requesterSessionKey,
        args: { question, responseStyle },
        transcript,
      }),
    deliver: (text) => {
      bridge?.sendUserMessage(buildGoogleMeetSpeakExactUserMessage(text));
    },
  });
  bridge = createRealtimeVoiceBridgeSession({
    provider: resolved.provider,
    cfg: params.fullConfig,
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
        const turnId = ensureTalkTurn();
        rememberTalkEvent(
          talk.startOutputAudio({
            turnId,
            payload: { meetingSessionId: params.meetingSessionId },
          }).event,
        );
        emitTalkEvent({
          type: "output.audio.delta",
          turnId,
          payload: { byteLength: audio.byteLength },
        });
        lastOutputAtMs = Date.now();
        lastOutputAt = new Date().toISOString();
        lastOutputBytes += audio.byteLength;
        suppressInputForOutput(audio);
        writeOutputAudio(audio);
      },
      clearAudio: () => {
        clearOutputPlayback();
        finishOutputAudio("clear");
      },
    },
    onTranscript: (role, text, isFinal) => {
      const turnId = ensureTalkTurn();
      const eventType =
        role === "assistant"
          ? isFinal
            ? "output.text.done"
            : "output.text.delta"
          : isFinal
            ? "transcript.done"
            : "transcript.delta";
      const payload = role === "assistant" ? { text } : { role, text };
      emitTalkEvent({
        type: eventType,
        turnId,
        payload,
        final: isFinal,
      });
      if (role === "user" && isFinal) {
        emitTalkEvent({
          type: "input.audio.committed",
          turnId,
          payload: { meetingSessionId: params.meetingSessionId },
          final: true,
        });
      }
      if (isFinal) {
        recordGoogleMeetRealtimeTranscript(transcript, role, text);
        params.logger.info(formatGoogleMeetTranscriptSummaryLog(`realtime ${role}`, text));
        if (role === "user" && strategy === "agent") {
          if (isGoogleMeetLikelyAssistantEchoTranscript({ transcript, text })) {
            params.logger.info(
              formatGoogleMeetTranscriptSummaryLog(
                "realtime ignored assistant echo transcript",
                text,
              ),
            );
            return;
          }
          agentTalkback?.enqueue(text);
        }
      }
    },
    onEvent: (event) => {
      recordGoogleMeetRealtimeEvent(realtimeEvents, event);
      if (event.type === "input_audio_buffer.speech_started") {
        ensureTalkTurn();
      } else if (event.type === "input_audio_buffer.speech_stopped") {
        const turnId = talk.activeTurnId;
        if (!turnId) {
          return;
        }
        emitTalkEvent({
          type: "input.audio.committed",
          turnId,
          payload: { meetingSessionId: params.meetingSessionId, source: event.type },
          final: true,
        });
      } else if (event.type === "response.done") {
        finishOutputAudio("response.done");
        endTalkTurn("response.done");
      } else if (event.type === "error") {
        emitTalkEvent({
          type: "session.error",
          payload: { message: event.detail ?? "Realtime provider error" },
          final: true,
        });
      }
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
      emitTalkEvent({
        type: "tool.call",
        turnId: ensureTalkTurn(),
        itemId: event.itemId,
        callId: event.callId,
        payload: { name: event.name, args: event.args },
      });
      const turnId = ensureTalkTurn();
      handleGoogleMeetRealtimeConsultToolCall({
        strategy,
        session,
        event,
        config: params.config,
        fullConfig: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        meetingSessionId: params.meetingSessionId,
        requesterSessionKey: params.requesterSessionKey,
        transcript,
        onTalkEvent: (input) => emitTalkEvent({ ...input, turnId: input.turnId ?? turnId }),
      });
    },
    onError: (error) => {
      emitTalkEvent({
        type: "session.error",
        payload: { message: formatErrorMessage(error) },
        final: true,
      });
      fail("realtime voice bridge")(error);
    },
    onClose: (reason) => {
      realtimeReady = false;
      finishOutputAudio(reason);
      emitTalkEvent({
        type: "session.closed",
        payload: { reason },
        final: true,
      });
      if (reason === "error") {
        void stop();
      }
    },
    onReady: () => {
      realtimeReady = true;
      emitTalkEvent({
        type: "session.ready",
        payload: { meetingSessionId: params.meetingSessionId },
      });
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
      emitTalkEvent({
        type: "input.audio.delta",
        turnId: ensureTalkTurn(),
        payload: { byteLength: audio.byteLength },
      });
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
      recentTalkEvents: summarizeGoogleMeetTalkEvents(recentTalkEvents),
      lastClearAt,
      clearCount,
      bridgeClosed: stopped,
    }),
    stop,
  };
}
