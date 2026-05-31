import { PassThrough } from "node:stream";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import {
  buildRealtimeVoiceAgentConsultChatMessage,
  buildRealtimeVoiceAgentConsultPolicyInstructions,
  classifySkippableRealtimeVoiceConsultTranscript,
  controlRealtimeVoiceAgentRun,
  createRealtimeVoiceAgentTalkbackQueue,
  createRealtimeVoiceBridgeSession,
  createRealtimeVoiceForcedConsultCoordinator,
  createRealtimeVoiceOutputActivityTracker,
  createRealtimeVoiceTurnContextTracker,
  matchRealtimeVoiceActivationName,
  matchRealtimeVoiceConsultQuestions,
  normalizeSupportedRealtimeVoiceActivationName,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  parseRealtimeVoiceAgentControlToolArgs,
  resolveConfiguredRealtimeVoiceProvider,
  resolveRealtimeVoiceAgentConsultToolPolicy,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  type RealtimeVoiceBridgeEvent,
  type RealtimeVoiceAgentTalkbackQueue,
  type RealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceAgentControlResult,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceToolCallEvent,
  type RealtimeVoiceForcedConsultCoordinator,
  type RealtimeVoiceForcedConsultHandle,
  type RealtimeVoiceOutputActivityTracker,
  type RealtimeVoiceTurnContextHandle,
  type RealtimeVoiceTurnContextTracker,
  sortRealtimeVoiceActivationNames,
  type RealtimeVoiceActivationNameTranscriptResult,
} from "openclaw/plugin-sdk/realtime-voice";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { asBoolean, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { maybeControlDiscordVoiceAgentRun } from "./agent-control.js";
import {
  createDiscordOpusEncodeStream,
  convertDiscordPcm48kStereoToRealtimePcm24kMono,
  convertRealtimePcm24kMonoToDiscordPcm48kStereo,
} from "./audio.js";
import { formatVoiceIngressPrompt } from "./prompt.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";
import {
  logVoiceVerbose,
  type VoiceRealtimeAgentTurnParams,
  type VoiceRealtimeSession,
  type VoiceRealtimeSpeakerContext,
  type VoiceRealtimeSpeakerTurn,
  type VoiceSessionEntry,
} from "./session.js";

const logger = createSubsystemLogger("discord/voice");

function resolveDiscordRealtimeVoiceAgentConsultTools(policy: RealtimeVoiceAgentConsultToolPolicy) {
  const tools = resolveRealtimeVoiceAgentConsultTools(policy);
  if (
    policy !== "none" &&
    !tools.some((tool) => tool.name === REALTIME_VOICE_AGENT_CONTROL_TOOL.name)
  ) {
    return [...tools, REALTIME_VOICE_AGENT_CONTROL_TOOL];
  }
  return tools;
}
const DISCORD_REALTIME_TALKBACK_DEBOUNCE_MS = 350;
const DISCORD_REALTIME_FALLBACK_TEXT = "I hit an error while checking that. Please try again.";
const DISCORD_REALTIME_PENDING_SPEAKER_CONTEXT_LIMIT = 32;
const DISCORD_REALTIME_RECENT_AGENT_PROXY_CONSULT_LIMIT = 16;
const DISCORD_REALTIME_RECENT_AGENT_PROXY_CONSULT_TTL_MS = 15_000;
const DISCORD_REALTIME_IGNORED_WAKE_NAME_CONTEXT_TTL_MS = 10_000;
const DISCORD_REALTIME_WAKE_NAME_FOLLOWUP_TTL_MS = 10_000;
const DISCORD_REALTIME_LOG_PREVIEW_CHARS = 500;
const DISCORD_REALTIME_DEFAULT_MIN_BARGE_IN_AUDIO_END_MS = 250;
const DISCORD_REALTIME_FORCED_CONSULT_FALLBACK_DELAY_MS = 200;
const DISCORD_REALTIME_DUPLICATE_ERROR_SUPPRESS_MS = 60_000;
const DISCORD_REALTIME_CONTROL_SPEECH_DEDUPE_MS = 5_000;
const DISCORD_REALTIME_OUTPUT_PLAYBACK_WATCHDOG_MARGIN_MS = 1_500;
const DISCORD_REALTIME_WAKE_ACKS = ["Yeah.", "Mm-hmm.", "Got it.", "One sec."];
const DISCORD_REALTIME_PARTIAL_TRANSCRIPT_MAX_CHARS = 240;
const REALTIME_PCM16_BYTES_PER_SAMPLE = 2;
const DISCORD_RAW_PCM_FRAME_BYTES = 3_840;
const DISCORD_REALTIME_OUTPUT_PREROLL_FRAMES = 25;
const DISCORD_REALTIME_TRAILING_SILENCE_MIN_MS = 700;
const DISCORD_REALTIME_TRAILING_SILENCE_MAX_MS = 3_000;
const DISCORD_REALTIME_FORCED_CONSULT_REASON =
  "provider_final_transcript_without_openclaw_agent_consult";
const DISCORD_REALTIME_VERBOSE_OMITTED_EVENTS = new Set([
  "conversation.output_audio.delta",
  "input_audio_buffer.append",
  "response.audio.delta",
  "response.output_audio.delta",
]);

export type DiscordVoiceMode = "stt-tts" | "agent-proxy" | "bidi";

type DiscordRealtimeSpeakerContext = VoiceRealtimeSpeakerContext & { userId: string };

type DiscordRealtimeVoiceConfig = NonNullable<DiscordAccountConfig["voice"]>["realtime"];

type PendingSpeakerTurnStats = {
  inputDiscordBytes: number;
  inputRealtimeBytes: number;
  inputChunks: number;
  interruptedPlayback: boolean;
};

type PendingSpeakerTurn = RealtimeVoiceTurnContextHandle<
  DiscordRealtimeSpeakerContext,
  PendingSpeakerTurnStats
>;

type TranscriptUtteranceAttribution = {
  context: DiscordRealtimeSpeakerContext;
  startedAt: number;
};

type RecentAgentProxyConsultResult =
  | { status: "fulfilled"; text: string }
  | { status: "rejected"; error: string };

type AgentProxyConsultState = {
  speaker: DiscordRealtimeSpeakerContext;
  handledByForcedPlayback?: boolean;
  promise?: Promise<string>;
  result?: RecentAgentProxyConsultResult;
};

type AgentProxyConsultHandle = RealtimeVoiceForcedConsultHandle<AgentProxyConsultState>;

function formatRealtimeLogPreview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= DISCORD_REALTIME_LOG_PREVIEW_CHARS) {
    return oneLine;
  }
  return `${oneLine.slice(0, DISCORD_REALTIME_LOG_PREVIEW_CHARS)}...`;
}

function formatRealtimeInterruptionLog(event: RealtimeVoiceBridgeEvent): string | undefined {
  const detail = event.detail ? ` ${event.detail}` : "";
  if (event.direction === "client") {
    if (event.type === "response.cancel") {
      return `discord voice: realtime model interrupt requested ${event.direction}:${event.type}${detail}`;
    }
    if (event.type === "conversation.item.truncate.skipped") {
      return `discord voice: realtime model interrupt ignored ${event.direction}:${event.type}${detail}`;
    }
    if (event.type === "conversation.item.truncate") {
      return `discord voice: realtime model audio truncated ${event.direction}:${event.type}${detail}`;
    }
  }
  if (event.direction === "server") {
    if (event.type === "response.cancelled") {
      return `discord voice: realtime model interrupt confirmed ${event.direction}:${event.type}${detail}`;
    }
    if (event.type === "response.done" && event.detail?.includes("status=cancelled")) {
      return `discord voice: realtime model interrupt confirmed ${event.direction}:${event.type}${detail}`;
    }
    if (
      event.type === "error" &&
      event.detail === "Cancellation failed: no active response found"
    ) {
      return `discord voice: realtime model interrupt raced ${event.direction}:${event.type}${detail}`;
    }
  }
  return undefined;
}

function formatRealtimeLifecycleLog(event: RealtimeVoiceBridgeEvent): string | undefined {
  if (!event.type.startsWith("session.")) {
    return undefined;
  }
  const detail = event.detail ? ` ${event.detail}` : "";
  return `discord voice: realtime lifecycle ${event.direction}:${event.type}${detail}`;
}

function isRealtimeResponseCancelled(event: RealtimeVoiceBridgeEvent): boolean {
  return (
    event.direction === "server" &&
    (event.type === "response.cancelled" ||
      (event.type === "response.done" && event.detail?.includes("status=cancelled") === true))
  );
}

function shouldLogRealtimeVerboseEvent(event: RealtimeVoiceBridgeEvent): boolean {
  return !DISCORD_REALTIME_VERBOSE_OMITTED_EVENTS.has(event.type);
}

function readProviderConfigString(
  config: RealtimeVoiceProviderConfig,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readProviderConfigBoolean(
  config: RealtimeVoiceProviderConfig | undefined,
  key: string,
): boolean | undefined {
  return asBoolean(config?.[key]);
}

export function resolveDiscordVoiceMode(voice: DiscordAccountConfig["voice"]): DiscordVoiceMode {
  const mode = voice?.mode;
  if (mode === "stt-tts" || mode === "bidi") {
    return mode;
  }
  return "agent-proxy";
}

export function isDiscordRealtimeVoiceMode(
  mode: DiscordVoiceMode,
): mode is Exclude<DiscordVoiceMode, "stt-tts"> {
  return mode === "agent-proxy" || mode === "bidi";
}

function isDiscordAgentProxyVoiceMode(mode: DiscordVoiceMode): boolean {
  return mode === "agent-proxy";
}

export function resolveDiscordRealtimeInterruptResponseOnInputAudio(params: {
  realtimeConfig: DiscordRealtimeVoiceConfig;
  providerId: string;
}): boolean {
  const providerConfig = params.realtimeConfig?.providers?.[params.providerId];
  return readProviderConfigBoolean(providerConfig, "interruptResponseOnInputAudio") ?? true;
}

export function resolveDiscordRealtimeBargeIn(params: {
  realtimeConfig: DiscordRealtimeVoiceConfig;
  providerId: string;
}): boolean {
  const configured = params.realtimeConfig?.bargeIn;
  if (typeof configured === "boolean") {
    return configured;
  }
  return resolveDiscordRealtimeInterruptResponseOnInputAudio(params);
}

export function buildDiscordSpeakExactUserMessage(text: string): string {
  return [
    "Internal OpenClaw voice playback result.",
    "Do not call openclaw_agent_consult or any other tool for this message.",
    "Speak this exact OpenClaw answer to the Discord voice channel, without adding, removing, or rephrasing words.",
    `Answer: ${JSON.stringify(text)}`,
  ].join("\n");
}

function isEscapedQuote(text: string, quoteIndex: number): boolean {
  let backslashes = 0;
  for (let index = quoteIndex - 1; index >= 0 && text[index] === "\\"; index -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function readJsonStringAfterLabel(text: string, label: string): string | undefined {
  const labelIndex = text.indexOf(label);
  if (labelIndex < 0) {
    return undefined;
  }
  const quoteIndex = text.indexOf('"', labelIndex + label.length);
  if (quoteIndex < 0) {
    return undefined;
  }
  for (let index = quoteIndex + 1; index < text.length; index += 1) {
    if (text[index] !== '"' || isEscapedQuote(text, index)) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(text.slice(quoteIndex, index + 1));
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function collectRealtimeConsultArgStrings(args: unknown): string[] {
  if (!args || typeof args !== "object") {
    return typeof args === "string" ? [args] : [];
  }
  const values: string[] = [];
  for (const key of ["question", "prompt", "query", "task", "context", "responseStyle"]) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string") {
      values.push(value);
    }
  }
  return values;
}

function extractDiscordExactSpeechConsultText(args: unknown): string | undefined {
  const message = collectRealtimeConsultArgStrings(args).join("\n");
  if (
    !message.includes("Speak this exact OpenClaw answer") &&
    !message.includes("Speak the provided exact answer verbatim")
  ) {
    return undefined;
  }
  return (
    readJsonStringAfterLabel(message, "Answer:") ??
    readJsonStringAfterLabel(message, "Provided answer text:")
  );
}

function normalizeControlSpeechText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function mergeRealtimePartialTranscript(previous: string, next: string): string {
  const trimmed = next.trim();
  if (!trimmed) {
    return previous;
  }
  const merged = trimmed.startsWith(previous) ? trimmed : `${previous}${next}`;
  return merged.slice(-DISCORD_REALTIME_PARTIAL_TRANSCRIPT_MAX_CHARS);
}

function resolveDiscordRealtimeWakeNames(params: {
  config: DiscordRealtimeVoiceConfig;
  cfg: OpenClawConfig;
  agentId: string;
}): string[] {
  const rawConfigured = params.config?.wakeNames;
  if (rawConfigured) {
    const configured = rawConfigured
      .map((name) => normalizeSupportedRealtimeVoiceActivationName(name))
      .filter((name): name is string => Boolean(name));
    return sortRealtimeVoiceActivationNames(uniqueStrings(configured));
  }
  const agent = params.cfg.agents?.list?.find((candidate) => candidate.id === params.agentId);
  const configuredAgentNames = [agent?.name, agent?.identity?.name]
    .map((name) => normalizeSupportedRealtimeVoiceActivationName(name))
    .filter((name): name is string => Boolean(name));
  const productWakeNames = [normalizeSupportedRealtimeVoiceActivationName("OpenClaw")].filter(
    (name): name is string => Boolean(name),
  );
  const defaults =
    configuredAgentNames.length > 0
      ? [...configuredAgentNames, ...productWakeNames]
      : [normalizeSupportedRealtimeVoiceActivationName(params.agentId), ...productWakeNames].filter(
          (name): name is string => Boolean(name),
        );
  return sortRealtimeVoiceActivationNames(uniqueStrings(defaults));
}

function matchesPendingAgentProxyQuestion(
  consultMessage: string | undefined,
  question: string | undefined,
): boolean {
  return matchRealtimeVoiceConsultQuestions(consultMessage, question);
}

export class DiscordRealtimeVoiceSession implements VoiceRealtimeSession {
  private bridge: RealtimeVoiceBridgeSession | null = null;
  private outputStream: PassThrough | null = null;
  private readonly talkback: RealtimeVoiceAgentTalkbackQueue;
  private stopped = false;
  private consultToolPolicy: RealtimeVoiceAgentConsultToolPolicy = "safe-read-only";
  private consultToolsAllow: string[] | undefined;
  private consultPolicy: "auto" | "always" = "auto";
  private requireWakeName = false;
  private wakeNames: string[] = [];
  private readonly forcedConsults: RealtimeVoiceForcedConsultCoordinator<AgentProxyConsultState> =
    createRealtimeVoiceForcedConsultCoordinator<AgentProxyConsultState>({
      limit: DISCORD_REALTIME_RECENT_AGENT_PROXY_CONSULT_LIMIT,
      nativeDedupeMs: DISCORD_REALTIME_RECENT_AGENT_PROXY_CONSULT_TTL_MS,
      questionsMatch: matchesPendingAgentProxyQuestion,
    });
  private readonly speakerTurns: RealtimeVoiceTurnContextTracker<
    DiscordRealtimeSpeakerContext,
    PendingSpeakerTurnStats
  > = createRealtimeVoiceTurnContextTracker<DiscordRealtimeSpeakerContext, PendingSpeakerTurnStats>(
    {
      limit: DISCORD_REALTIME_PENDING_SPEAKER_CONTEXT_LIMIT,
      ignoredContextTtlMs: DISCORD_REALTIME_IGNORED_WAKE_NAME_CONTEXT_TTL_MS,
      deferUntilAudio: true,
    },
  );
  private readonly outputActivity: RealtimeVoiceOutputActivityTracker =
    createRealtimeVoiceOutputActivityTracker();
  private outputPlaybackWatchdog: ReturnType<typeof setTimeout> | undefined;
  private outputPacedBuffer: Buffer = Buffer.alloc(0);
  private realtimeProviderId: string | undefined;
  private queuedExactSpeechMessages: string[] = [];
  private exactSpeechResponseActive = false;
  private exactSpeechAudioStarted = false;
  private partialUserTranscript = "";
  private wakeNameAckedForTurn = false;
  private wakeNameAckIndex = 0;
  private pendingWakeNameFollowup:
    | {
        context: DiscordRealtimeSpeakerContext;
        startedAt: number;
        expiresAt: number;
      }
    | undefined;
  private lastControlSpeech:
    | { normalizedText: string; sentAt: number; assistantTranscriptCount: number }
    | undefined;
  private lastRealtimeError:
    | { message: string; suppressed: number; lastLoggedAt: number }
    | undefined;
  private readonly playerIdleHandler = () => {
    this.resetOutputStream("player-idle");
    this.completeExactSpeechResponse("player-idle");
  };

  constructor(
    private readonly params: {
      cfg: OpenClawConfig;
      discordConfig: DiscordAccountConfig;
      entry: VoiceSessionEntry;
      mode: Exclude<DiscordVoiceMode, "stt-tts">;
      bootstrapContextInstructions?: string;
      runAgentTurn: (params: VoiceRealtimeAgentTurnParams) => Promise<string>;
    },
  ) {
    this.talkback = createRealtimeVoiceAgentTalkbackQueue({
      debounceMs: this.realtimeConfig?.debounceMs ?? DISCORD_REALTIME_TALKBACK_DEBOUNCE_MS,
      isStopped: () => this.stopped,
      logger,
      logPrefix: "[discord] realtime agent",
      responseStyle: "Brief, natural spoken answer for a Discord voice channel.",
      fallbackText: DISCORD_REALTIME_FALLBACK_TEXT,
      consult: async ({ question, responseStyle, metadata }) => {
        const context = isDiscordRealtimeSpeakerContext(metadata) ? metadata : undefined;
        return {
          text: await this.runAgentTurn({
            context,
            message: formatVoiceIngressPrompt(
              [question, responseStyle ? `Spoken style: ${responseStyle}` : undefined]
                .filter(Boolean)
                .join("\n\n"),
              context?.speakerLabel ?? "Discord voice speaker",
            ),
          }),
        };
      },
      deliver: (text) => this.enqueueExactSpeechMessage(text),
    });
  }

  async connect(): Promise<void> {
    const resolved = resolveConfiguredRealtimeVoiceProvider({
      configuredProviderId: this.realtimeConfig?.provider,
      providerConfigs: buildProviderConfigs(this.realtimeConfig),
      providerConfigOverrides: buildProviderConfigOverrides(this.realtimeConfig),
      cfg: this.params.cfg,
      defaultModel: this.realtimeConfig?.model,
      noRegisteredProviderMessage: "No configured realtime voice provider registered",
    });
    this.realtimeProviderId = resolved.provider.id;
    const isAgentProxy = isDiscordAgentProxyVoiceMode(this.params.mode);
    const defaultToolPolicy: RealtimeVoiceAgentConsultToolPolicy = isAgentProxy
      ? "owner"
      : "safe-read-only";
    const toolPolicy = resolveRealtimeVoiceAgentConsultToolPolicy(
      this.realtimeConfig?.toolPolicy,
      defaultToolPolicy,
    );
    this.consultToolPolicy = toolPolicy;
    this.consultToolsAllow = resolveRealtimeVoiceAgentConsultToolsAllow(toolPolicy);
    const consultPolicy = this.realtimeConfig?.consultPolicy ?? (isAgentProxy ? "always" : "auto");
    this.consultPolicy = consultPolicy;
    const supportsWakeNameGate = resolved.provider.id === "openai";
    this.requireWakeName =
      this.realtimeConfig?.requireWakeName === true && isAgentProxy && supportsWakeNameGate;
    this.wakeNames = this.requireWakeName
      ? resolveDiscordRealtimeWakeNames({
          config: this.realtimeConfig,
          cfg: this.params.cfg,
          agentId: this.params.entry.route.agentId,
        })
      : [];
    const usesRealtimeAgentHandoff = this.params.mode === "bidi" || toolPolicy !== "none";
    const autoRespondToAudio =
      !this.requireWakeName && (!isAgentProxy || consultPolicy !== "always");
    const interruptResponseOnInputAudio =
      !this.requireWakeName &&
      resolveDiscordRealtimeInterruptResponseOnInputAudio({
        realtimeConfig: this.realtimeConfig,
        providerId: resolved.provider.id,
      });
    const instructions = buildDiscordRealtimeInstructions({
      mode: this.params.mode,
      instructions: this.realtimeConfig?.instructions,
      bootstrapContextInstructions: this.params.bootstrapContextInstructions,
      toolPolicy,
      consultPolicy,
    });
    this.bridge = createRealtimeVoiceBridgeSession({
      provider: resolved.provider,
      providerConfig: resolved.providerConfig,
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      instructions,
      autoRespondToAudio,
      interruptResponseOnInputAudio,
      markStrategy: "ack-immediately",
      tools: usesRealtimeAgentHandoff
        ? resolveDiscordRealtimeVoiceAgentConsultTools(toolPolicy)
        : [],
      audioSink: {
        isOpen: () => !this.stopped,
        sendAudio: (audio) => this.sendOutputAudio(audio),
        clearAudio: () => this.clearOutputAudio("provider-clear-audio"),
      },
      onTranscript: (role, text, isFinal) => {
        if (isFinal && text.trim()) {
          logger.info(
            `discord voice: realtime ${role} transcript (${text.length} chars): ${formatRealtimeLogPreview(text)}`,
          );
        }
        if (isFinal && role === "assistant") {
          this.suppressDuplicateControlSpeech(text);
        }
        if (role !== "user") {
          return;
        }
        if (!isFinal) {
          this.handlePartialUserTranscript(text);
          return;
        }
        void this.handleFinalUserTranscript(text, { usesRealtimeAgentHandoff });
      },
      onToolCall: (event, session) => this.handleToolCall(event, session),
      onEvent: (event) => {
        const detail = event.detail ? ` ${event.detail}` : "";
        if (event.direction === "server" && event.type === "input_audio_buffer.speech_started") {
          this.resetPartialWakeNameTracking();
        }
        if (shouldLogRealtimeVerboseEvent(event)) {
          logVoiceVerbose(`realtime ${event.direction}:${event.type}${detail}`);
        }
        const responseEnded =
          event.direction === "server" &&
          (event.type === "response.done" || event.type === "response.cancelled");
        if (responseEnded) {
          if (this.exactSpeechResponseActive && !this.exactSpeechAudioStarted) {
            this.completeExactSpeechResponse(event.type);
          }
          this.finishOutputAudioStream(event.type, {
            playBuffered: !isRealtimeResponseCancelled(event),
          });
        }
        const interruptionLog = formatRealtimeInterruptionLog(event);
        if (interruptionLog) {
          logger.info(interruptionLog);
        }
        const lifecycleLog = formatRealtimeLifecycleLog(event);
        if (lifecycleLog) {
          logger.info(lifecycleLog);
        }
      },
      onError: (error) => this.logRealtimeError(formatErrorMessage(error)),
      onClose: (reason) => {
        this.flushSuppressedRealtimeErrors();
        logVoiceVerbose(`realtime closed: ${reason}`);
      },
    });
    const resolvedModel =
      readProviderConfigString(resolved.providerConfig, "model") ?? resolved.provider.defaultModel;
    const resolvedVoice = readProviderConfigString(resolved.providerConfig, "voice");
    logger.info(
      `discord voice: realtime bridge starting mode=${this.params.mode} provider=${resolved.provider.id} model=${resolvedModel ?? "default"} voice=${resolvedVoice ?? "default"} consultPolicy=${consultPolicy} toolPolicy=${toolPolicy} autoRespond=${autoRespondToAudio} requireWakeName=${this.requireWakeName} wakeNames=${this.wakeNames.join(",") || "none"} interruptResponse=${interruptResponseOnInputAudio} bargeIn=${resolveDiscordRealtimeBargeIn(
        {
          realtimeConfig: this.realtimeConfig,
          providerId: resolved.provider.id,
        },
      )} minBargeInAudioEndMs=${resolveDiscordRealtimeMinBargeInAudioEndMs(this.realtimeConfig)}`,
    );
    const voiceSdk = loadDiscordVoiceSdk();
    this.params.entry.player.on(voiceSdk.AudioPlayerStatus.Idle, this.playerIdleHandler);
    await this.bridge.connect();
    logger.info(
      `discord voice: realtime bridge ready mode=${this.params.mode} provider=${resolved.provider.id} model=${resolvedModel ?? "default"} voice=${resolvedVoice ?? "default"}`,
    );
  }

  close(): void {
    this.stopped = true;
    this.flushSuppressedRealtimeErrors();
    this.talkback.close();
    this.forcedConsults.clear();
    this.speakerTurns.clear();
    this.queuedExactSpeechMessages = [];
    this.exactSpeechResponseActive = false;
    this.exactSpeechAudioStarted = false;
    this.resetPartialWakeNameTracking();
    this.pendingWakeNameFollowup = undefined;
    this.clearOutputAudio("session-close");
    this.bridge?.close();
    this.bridge = null;
    this.realtimeProviderId = undefined;
    const voiceSdk = loadDiscordVoiceSdk();
    this.params.entry.player.off(voiceSdk.AudioPlayerStatus.Idle, this.playerIdleHandler);
  }

  private logRealtimeError(message: string): void {
    const now = Date.now();
    if (
      this.lastRealtimeError?.message === message &&
      now - this.lastRealtimeError.lastLoggedAt < DISCORD_REALTIME_DUPLICATE_ERROR_SUPPRESS_MS
    ) {
      this.lastRealtimeError.suppressed += 1;
      return;
    }
    this.flushSuppressedRealtimeErrors();
    this.lastRealtimeError = { message, suppressed: 0, lastLoggedAt: now };
    logger.warn(`discord voice: realtime error: ${message}`);
  }

  private flushSuppressedRealtimeErrors(): void {
    if (!this.lastRealtimeError || this.lastRealtimeError.suppressed === 0) {
      return;
    }
    logger.warn(
      `discord voice: suppressed ${this.lastRealtimeError.suppressed} duplicate realtime errors: ${this.lastRealtimeError.message}`,
    );
    this.lastRealtimeError.suppressed = 0;
  }

  beginSpeakerTurn(context: VoiceRealtimeSpeakerContext, userId: string): VoiceRealtimeSpeakerTurn {
    this.resetPartialWakeNameTracking();
    const turn = this.speakerTurns.open(
      { ...context, userId },
      {
        inputDiscordBytes: 0,
        inputRealtimeBytes: 0,
        inputChunks: 0,
        interruptedPlayback: false,
      },
    );
    return {
      sendInputAudio: (discordPcm48kStereo) =>
        this.sendInputAudioForTurn(turn, discordPcm48kStereo),
      close: () => {
        this.sendRealtimeTrailingSilenceForTurn(turn);
        this.logSpeakerTurnClosed(turn);
        this.speakerTurns.close(turn);
      },
    };
  }

  private sendInputAudioForTurn(turn: PendingSpeakerTurn, discordPcm48kStereo: Buffer): void {
    if (!this.bridge || this.stopped) {
      return;
    }
    const realtimePcm = convertDiscordPcm48kStereoToRealtimePcm24kMono(discordPcm48kStereo);
    if (realtimePcm.length > 0) {
      this.registerSpeakerTurnAudioStarted(turn);
      turn.inputDiscordBytes += discordPcm48kStereo.length;
      turn.inputRealtimeBytes += realtimePcm.length;
      turn.inputChunks += 1;
      if (turn.inputChunks === 1) {
        logger.info(
          `discord voice: realtime input audio started guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${turn.context.userId} speaker=${turn.context.speakerLabel} discordBytes=${discordPcm48kStereo.length} realtimeBytes=${realtimePcm.length} outputAudioMs=${this.outputAudioMs()} outputActive=${this.isOutputAudioActive()}`,
        );
      }
      const outputActive = this.hasInterruptibleOutputAudio();
      if (!turn.interruptedPlayback && this.isBargeInEnabled() && outputActive) {
        turn.interruptedPlayback = true;
        logVoiceVerbose(
          `realtime barge-in from active speaker audio: guild ${this.params.entry.guildId} channel ${this.params.entry.channelId} user ${turn.context.userId}`,
        );
        logger.info(
          `discord voice: realtime barge-in detected source=active-speaker-audio guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${turn.context.userId} speaker=${turn.context.speakerLabel} outputAudioMs=${this.outputAudioMs()} outputActive=${this.isOutputAudioActive()} discordBytes=${discordPcm48kStereo.length} realtimeBytes=${realtimePcm.length}`,
        );
        this.handleBargeIn("active-speaker-audio");
      }
      this.bridge.sendAudio(realtimePcm);
    }
  }

  private registerSpeakerTurnAudioStarted(turn: PendingSpeakerTurn): void {
    if (turn.hasAudio) {
      return;
    }
    this.speakerTurns.markAudio(turn);
    logger.info(
      `discord voice: realtime speaker turn opened guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${turn.context.userId} speaker=${turn.context.speakerLabel} owner=${turn.context.senderIsOwner} pendingTurns=${this.speakerTurns.size()}`,
    );
  }

  handleBargeIn(reason = "barge-in"): void {
    if (!this.isBargeInEnabled()) {
      logger.info(
        `discord voice: realtime barge-in ignored reason=${reason} bargeIn=false guild=${this.params.entry.guildId} channel=${this.params.entry.channelId}`,
      );
      return;
    }
    const outputActive = this.hasInterruptibleOutputAudio();
    if (!outputActive) {
      logger.info(
        `discord voice: realtime barge-in ignored reason=${reason} outputActive=false guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} playbackChunks=${this.outputAudioChunks()}`,
      );
      return;
    }
    logger.info(
      `discord voice: realtime barge-in requested reason=${reason} guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} outputAudioMs=${this.outputAudioMs()} outputActive=${this.isOutputAudioActive()} playbackChunks=${this.outputAudioChunks()}`,
    );
    this.bridge?.handleBargeIn({ audioPlaybackActive: true });
  }

  isBargeInEnabled(): boolean {
    if (this.requireWakeName) {
      return false;
    }
    const providerId = this.realtimeProviderId ?? this.realtimeConfig?.provider ?? "openai";
    return resolveDiscordRealtimeBargeIn({
      realtimeConfig: this.realtimeConfig,
      providerId,
    });
  }

  private hasInterruptibleOutputAudio(): boolean {
    this.syncOutputAudioTimestamp();
    return this.outputActivity.isInterruptible(this.isOutputStreamActive());
  }

  private get realtimeConfig(): DiscordRealtimeVoiceConfig {
    return this.params.discordConfig.voice?.realtime;
  }

  private sendOutputAudio(realtimePcm24kMono: Buffer): void {
    const discordPcm = convertRealtimePcm24kMonoToDiscordPcm48kStereo(realtimePcm24kMono);
    if (discordPcm.length === 0) {
      return;
    }
    this.syncOutputAudioTimestamp();
    if (this.outputActivity.snapshot().streamEnding) {
      logVoiceVerbose(
        `realtime output audio ignored after stream ending: guild ${this.params.entry.guildId} channel ${this.params.entry.channelId}`,
      );
      return;
    }
    const stream = this.ensureOutputStream();
    if (this.exactSpeechResponseActive) {
      this.exactSpeechAudioStarted = true;
    }
    this.outputActivity.markAudio({
      audioMs: pcm16MonoDurationMs(
        realtimePcm24kMono,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz,
      ),
      sourceAudioBytes: realtimePcm24kMono.length,
      sinkAudioBytes: discordPcm.length,
    });
    this.queueOutputAudio(stream, discordPcm);
  }

  private ensureOutputStream(): PassThrough {
    if (this.outputStream && !this.outputStream.destroyed && !this.outputStream.writableEnded) {
      return this.outputStream;
    }
    const stream = new PassThrough({ highWaterMark: DISCORD_RAW_PCM_FRAME_BYTES * 128 });
    this.outputStream = stream;
    this.outputPacedBuffer = Buffer.alloc(0);
    this.outputActivity.markStreamOpened();
    stream.once("close", () => {
      // After playback starts this PCM stream can close before Discord consumes
      // the Opus resource; idle/watchdog owns active playback cleanup.
      if (this.outputActivity.snapshot().playbackStarted) {
        return;
      }
      this.handleOutputStreamClosed(stream, "stream-close");
    });
    return stream;
  }

  private handleOutputStreamClosed(stream: PassThrough, reason: string): void {
    if (this.outputStream !== stream) {
      return;
    }
    this.logOutputAudioStopped(reason);
    this.outputStream = null;
    this.resetOutputAudioStats();
    this.completeExactSpeechResponse(reason, { drain: false });
  }

  private queueOutputAudio(stream: PassThrough, discordPcm: Buffer): void {
    if (this.outputActivity.snapshot().playbackStarted) {
      stream.write(discordPcm);
      return;
    }
    this.outputPacedBuffer =
      this.outputPacedBuffer.length > 0
        ? Buffer.concat([this.outputPacedBuffer, discordPcm])
        : discordPcm;
    if (
      this.outputPacedBuffer.length >=
      DISCORD_RAW_PCM_FRAME_BYTES * DISCORD_REALTIME_OUTPUT_PREROLL_FRAMES
    ) {
      this.startOutputPlayback(stream);
    }
  }

  private startOutputPlayback(stream: PassThrough): void {
    if (this.outputActivity.snapshot().playbackStarted || stream.destroyed) {
      return;
    }
    const voiceSdk = loadDiscordVoiceSdk();
    const opusStream = createDiscordOpusEncodeStream();
    opusStream.on("error", (err) => {
      logger.warn(
        `discord voice: realtime opus encode failed guild=${this.params.entry.guildId} channel=${this.params.entry.channelId}: ${formatErrorMessage(err)}`,
      );
      this.resetOutputStream("opus-encode-error");
    });
    opusStream.once("close", () => this.handleOutputStreamClosed(stream, "stream-close"));
    stream.pipe(opusStream);
    if (this.outputPacedBuffer.length > 0) {
      stream.write(this.outputPacedBuffer);
      this.outputPacedBuffer = Buffer.alloc(0);
    }
    const resource = voiceSdk.createAudioResource(opusStream, {
      inputType: voiceSdk.StreamType.Opus,
    });
    this.params.entry.player.play(resource);
    this.outputActivity.markPlaybackStarted();
    const realtimeConfig = this.realtimeConfig;
    logger.info(
      `discord voice: realtime audio playback started guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} mode=${this.params.mode} model=${realtimeConfig?.model ?? "provider-default"} voice=${realtimeConfig?.voice ?? "provider-default"}`,
    );
  }

  private clearOutputAudio(reason = "clear"): void {
    this.resetOutputStream(reason);
    this.params.entry.player.stop(true);
  }

  private resetOutputStream(reason = "reset"): void {
    const stream = this.outputStream;
    this.clearOutputPlaybackWatchdog();
    this.logOutputAudioStopped(reason);
    this.outputStream = null;
    this.outputPacedBuffer = Buffer.alloc(0);
    this.resetOutputAudioStats();
    stream?.end();
    stream?.destroy();
  }

  private finishOutputAudioStream(
    reason: string,
    { playBuffered = true }: { playBuffered?: boolean } = {},
  ): void {
    const stream = this.outputStream;
    if (!stream || stream.destroyed || this.outputActivity.snapshot().streamEnding) {
      return;
    }
    this.outputActivity.markStreamEnding();
    logger.info(
      `discord voice: realtime audio playback finishing reason=${reason} guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} audioMs=${this.outputAudioMs()} chunks=${this.outputAudioChunks()}`,
    );
    if (playBuffered) {
      this.startOutputPlayback(stream);
      this.scheduleOutputPlaybackWatchdog(reason, stream);
    } else {
      this.resetOutputStream(reason);
      this.params.entry.player.stop(true);
      this.completeExactSpeechResponse(reason);
      return;
    }
    stream.end();
  }

  private scheduleOutputPlaybackWatchdog(reason: string, stream: PassThrough): void {
    this.clearOutputPlaybackWatchdog();
    const timeoutMs = this.outputActivity.playbackWatchdogDelayMs({
      marginMs: DISCORD_REALTIME_OUTPUT_PLAYBACK_WATCHDOG_MARGIN_MS,
    });
    if (timeoutMs === undefined) {
      return;
    }
    this.outputPlaybackWatchdog = setTimeout(() => {
      this.outputPlaybackWatchdog = undefined;
      if (this.outputStream && this.outputStream !== stream) {
        return;
      }
      if (!this.outputStream && !this.isOutputAudioActive()) {
        this.completeExactSpeechResponse("playback-watchdog");
        return;
      }
      logger.warn(
        `discord voice: realtime audio playback watchdog fired reason=${reason} guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} audioMs=${this.outputAudioMs()} elapsedMs=${this.outputActivity.elapsedPlaybackMs()}`,
      );
      this.clearOutputAudio("playback-watchdog");
      this.completeExactSpeechResponse("playback-watchdog");
    }, timeoutMs);
  }

  private clearOutputPlaybackWatchdog(): void {
    if (!this.outputPlaybackWatchdog) {
      return;
    }
    clearTimeout(this.outputPlaybackWatchdog);
    this.outputPlaybackWatchdog = undefined;
  }

  private enqueueExactSpeechMessage(text: string): void {
    if (this.stopped || !text.trim()) {
      return;
    }
    if (this.exactSpeechResponseActive || this.hasInterruptibleOutputAudio()) {
      this.queuedExactSpeechMessages.push(text);
      logger.info(
        `discord voice: realtime exact speech queued guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} queued=${this.queuedExactSpeechMessages.length} outputAudioMs=${this.outputAudioMs()} outputActive=${this.isOutputAudioActive()}`,
      );
      return;
    }
    this.sendExactSpeechMessage(text);
  }

  private sendExactSpeechMessage(text: string): void {
    if (this.stopped || !text.trim()) {
      return;
    }
    this.exactSpeechResponseActive = true;
    this.exactSpeechAudioStarted = false;
    this.bridge?.sendUserMessage(buildDiscordSpeakExactUserMessage(text));
  }

  private sendWakeNameAck(result: RealtimeVoiceActivationNameTranscriptResult): void {
    if (!result.allowed || this.stopped || this.exactSpeechResponseActive) {
      return;
    }
    if (this.hasInterruptibleOutputAudio()) {
      logger.info(
        `discord voice: realtime wake-name ack skipped outputActive=true voiceSession=${this.params.entry.voiceSessionKey} agent=${this.params.entry.route.agentId}`,
      );
      return;
    }
    const ack =
      DISCORD_REALTIME_WAKE_ACKS[this.wakeNameAckIndex % DISCORD_REALTIME_WAKE_ACKS.length];
    this.wakeNameAckIndex += 1;
    logger.info(
      `discord voice: realtime wake-name ack canonical=${result.activationName} heard=${result.heardName} match=${result.match} voiceSession=${this.params.entry.voiceSessionKey} agent=${this.params.entry.route.agentId}`,
    );
    this.sendExactSpeechMessage(ack ?? "Yeah.");
  }

  private speakControlResult(text: string): void {
    const trimmed = text.trim();
    if (this.stopped || !trimmed) {
      return;
    }
    this.queuedExactSpeechMessages = [];
    this.completeExactSpeechResponse("active-run-control", { drain: false });
    this.bridge?.handleBargeIn?.({ audioPlaybackActive: true, force: true });
    this.clearOutputAudio("active-run-control");
    this.lastControlSpeech = {
      normalizedText: normalizeControlSpeechText(trimmed),
      sentAt: Date.now(),
      assistantTranscriptCount: 0,
    };
    this.sendExactSpeechMessage(trimmed);
  }

  private suppressDuplicateControlSpeech(text: string): void {
    const recent = this.lastControlSpeech;
    if (!recent) {
      return;
    }
    if (Date.now() - recent.sentAt > DISCORD_REALTIME_CONTROL_SPEECH_DEDUPE_MS) {
      this.lastControlSpeech = undefined;
      return;
    }
    if (normalizeControlSpeechText(text) !== recent.normalizedText) {
      return;
    }
    recent.assistantTranscriptCount += 1;
    if (recent.assistantTranscriptCount <= 1) {
      return;
    }
    logger.info(
      `discord voice: realtime duplicate active-run control speech suppressed guild=${this.params.entry.guildId} channel=${this.params.entry.channelId}`,
    );
    this.bridge?.handleBargeIn?.({ audioPlaybackActive: true, force: true });
    this.clearOutputAudio("duplicate-active-run-control");
  }

  private completeExactSpeechResponse(reason: string, options?: { drain?: boolean }): void {
    if (!this.exactSpeechResponseActive && this.queuedExactSpeechMessages.length === 0) {
      return;
    }
    this.exactSpeechResponseActive = false;
    this.exactSpeechAudioStarted = false;
    if (options?.drain === false) {
      return;
    }
    this.drainQueuedExactSpeechMessages(reason);
  }

  private drainQueuedExactSpeechMessages(reason: string): void {
    if (
      this.stopped ||
      this.exactSpeechResponseActive ||
      this.queuedExactSpeechMessages.length === 0 ||
      this.hasInterruptibleOutputAudio()
    ) {
      return;
    }
    const next = this.queuedExactSpeechMessages.shift();
    if (!next) {
      return;
    }
    logger.info(
      `discord voice: realtime exact speech dequeued reason=${reason} guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} queued=${this.queuedExactSpeechMessages.length}`,
    );
    this.sendExactSpeechMessage(next);
  }

  private logOutputAudioStopped(reason: string): void {
    const activity = this.outputActivity.snapshot();
    const audioMs = Math.floor(activity.audioMs);
    const chunks = activity.chunks;
    const discordBytes = activity.sinkAudioBytes;
    const realtimeBytes = activity.sourceAudioBytes;
    const elapsedMs = this.outputActivity.elapsedPlaybackMs();
    if (this.outputStream || chunks > 0 || audioMs > 0) {
      logger.info(
        `discord voice: realtime audio playback stopped reason=${reason} guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} audioMs=${audioMs} elapsedMs=${elapsedMs} chunks=${chunks} discordBytes=${discordBytes} realtimeBytes=${realtimeBytes}`,
      );
    }
  }

  private resetOutputAudioStats(): void {
    this.outputPacedBuffer = Buffer.alloc(0);
    this.outputActivity.reset();
  }

  private syncOutputAudioTimestamp(): void {
    this.bridge?.setMediaTimestamp(this.outputAudioMs());
  }

  private outputAudioMs(): number {
    return Math.floor(this.outputActivity.snapshot().audioMs);
  }

  private outputAudioChunks(): number {
    return this.outputActivity.snapshot().chunks;
  }

  private isOutputStreamActive(): boolean {
    return Boolean(this.outputStream && !this.outputStream.destroyed);
  }

  private isOutputAudioActive(): boolean {
    return this.outputActivity.isActive(this.isOutputStreamActive());
  }

  private logSpeakerTurnClosed(turn: PendingSpeakerTurn): void {
    if (turn.closed || !turn.hasAudio) {
      return;
    }
    const elapsedMs = Date.now() - turn.startedAt;
    const sinceLastAudioMs = turn.lastAudioAt ? Date.now() - turn.lastAudioAt : undefined;
    logger.info(
      `discord voice: realtime speaker turn closed guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${turn.context.userId} speaker=${turn.context.speakerLabel} owner=${turn.context.senderIsOwner} hasAudio=${turn.hasAudio} chunks=${turn.inputChunks} discordBytes=${turn.inputDiscordBytes} realtimeBytes=${turn.inputRealtimeBytes} elapsedMs=${elapsedMs}${sinceLastAudioMs === undefined ? "" : ` sinceLastAudioMs=${sinceLastAudioMs}`} interruptedPlayback=${turn.interruptedPlayback}`,
    );
  }

  private sendRealtimeTrailingSilenceForTurn(turn: PendingSpeakerTurn): void {
    if (!this.bridge || this.stopped || turn.closed || !turn.hasAudio) {
      return;
    }
    const providerId = this.realtimeProviderId ?? this.realtimeConfig?.provider ?? "openai";
    const providerConfig = this.realtimeConfig?.providers?.[providerId];
    const rawSilenceDurationMs = providerConfig?.silenceDurationMs;
    const configuredSilenceDurationMs =
      typeof rawSilenceDurationMs === "number" && Number.isFinite(rawSilenceDurationMs)
        ? rawSilenceDurationMs
        : 0;
    const silenceMs = Math.min(
      DISCORD_REALTIME_TRAILING_SILENCE_MAX_MS,
      Math.max(DISCORD_REALTIME_TRAILING_SILENCE_MIN_MS, configuredSilenceDurationMs),
    );
    const silenceBytes =
      Math.ceil((REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz * silenceMs) / 1_000) *
      REALTIME_PCM16_BYTES_PER_SAMPLE;
    const silence = Buffer.alloc(silenceBytes);
    this.bridge.sendAudio(silence);
    logger.info(
      `discord voice: realtime trailing silence sent guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${turn.context.userId} speaker=${turn.context.speakerLabel} silenceMs=${silenceMs} realtimeBytes=${silence.length}`,
    );
  }

  private handleToolCall(
    event: RealtimeVoiceToolCallEvent,
    session: RealtimeVoiceBridgeSession,
  ): void {
    const callId = event.callId || event.itemId || "unknown";
    if (event.name === REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME) {
      void this.handleAgentControlToolCall(event, session, callId);
      return;
    }
    if (event.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      session.submitToolResult(callId, { error: `Tool "${event.name}" not available` });
      return;
    }
    if (this.consultToolPolicy === "none") {
      session.submitToolResult(callId, { error: `Tool "${event.name}" not available` });
      return;
    }
    const exactSpeechText = extractDiscordExactSpeechConsultText(event.args);
    if (exactSpeechText !== undefined) {
      logger.info(
        `discord voice: realtime exact speech consult bypassed call=${callId || "unknown"} answerChars=${exactSpeechText.length}`,
      );
      session.submitToolResult(callId, { text: exactSpeechText });
      return;
    }
    const consultMessage = buildRealtimeVoiceAgentConsultChatMessage(event.args);
    logger.info(
      `discord voice: realtime consult requested call=${callId || "unknown"} voiceSession=${this.params.entry.voiceSessionKey} supervisorSession=${this.params.entry.route.sessionKey} agent=${this.params.entry.route.agentId} question=${formatRealtimeLogPreview(consultMessage)}`,
    );
    const nativeConsult = this.forcedConsults.recordNativeConsult(event.args, callId);
    const pendingConsult = nativeConsult.kind === "pending" ? nativeConsult.handle : undefined;
    if (pendingConsult) {
      this.forcedConsults.rememberQuestion(pendingConsult, consultMessage);
    }
    let context = pendingConsult?.context?.speaker;
    let recent = pendingConsult;
    if (!context) {
      const recentConsult =
        nativeConsult.kind === "in_flight" || nativeConsult.kind === "already_delivered"
          ? nativeConsult.handle
          : this.findRecentAgentProxyConsultContext(consultMessage);
      if (recentConsult) {
        const recentSpeaker = recentConsult.context?.speaker;
        if (this.hasPendingSpeakerAudioContext()) {
          logger.info(
            `discord voice: realtime consult matched recent agent result but newer speaker audio is pending call=${callId} speaker=${recentSpeaker?.speakerLabel ?? "unknown"} owner=${recentSpeaker?.senderIsOwner ?? false}`,
          );
          session.submitToolResult(callId, {
            error: "Discord speaker context changed before this realtime consult completed",
          });
          return;
        }
        if (this.submitRecentAgentProxyConsultResult(callId, recentConsult, session)) {
          return;
        }
      }
    }
    if (!context) {
      context = this.consumePendingSpeakerContext();
      if (context) {
        recent = this.rememberRecentAgentProxyConsultContext(consultMessage, context, {
          ...(callId === "unknown" ? {} : { id: `native-consult:${callId}` }),
          started: true,
        });
      }
    }
    if (!context) {
      logger.warn(
        `discord voice: realtime consult has no speaker context call=${callId || "unknown"}`,
      );
      session.submitToolResult(callId, { error: "No Discord speaker context available" });
      return;
    }
    const promise = this.runAgentTurn({
      context,
      message: consultMessage,
    });
    if (recent) {
      this.setRecentAgentProxyConsultPromise(recent, promise);
    }
    void promise
      .then((text) => {
        logger.info(
          `discord voice: realtime consult answer (${text.length} chars) voiceSession=${this.params.entry.voiceSessionKey} supervisorSession=${this.params.entry.route.sessionKey} agent=${this.params.entry.route.agentId} speaker=${context.speakerLabel} owner=${context.senderIsOwner}: ${formatRealtimeLogPreview(text)}`,
        );
        session.submitToolResult(callId, { text });
      })
      .catch((error: unknown) => {
        logger.warn(
          `discord voice: realtime consult failed call=${callId || "unknown"}: ${formatErrorMessage(error)}`,
        );
        session.submitToolResult(callId, { error: formatErrorMessage(error) });
      });
  }

  private async handleAgentControlToolCall(
    event: RealtimeVoiceToolCallEvent,
    session: RealtimeVoiceBridgeSession,
    callId: string,
  ): Promise<void> {
    try {
      const parsed = parseRealtimeVoiceAgentControlToolArgs(event.args);
      const result = await controlRealtimeVoiceAgentRun({
        sessionKey: this.params.entry.route.sessionKey,
        text: parsed.text,
        mode: parsed.mode,
      });
      this.logAgentControlResult(result);
      session.submitToolResult(callId, result);
    } catch (error) {
      session.submitToolResult(callId, { error: formatErrorMessage(error) });
    }
  }

  private async runAgentTurn(params: {
    context?: DiscordRealtimeSpeakerContext;
    message: string;
  }): Promise<string> {
    const context = params.context;
    if (!context) {
      return "";
    }
    return this.params.runAgentTurn({
      context,
      message: params.message,
      toolsAllow: this.consultToolsAllow,
      userId: context.userId,
    });
  }

  private async handleFinalUserTranscript(
    text: string,
    params: { usesRealtimeAgentHandoff: boolean },
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    this.partialUserTranscript = "";
    const transcriptsTurn = this.peekPendingSpeakerTurn();
    let transcriptAttribution = this.transcriptAttributionFromTurn(transcriptsTurn);
    const wakeNameResult = this.resolveWakeNameTranscript(trimmed);
    let forcedSpeakerContext: DiscordRealtimeSpeakerContext | undefined;
    if (!wakeNameResult.allowed) {
      const pendingWakeNameFollowup = this.consumePendingWakeNameFollowup();
      transcriptAttribution ??= pendingWakeNameFollowup;
      if (!pendingWakeNameFollowup) {
        this.recordTranscriptUtterance(trimmed, transcriptAttribution);
        this.rememberIgnoredWakeNameSpeakerContext(this.consumePendingSpeakerContext());
        logger.info(
          `discord voice: realtime wake-name gate ignored transcript chars=${trimmed.length} voiceSession=${this.params.entry.voiceSessionKey} agent=${this.params.entry.route.agentId} wakeNames=${this.wakeNames.join(",") || "none"}`,
        );
        return;
      }
      forcedSpeakerContext = pendingWakeNameFollowup.context;
      logger.info(
        `discord voice: realtime wake-name follow-up accepted chars=${trimmed.length} speaker=${forcedSpeakerContext.speakerLabel} voiceSession=${this.params.entry.voiceSessionKey} agent=${this.params.entry.route.agentId}`,
      );
    }
    this.recordTranscriptUtterance(trimmed, transcriptAttribution);
    const acceptedText = wakeNameResult.allowed ? wakeNameResult.text || trimmed : trimmed;
    if (wakeNameResult.allowed && !wakeNameResult.text.trim()) {
      this.armWakeNameFollowup();
      return;
    }
    if (wakeNameResult.allowed) {
      this.pendingWakeNameFollowup = undefined;
    }
    const usesAgentProxy = isDiscordAgentProxyVoiceMode(this.params.mode);
    const pendingForcedConsult =
      usesAgentProxy && params.usesRealtimeAgentHandoff
        ? this.prepareForcedAgentProxyConsult(acceptedText, forcedSpeakerContext)
        : undefined;
    const control = await maybeControlDiscordVoiceAgentRun({
      entry: this.params.entry,
      text: acceptedText,
    }).catch((error: unknown) => {
      logger.warn(
        `discord voice: realtime active-run control failed; falling back to normal transcript handling: ${formatErrorMessage(error)}`,
      );
      return undefined;
    });
    if (control?.handled) {
      if (pendingForcedConsult) {
        this.forcedConsults.remove(pendingForcedConsult);
      }
      this.logAgentControlResult(control.result);
      if (control.speakText) {
        this.speakControlResult(control.speakText);
      }
      return;
    }

    if (!usesAgentProxy) {
      return;
    }
    if (params.usesRealtimeAgentHandoff) {
      if (pendingForcedConsult) {
        this.schedulePreparedForcedAgentProxyConsult(pendingForcedConsult);
      }
      return;
    }
    this.talkback.enqueue(
      acceptedText,
      forcedSpeakerContext ?? this.consumePendingSpeakerContext(),
    );
  }

  private handlePartialUserTranscript(text: string): void {
    if (!this.requireWakeName || this.wakeNameAckedForTurn) {
      return;
    }
    this.partialUserTranscript = mergeRealtimePartialTranscript(this.partialUserTranscript, text);
    const wakeNameResult = matchRealtimeVoiceActivationName(
      this.partialUserTranscript,
      this.wakeNames,
    );
    if (!wakeNameResult || wakeNameResult.edge !== "leading") {
      return;
    }
    this.wakeNameAckedForTurn = true;
    this.sendWakeNameAck(wakeNameResult);
  }

  private resetPartialWakeNameTracking(): void {
    this.partialUserTranscript = "";
    this.wakeNameAckedForTurn = false;
  }

  private resolveWakeNameTranscript(text: string): RealtimeVoiceActivationNameTranscriptResult {
    if (!this.requireWakeName) {
      return {
        allowed: true,
        text,
        activationName: "",
        heardName: "",
        match: "exact",
        edge: "leading",
      };
    }
    const wakeNameResult = matchRealtimeVoiceActivationName(text, this.wakeNames);
    if (wakeNameResult) {
      logger.info(
        `discord voice: realtime wake-name gate matched canonical=${wakeNameResult.activationName} heard=${wakeNameResult.heardName} match=${wakeNameResult.match} voiceSession=${this.params.entry.voiceSessionKey} agent=${this.params.entry.route.agentId}`,
      );
      return wakeNameResult;
    }
    return { allowed: false, text };
  }

  private transcriptAttributionFromTurn(
    turn: PendingSpeakerTurn | undefined,
  ): TranscriptUtteranceAttribution | undefined {
    return turn ? { context: turn.context, startedAt: turn.startedAt } : undefined;
  }

  private recordTranscriptUtterance(
    text: string,
    attribution: TranscriptUtteranceAttribution | undefined,
  ): void {
    const transcripts = this.params.entry.transcripts;
    if (!transcripts || !attribution) {
      return;
    }
    const context = attribution.context;
    const utterance = {
      sessionId: transcripts.sessionId,
      startedAt: new Date(attribution.startedAt).toISOString(),
      final: true,
      speaker: {
        id: context.userId,
        label: context.speakerLabel,
      },
      text,
      metadata: {
        channel: "discord",
        guildId: this.params.entry.guildId,
        channelId: this.params.entry.channelId,
        voiceSessionKey: this.params.entry.voiceSessionKey,
      },
    };
    void Promise.resolve()
      .then(() => transcripts.onUtterance(utterance))
      .catch((error: unknown) => {
        logger.warn(
          `discord voice: realtime transcripts utterance failed: ${formatErrorMessage(error)}`,
        );
      });
  }

  private logAgentControlResult(result: RealtimeVoiceAgentControlResult): void {
    logger.info(
      `discord voice: realtime active-run control handled mode=${result.mode} ok=${result.ok} active=${result.active} reason=${result.reason ?? "none"} voiceSession=${this.params.entry.voiceSessionKey} supervisorSession=${this.params.entry.route.sessionKey} agent=${this.params.entry.route.agentId}`,
    );
  }

  private prepareForcedAgentProxyConsult(
    transcript: string,
    speakerContext?: DiscordRealtimeSpeakerContext,
  ): AgentProxyConsultHandle | undefined {
    if (this.consultPolicy !== "always" && !this.requireWakeName) {
      return undefined;
    }
    const question = transcript.trim();
    if (!question) {
      return undefined;
    }
    const skipReason = classifySkippableRealtimeVoiceConsultTranscript(question);
    if (skipReason) {
      const context = this.consumePendingSpeakerContext();
      logger.info(
        `discord voice: realtime forced agent consult skipped reason=${skipReason} chars=${question.length} speaker=${context?.speakerLabel ?? "unknown"} transcript=${formatRealtimeLogPreview(question)}`,
      );
      return undefined;
    }
    let context = speakerContext ?? this.consumePendingSpeakerContext();
    if (!context) {
      context = this.consumeRecentIgnoredWakeNameSpeakerContext();
    }
    if (!context) {
      const recent = this.findRecentAgentProxyConsultContext(question);
      if (recent) {
        logVoiceVerbose(
          `realtime forced agent consult skipped (already delegated): guild ${this.params.entry.guildId} channel ${this.params.entry.channelId} speaker ${recent.context?.speaker.userId ?? "unknown"}`,
        );
        return undefined;
      }
      logger.warn("discord voice: realtime forced agent consult has no speaker context");
      return undefined;
    }
    return this.forcedConsults.prepare(question, {
      context: { speaker: context },
    });
  }

  private schedulePreparedForcedAgentProxyConsult(pending: AgentProxyConsultHandle): void {
    this.forcedConsults.schedule(
      pending,
      DISCORD_REALTIME_FORCED_CONSULT_FALLBACK_DELAY_MS,
      (handle) => void this.runForcedAgentProxyConsult(handle),
    );
  }

  private async runForcedAgentProxyConsult(pending: AgentProxyConsultHandle): Promise<void> {
    this.forcedConsults.markStarted(pending);
    const state = pending.context;
    if (!state) {
      this.forcedConsults.markCancelled(pending);
      return;
    }
    const context = state.speaker;
    const { question } = pending;
    if (this.stopped) {
      this.forcedConsults.markCancelled(pending);
      return;
    }
    const startedAt = Date.now();
    logger.info(
      `discord voice: realtime forced agent consult starting chars=${question.length} voiceSession=${this.params.entry.voiceSessionKey} supervisorSession=${this.params.entry.route.sessionKey} agent=${this.params.entry.route.agentId} speaker=${context.speakerLabel} owner=${context.senderIsOwner}`,
    );
    logger.debug(
      `discord voice: realtime forced agent consult reason=${DISCORD_REALTIME_FORCED_CONSULT_REASON} consultPolicy=${this.consultPolicy} requireWakeName=${this.requireWakeName} voiceSession=${this.params.entry.voiceSessionKey} supervisorSession=${this.params.entry.route.sessionKey} agent=${this.params.entry.route.agentId} speaker=${context.speakerLabel}`,
    );
    if (this.hasInterruptibleOutputAudio()) {
      logger.info(
        `discord voice: realtime forced agent consult preserving active playback guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} outputAudioMs=${this.outputAudioMs()} outputActive=${this.isOutputAudioActive()} playbackChunks=${this.outputAudioChunks()}`,
      );
    }
    state.handledByForcedPlayback = true;
    try {
      const promise = this.runAgentTurn({
        context,
        message: question,
      });
      this.setRecentAgentProxyConsultPromise(pending, promise);
      const text = await promise;
      logger.info(
        `discord voice: realtime forced agent consult answer (${text.length} chars) elapsedMs=${Date.now() - startedAt} voiceSession=${this.params.entry.voiceSessionKey} supervisorSession=${this.params.entry.route.sessionKey} agent=${this.params.entry.route.agentId}: ${formatRealtimeLogPreview(text)}`,
      );
      if (text.trim()) {
        this.enqueueExactSpeechMessage(text);
      }
    } catch (error) {
      logger.warn(
        `discord voice: realtime forced agent consult failed elapsedMs=${Date.now() - startedAt}: ${formatErrorMessage(error)}`,
      );
      this.enqueueExactSpeechMessage(DISCORD_REALTIME_FALLBACK_TEXT);
    }
  }

  private consumePendingSpeakerContext(): DiscordRealtimeSpeakerContext | undefined {
    return this.speakerTurns.consumeAudioContext();
  }

  private armWakeNameFollowup(): void {
    const turn = this.peekPendingSpeakerTurn();
    const context = this.consumePendingSpeakerContext();
    if (!context) {
      logger.warn(
        `discord voice: realtime wake-name follow-up has no speaker context voiceSession=${this.params.entry.voiceSessionKey} agent=${this.params.entry.route.agentId}`,
      );
      return;
    }
    const expiresAt = resolveExpiresAtMsFromDurationMs(DISCORD_REALTIME_WAKE_NAME_FOLLOWUP_TTL_MS);
    if (expiresAt === undefined) {
      return;
    }
    this.pendingWakeNameFollowup = {
      context,
      startedAt: turn?.startedAt ?? Date.now(),
      expiresAt,
    };
    logger.info(
      `discord voice: realtime wake-name follow-up armed speaker=${context.speakerLabel} voiceSession=${this.params.entry.voiceSessionKey} agent=${this.params.entry.route.agentId}`,
    );
  }

  private consumePendingWakeNameFollowup(): TranscriptUtteranceAttribution | undefined {
    const pending = this.pendingWakeNameFollowup;
    this.pendingWakeNameFollowup = undefined;
    const now = asDateTimestampMs(Date.now());
    const expiresAt = pending ? asDateTimestampMs(pending.expiresAt) : undefined;
    if (!pending || now === undefined || expiresAt === undefined || now > expiresAt) {
      return undefined;
    }
    const currentTurn = this.peekPendingSpeakerTurn();
    if (currentTurn && currentTurn.context.userId !== pending.context.userId) {
      return undefined;
    }
    if (currentTurn) {
      this.consumePendingSpeakerContext();
    }
    return {
      context: pending.context,
      startedAt: pending.startedAt,
    };
  }

  private rememberIgnoredWakeNameSpeakerContext(
    context: DiscordRealtimeSpeakerContext | undefined,
  ): void {
    this.speakerTurns.rememberIgnoredContext(context);
  }

  private consumeRecentIgnoredWakeNameSpeakerContext(): DiscordRealtimeSpeakerContext | undefined {
    return this.speakerTurns.consumeIgnoredContext();
  }

  private peekPendingSpeakerTurn(): PendingSpeakerTurn | undefined {
    return this.speakerTurns.peekAudioTurn();
  }

  private hasPendingSpeakerAudioContext(): boolean {
    return this.speakerTurns.hasAudioContext();
  }

  private rememberRecentAgentProxyConsultContext(
    question: string,
    context: DiscordRealtimeSpeakerContext,
    options: { id?: string; started?: boolean } = {},
  ): AgentProxyConsultHandle {
    const handle = this.forcedConsults.prepare(question, {
      context: { speaker: context },
      ...(options.id ? { id: options.id } : {}),
    });
    if (!handle) {
      throw new Error("Discord realtime consult context requires a non-empty question");
    }
    if (options.started) {
      this.forcedConsults.markStarted(handle);
    }
    return handle;
  }

  private setRecentAgentProxyConsultPromise(
    recent: AgentProxyConsultHandle,
    promise: Promise<string>,
  ): void {
    const state = recent.context;
    if (!state) {
      return;
    }
    this.forcedConsults.markStarted(recent);
    state.promise = promise;
    void promise
      .then((text) => {
        state.result = { status: "fulfilled", text };
        this.forcedConsults.markDelivered(recent);
      })
      .catch((error: unknown) => {
        state.result = { status: "rejected", error: formatErrorMessage(error) };
        this.forcedConsults.markDelivered(recent);
      });
  }

  private findRecentAgentProxyConsultContext(
    consultMessage: string,
  ): AgentProxyConsultHandle | undefined {
    return this.forcedConsults.findRecent(consultMessage);
  }

  private submitRecentAgentProxyConsultResult(
    callId: string,
    recent: AgentProxyConsultHandle,
    session: RealtimeVoiceBridgeSession,
  ): boolean {
    const state = recent.context;
    if (!state) {
      return false;
    }
    const submitAlreadyDelivered = () => {
      session.submitToolResult(
        callId,
        {
          status: "already_delivered",
          message: "OpenClaw already delivered this answer to Discord voice.",
        },
        { suppressResponse: true },
      );
    };
    const submitResult = (result: RecentAgentProxyConsultResult) => {
      if (state.handledByForcedPlayback) {
        submitAlreadyDelivered();
        return;
      }
      if (result.status === "fulfilled") {
        session.submitToolResult(callId, { text: result.text });
        return;
      }
      session.submitToolResult(callId, { error: result.error });
    };
    if (state.result) {
      logger.info(
        `discord voice: realtime consult reused recent agent result call=${callId || "unknown"} speaker=${state.speaker.speakerLabel} owner=${state.speaker.senderIsOwner}`,
      );
      submitResult(state.result);
      return true;
    }
    if (!state.promise) {
      return false;
    }
    logger.info(
      `discord voice: realtime consult joined in-flight agent result call=${callId || "unknown"} speaker=${state.speaker.speakerLabel} owner=${state.speaker.senderIsOwner}`,
    );
    if (state.handledByForcedPlayback) {
      void state.promise.then(submitAlreadyDelivered, submitAlreadyDelivered);
      return true;
    }
    void state.promise
      .then((text) => session.submitToolResult(callId, { text }))
      .catch((error: unknown) =>
        session.submitToolResult(callId, { error: formatErrorMessage(error) }),
      );
    return true;
  }
}

function isDiscordRealtimeSpeakerContext(value: unknown): value is DiscordRealtimeSpeakerContext {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    typeof (value as { senderIsOwner?: unknown }).senderIsOwner === "boolean" &&
    typeof (value as { speakerLabel?: unknown }).speakerLabel === "string"
  );
}

function pcm16MonoDurationMs(audio: Buffer, sampleRate: number): number {
  if (audio.length === 0 || sampleRate <= 0) {
    return 0;
  }
  const samples = audio.length / REALTIME_PCM16_BYTES_PER_SAMPLE;
  return (samples * 1000) / sampleRate;
}

function buildProviderConfigs(
  realtimeConfig: DiscordRealtimeVoiceConfig,
): Record<string, RealtimeVoiceProviderConfig | undefined> | undefined {
  const configs = realtimeConfig?.providers;
  return configs && Object.keys(configs).length > 0 ? { ...configs } : undefined;
}

function buildProviderConfigOverrides(
  realtimeConfig: DiscordRealtimeVoiceConfig,
): RealtimeVoiceProviderConfig | undefined {
  const overrides = {
    ...(realtimeConfig?.model ? { model: realtimeConfig.model } : {}),
    ...(realtimeConfig?.speakerVoice
      ? { voice: realtimeConfig.speakerVoice }
      : realtimeConfig?.speakerVoiceId
        ? { voice: realtimeConfig.speakerVoiceId }
        : realtimeConfig?.voice
          ? { voice: realtimeConfig.voice }
          : {}),
    ...(typeof realtimeConfig?.minBargeInAudioEndMs === "number"
      ? { minBargeInAudioEndMs: realtimeConfig.minBargeInAudioEndMs }
      : {}),
  };
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function resolveDiscordRealtimeMinBargeInAudioEndMs(
  realtimeConfig: DiscordRealtimeVoiceConfig,
): number {
  return typeof realtimeConfig?.minBargeInAudioEndMs === "number"
    ? realtimeConfig.minBargeInAudioEndMs
    : DISCORD_REALTIME_DEFAULT_MIN_BARGE_IN_AUDIO_END_MS;
}

function buildDiscordRealtimeInstructions(params: {
  mode: Exclude<DiscordVoiceMode, "stt-tts">;
  instructions?: string;
  bootstrapContextInstructions?: string;
  toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
  consultPolicy: "auto" | "always";
}): string {
  const base =
    params.instructions ??
    [
      "You are OpenClaw's Discord voice interface.",
      "Keep spoken replies concise, natural, and suitable for a live Discord voice channel.",
    ].join("\n");
  if (isDiscordAgentProxyVoiceMode(params.mode)) {
    return [
      base,
      params.bootstrapContextInstructions?.trim(),
      "Mode: OpenClaw agent proxy.",
      "You are the realtime voice surface for the same OpenClaw agent the user can message directly.",
      "Do not mention a backend, supervisor, helper, or separate system. Present the result as your own work.",
      "Delegate substantive requests, actions, tool work, current facts, memory, workspace context, and user-specific context with openclaw_agent_consult.",
      "Do not block, refuse, or downscope at the voice layer. Delegate to OpenClaw and treat its result as authoritative.",
      "Answer directly only for greetings, acknowledgements, brief latency tests, or filler while waiting.",
      'While waiting for OpenClaw data or tool results, use at most one short natural backchannel such as "yeah", "mm-hmm", "got it", or "one sec"; vary it and do not treat it as the final answer.',
      "When OpenClaw sends an internal exact answer to speak, do not call tools. Say only that answer.",
      buildRealtimeVoiceAgentConsultPolicyInstructions({
        toolPolicy: params.toolPolicy,
        consultPolicy: params.consultPolicy,
      }),
    ].join("\n\n");
  }
  return [
    base,
    params.bootstrapContextInstructions?.trim(),
    'While waiting for OpenClaw data or tool results, use at most one short natural backchannel such as "yeah", "mm-hmm", "got it", or "one sec"; vary it and do not treat it as the final answer.',
    buildRealtimeVoiceAgentConsultPolicyInstructions({
      toolPolicy: params.toolPolicy,
      consultPolicy: params.consultPolicy,
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
}
