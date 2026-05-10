import { PassThrough } from "node:stream";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  buildRealtimeVoiceAgentConsultChatMessage,
  buildRealtimeVoiceAgentConsultPolicyInstructions,
  buildRealtimeVoiceAgentConsultWorkingResponse,
  createRealtimeVoiceAgentTalkbackQueue,
  createRealtimeVoiceBridgeSession,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  resolveConfiguredRealtimeVoiceProvider,
  resolveRealtimeVoiceAgentConsultToolPolicy,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  type RealtimeVoiceBridgeEvent,
  type RealtimeVoiceAgentTalkbackQueue,
  type RealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceToolCallEvent,
} from "openclaw/plugin-sdk/realtime-voice";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import {
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
const DISCORD_REALTIME_TALKBACK_DEBOUNCE_MS = 350;
const DISCORD_REALTIME_FALLBACK_TEXT = "I hit an error while checking that. Please try again.";
const DISCORD_REALTIME_PENDING_SPEAKER_CONTEXT_LIMIT = 32;
const DISCORD_REALTIME_RECENT_AGENT_PROXY_CONSULT_LIMIT = 16;
const DISCORD_REALTIME_RECENT_AGENT_PROXY_CONSULT_TTL_MS = 15_000;
const DISCORD_REALTIME_LOG_PREVIEW_CHARS = 500;
const DISCORD_REALTIME_DEFAULT_MIN_BARGE_IN_AUDIO_END_MS = 250;
const DISCORD_REALTIME_FORCED_CONSULT_FALLBACK_DELAY_MS = 200;
const REALTIME_PCM16_BYTES_PER_SAMPLE = 2;
const DISCORD_REALTIME_FORCED_CONSULT_TRAILING_FRAGMENT_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "as",
  "at",
  "because",
  "but",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "then",
  "to",
  "with",
]);
const DISCORD_REALTIME_VERBOSE_OMITTED_EVENTS = new Set([
  "conversation.output_audio.delta",
  "input_audio_buffer.append",
  "response.audio.delta",
  "response.output_audio.delta",
]);

export type DiscordVoiceMode = "stt-tts" | "agent-proxy" | "bidi";

type DiscordRealtimeSpeakerContext = VoiceRealtimeSpeakerContext & { userId: string };

type DiscordRealtimeVoiceConfig = NonNullable<DiscordAccountConfig["voice"]>["realtime"];

type PendingSpeakerTurn = {
  context: DiscordRealtimeSpeakerContext;
  hasAudio: boolean;
  inputDiscordBytes: number;
  inputRealtimeBytes: number;
  inputChunks: number;
  interruptedPlayback: boolean;
  closed: boolean;
  startedAt: number;
  lastAudioAt?: number;
};

type PendingAgentProxyConsultContext = {
  context: DiscordRealtimeSpeakerContext;
  question: string;
  recent: RecentAgentProxyConsultContext;
  timer?: ReturnType<typeof setTimeout>;
};

type RecentAgentProxyConsultResult =
  | { status: "fulfilled"; text: string }
  | { status: "rejected"; error: string };

type RecentAgentProxyConsultContext = {
  context: DiscordRealtimeSpeakerContext;
  createdAt: number;
  handledByForcedPlayback?: boolean;
  promise?: Promise<string>;
  questions: string[];
  result?: RecentAgentProxyConsultResult;
};

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

function shouldLogRealtimeVerboseEvent(event: RealtimeVoiceBridgeEvent): boolean {
  return !DISCORD_REALTIME_VERBOSE_OMITTED_EVENTS.has(event.type);
}

function classifySkippableForcedAgentProxyTranscript(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) {
    return "empty";
  }
  if (/(\.\.\.|…)\s*$/.test(normalized)) {
    return "incomplete-transcript";
  }
  const lastWord = normalized.match(/[a-z']+$/)?.[0]?.replace(/^'+|'+$/g, "");
  if (lastWord && DISCORD_REALTIME_FORCED_CONSULT_TRAILING_FRAGMENT_WORDS.has(lastWord)) {
    return "trailing-fragment";
  }
  if (
    !normalized.includes("?") &&
    (/^(i'?ll|i will) be (right )?back\b/.test(normalized) ||
      /\b(see you|bye(?:-bye)?|goodbye)\b/.test(normalized))
  ) {
    return "non-actionable-closing";
  }
  return undefined;
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
  const value = config?.[key];
  return typeof value === "boolean" ? value : undefined;
}

export function resolveDiscordVoiceMode(voice: DiscordAccountConfig["voice"]): DiscordVoiceMode {
  const mode = voice?.mode;
  if (mode === "stt-tts" || mode === "bidi") {
    return mode;
  }
  return "agent-proxy";
}

export function isDiscordRealtimeVoiceMode(mode: DiscordVoiceMode): boolean {
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

function normalizeRealtimeConsultMatchText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function matchesPendingAgentProxyQuestion(consultMessage: string, question: string): boolean {
  const normalizedConsult = normalizeRealtimeConsultMatchText(consultMessage);
  const normalizedQuestion = normalizeRealtimeConsultMatchText(question);
  if (!normalizedConsult || !normalizedQuestion) {
    return false;
  }
  return (
    normalizedConsult.includes(normalizedQuestion) || normalizedQuestion.includes(normalizedConsult)
  );
}

export class DiscordRealtimeVoiceSession implements VoiceRealtimeSession {
  private bridge: RealtimeVoiceBridgeSession | null = null;
  private outputStream: PassThrough | null = null;
  private readonly talkback: RealtimeVoiceAgentTalkbackQueue;
  private stopped = false;
  private consultToolPolicy: RealtimeVoiceAgentConsultToolPolicy = "safe-read-only";
  private consultToolsAllow: string[] | undefined;
  private consultPolicy: "auto" | "always" = "auto";
  private pendingAgentProxyConsultContexts: PendingAgentProxyConsultContext[] = [];
  private recentAgentProxyConsultContexts: RecentAgentProxyConsultContext[] = [];
  private readonly pendingSpeakerTurns: PendingSpeakerTurn[] = [];
  private outputAudioTimestampMs = 0;
  private outputAudioDiscordBytes = 0;
  private outputAudioRealtimeBytes = 0;
  private outputAudioChunks = 0;
  private outputAudioStartedAt: number | undefined;
  private outputStreamEnding = false;
  private queuedExactSpeechMessages: string[] = [];
  private exactSpeechResponseActive = false;
  private exactSpeechAudioStarted = false;
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
    const usesRealtimeAgentHandoff = this.params.mode === "bidi" || toolPolicy !== "none";
    const autoRespondToAudio = !isAgentProxy || consultPolicy !== "always";
    const interruptResponseOnInputAudio = resolveDiscordRealtimeInterruptResponseOnInputAudio({
      realtimeConfig: this.realtimeConfig,
      providerId: resolved.provider.id,
    });
    const instructions = buildDiscordRealtimeInstructions({
      mode: this.params.mode,
      instructions: this.realtimeConfig?.instructions,
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
      tools: usesRealtimeAgentHandoff ? resolveRealtimeVoiceAgentConsultTools(toolPolicy) : [],
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
        if (!isFinal || role !== "user" || !isDiscordAgentProxyVoiceMode(this.params.mode)) {
          return;
        }
        if (usesRealtimeAgentHandoff) {
          this.scheduleForcedAgentProxyConsult(text);
          return;
        }
        this.talkback.enqueue(text, this.consumePendingSpeakerContext());
      },
      onToolCall: (event, session) => this.handleToolCall(event, session),
      onEvent: (event) => {
        const detail = event.detail ? ` ${event.detail}` : "";
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
          this.finishOutputAudioStream(event.type);
        }
        const interruptionLog = formatRealtimeInterruptionLog(event);
        if (interruptionLog) {
          logger.info(interruptionLog);
        }
      },
      onError: (error) =>
        logger.warn(`discord voice: realtime error: ${formatErrorMessage(error)}`),
      onClose: (reason) => logVoiceVerbose(`realtime closed: ${reason}`),
    });
    const resolvedModel =
      readProviderConfigString(resolved.providerConfig, "model") ?? resolved.provider.defaultModel;
    const resolvedVoice = readProviderConfigString(resolved.providerConfig, "voice");
    logger.info(
      `discord voice: realtime bridge starting mode=${this.params.mode} provider=${resolved.provider.id} model=${resolvedModel ?? "default"} voice=${resolvedVoice ?? "default"} consultPolicy=${consultPolicy} toolPolicy=${toolPolicy} autoRespond=${autoRespondToAudio} interruptResponse=${interruptResponseOnInputAudio} bargeIn=${resolveDiscordRealtimeBargeIn(
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
    this.talkback.close();
    this.clearForcedConsultTimers();
    this.pendingAgentProxyConsultContexts = [];
    this.recentAgentProxyConsultContexts = [];
    this.pendingSpeakerTurns.length = 0;
    this.queuedExactSpeechMessages = [];
    this.exactSpeechResponseActive = false;
    this.exactSpeechAudioStarted = false;
    this.clearOutputAudio("session-close");
    this.bridge?.close();
    this.bridge = null;
    const voiceSdk = loadDiscordVoiceSdk();
    this.params.entry.player.off(voiceSdk.AudioPlayerStatus.Idle, this.playerIdleHandler);
  }

  beginSpeakerTurn(context: VoiceRealtimeSpeakerContext, userId: string): VoiceRealtimeSpeakerTurn {
    const turn: PendingSpeakerTurn = {
      context: { ...context, userId },
      hasAudio: false,
      inputDiscordBytes: 0,
      inputRealtimeBytes: 0,
      inputChunks: 0,
      interruptedPlayback: false,
      closed: false,
      startedAt: Date.now(),
    };
    this.pendingSpeakerTurns.push(turn);
    logger.info(
      `discord voice: realtime speaker turn opened guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${userId} speaker=${context.speakerLabel} owner=${context.senderIsOwner} pendingTurns=${this.pendingSpeakerTurns.length}`,
    );
    this.prunePendingSpeakerTurns();
    return {
      sendInputAudio: (discordPcm48kStereo) =>
        this.sendInputAudioForTurn(turn, discordPcm48kStereo),
      close: () => {
        this.logSpeakerTurnClosed(turn);
        turn.closed = true;
        this.prunePendingSpeakerTurns();
      },
    };
  }

  private sendInputAudioForTurn(turn: PendingSpeakerTurn, discordPcm48kStereo: Buffer): void {
    if (!this.bridge || this.stopped) {
      return;
    }
    turn.hasAudio = true;
    const realtimePcm = convertDiscordPcm48kStereoToRealtimePcm24kMono(discordPcm48kStereo);
    if (realtimePcm.length > 0) {
      turn.inputDiscordBytes += discordPcm48kStereo.length;
      turn.inputRealtimeBytes += realtimePcm.length;
      turn.inputChunks += 1;
      turn.lastAudioAt = Date.now();
      if (turn.inputChunks === 1) {
        logger.info(
          `discord voice: realtime input audio started guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${turn.context.userId} speaker=${turn.context.speakerLabel} discordBytes=${discordPcm48kStereo.length} realtimeBytes=${realtimePcm.length} outputAudioMs=${Math.floor(this.outputAudioTimestampMs)} outputActive=${this.isOutputAudioActive()}`,
        );
      }
      const outputActive = this.hasInterruptibleOutputAudio();
      if (!turn.interruptedPlayback && this.isBargeInEnabled() && outputActive) {
        turn.interruptedPlayback = true;
        logVoiceVerbose(
          `realtime barge-in from active speaker audio: guild ${this.params.entry.guildId} channel ${this.params.entry.channelId} user ${turn.context.userId}`,
        );
        logger.info(
          `discord voice: realtime barge-in detected source=active-speaker-audio guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${turn.context.userId} speaker=${turn.context.speakerLabel} outputAudioMs=${Math.floor(this.outputAudioTimestampMs)} outputActive=${this.isOutputAudioActive()} discordBytes=${discordPcm48kStereo.length} realtimeBytes=${realtimePcm.length}`,
        );
        this.handleBargeIn("active-speaker-audio");
      }
      this.bridge.sendAudio(realtimePcm);
    }
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
        `discord voice: realtime barge-in ignored reason=${reason} outputActive=false guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} playbackChunks=${this.outputAudioChunks}`,
      );
      return;
    }
    logger.info(
      `discord voice: realtime barge-in requested reason=${reason} guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} outputAudioMs=${Math.floor(this.outputAudioTimestampMs)} outputActive=${this.isOutputAudioActive()} playbackChunks=${this.outputAudioChunks}`,
    );
    this.bridge?.handleBargeIn({ audioPlaybackActive: true });
  }

  isBargeInEnabled(): boolean {
    const providerId = this.realtimeConfig?.provider ?? "openai";
    return resolveDiscordRealtimeBargeIn({
      realtimeConfig: this.realtimeConfig,
      providerId,
    });
  }

  private hasInterruptibleOutputAudio(): boolean {
    this.syncOutputAudioTimestamp();
    return (
      this.isOutputAudioActive() || this.outputAudioChunks > 0 || this.outputAudioTimestampMs > 0
    );
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
    if (this.outputStreamEnding) {
      logVoiceVerbose(
        `realtime output audio ignored after stream ending: guild ${this.params.entry.guildId} channel ${this.params.entry.channelId}`,
      );
      return;
    }
    const stream = this.ensureOutputStream();
    if (this.exactSpeechResponseActive) {
      this.exactSpeechAudioStarted = true;
    }
    stream.write(discordPcm);
    this.outputAudioDiscordBytes += discordPcm.length;
    this.outputAudioRealtimeBytes += realtimePcm24kMono.length;
    this.outputAudioChunks += 1;
    this.outputAudioTimestampMs += pcm16MonoDurationMs(
      realtimePcm24kMono,
      REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz,
    );
  }

  private ensureOutputStream(): PassThrough {
    if (this.outputStream && !this.outputStream.destroyed && !this.outputStream.writableEnded) {
      return this.outputStream;
    }
    const voiceSdk = loadDiscordVoiceSdk();
    const stream = new PassThrough();
    this.outputStream = stream;
    this.outputAudioStartedAt = Date.now();
    stream.once("close", () => {
      if (this.outputStream === stream) {
        this.logOutputAudioStopped("stream-close");
        this.outputStream = null;
        this.resetOutputAudioStats();
        this.completeExactSpeechResponse("stream-close", { drain: false });
      }
    });
    const resource = voiceSdk.createAudioResource(stream, {
      inputType: voiceSdk.StreamType.Raw,
    });
    this.params.entry.player.play(resource);
    const realtimeConfig = this.realtimeConfig;
    logger.info(
      `discord voice: realtime audio playback started guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} mode=${this.params.mode} model=${realtimeConfig?.model ?? "provider-default"} voice=${realtimeConfig?.voice ?? "provider-default"}`,
    );
    return stream;
  }

  private clearOutputAudio(reason = "clear"): void {
    this.resetOutputStream(reason);
    this.params.entry.player.stop(true);
  }

  private resetOutputStream(reason = "reset"): void {
    const stream = this.outputStream;
    this.logOutputAudioStopped(reason);
    this.outputStream = null;
    this.resetOutputAudioStats();
    stream?.end();
    stream?.destroy();
  }

  private finishOutputAudioStream(reason: string): void {
    const stream = this.outputStream;
    if (!stream || stream.destroyed || this.outputStreamEnding) {
      return;
    }
    this.outputStreamEnding = true;
    logger.info(
      `discord voice: realtime audio playback finishing reason=${reason} guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} audioMs=${Math.floor(this.outputAudioTimestampMs)} chunks=${this.outputAudioChunks}`,
    );
    stream.end();
  }

  private enqueueExactSpeechMessage(text: string): void {
    if (this.stopped || !text.trim()) {
      return;
    }
    if (this.exactSpeechResponseActive || this.hasInterruptibleOutputAudio()) {
      this.queuedExactSpeechMessages.push(text);
      logger.info(
        `discord voice: realtime exact speech queued guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} queued=${this.queuedExactSpeechMessages.length} outputAudioMs=${Math.floor(this.outputAudioTimestampMs)} outputActive=${this.isOutputAudioActive()}`,
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
    const audioMs = Math.floor(this.outputAudioTimestampMs);
    const chunks = this.outputAudioChunks;
    const discordBytes = this.outputAudioDiscordBytes;
    const realtimeBytes = this.outputAudioRealtimeBytes;
    const elapsedMs = this.outputAudioStartedAt ? Date.now() - this.outputAudioStartedAt : 0;
    if (this.outputStream || chunks > 0 || audioMs > 0) {
      logger.info(
        `discord voice: realtime audio playback stopped reason=${reason} guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} audioMs=${audioMs} elapsedMs=${elapsedMs} chunks=${chunks} discordBytes=${discordBytes} realtimeBytes=${realtimeBytes}`,
      );
    }
  }

  private resetOutputAudioStats(): void {
    this.outputAudioTimestampMs = 0;
    this.outputAudioDiscordBytes = 0;
    this.outputAudioRealtimeBytes = 0;
    this.outputAudioChunks = 0;
    this.outputAudioStartedAt = undefined;
    this.outputStreamEnding = false;
  }

  private syncOutputAudioTimestamp(): void {
    this.bridge?.setMediaTimestamp(Math.floor(this.outputAudioTimestampMs));
  }

  private isOutputAudioActive(): boolean {
    return Boolean(this.outputStream && !this.outputStream.destroyed) || this.outputAudioChunks > 0;
  }

  private logSpeakerTurnClosed(turn: PendingSpeakerTurn): void {
    if (turn.closed) {
      return;
    }
    const elapsedMs = Date.now() - turn.startedAt;
    const sinceLastAudioMs = turn.lastAudioAt ? Date.now() - turn.lastAudioAt : undefined;
    logger.info(
      `discord voice: realtime speaker turn closed guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${turn.context.userId} speaker=${turn.context.speakerLabel} owner=${turn.context.senderIsOwner} hasAudio=${turn.hasAudio} chunks=${turn.inputChunks} discordBytes=${turn.inputDiscordBytes} realtimeBytes=${turn.inputRealtimeBytes} elapsedMs=${elapsedMs}${sinceLastAudioMs === undefined ? "" : ` sinceLastAudioMs=${sinceLastAudioMs}`} interruptedPlayback=${turn.interruptedPlayback}`,
    );
  }

  private handleToolCall(
    event: RealtimeVoiceToolCallEvent,
    session: RealtimeVoiceBridgeSession,
  ): void {
    const callId = event.callId || event.itemId || "unknown";
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
    if (session.bridge.supportsToolResultContinuation) {
      session.submitToolResult(callId, buildRealtimeVoiceAgentConsultWorkingResponse("speaker"), {
        willContinue: true,
      });
    }
    const pendingConsultContext = this.consumeAgentProxyConsultContext(consultMessage);
    if (pendingConsultContext) {
      this.addRecentAgentProxyConsultQuestion(pendingConsultContext.recent, consultMessage);
    }
    let context = pendingConsultContext?.context;
    let recent = pendingConsultContext?.recent;
    if (!context) {
      const recentConsult = this.findRecentAgentProxyConsultContext(consultMessage);
      if (recentConsult) {
        if (this.hasPendingSpeakerAudioContext()) {
          logger.info(
            `discord voice: realtime consult matched recent agent result but newer speaker audio is pending call=${callId} speaker=${recentConsult.context.speakerLabel} owner=${recentConsult.context.senderIsOwner}`,
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
        recent = this.rememberRecentAgentProxyConsultContext(consultMessage, context);
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

  private scheduleForcedAgentProxyConsult(transcript: string): void {
    if (this.consultPolicy !== "always") {
      return;
    }
    const question = transcript.trim();
    if (!question) {
      return;
    }
    const context = this.consumePendingSpeakerContext();
    const skipReason = classifySkippableForcedAgentProxyTranscript(question);
    if (skipReason) {
      logger.info(
        `discord voice: realtime forced agent consult skipped reason=${skipReason} chars=${question.length} speaker=${context?.speakerLabel ?? "unknown"} transcript=${formatRealtimeLogPreview(question)}`,
      );
      return;
    }
    if (!context) {
      const recent = this.findRecentAgentProxyConsultContext(question);
      if (recent) {
        logVoiceVerbose(
          `realtime forced agent consult skipped (already delegated): guild ${this.params.entry.guildId} channel ${this.params.entry.channelId} speaker ${recent.context.userId}`,
        );
        return;
      }
      logger.warn("discord voice: realtime forced agent consult has no speaker context");
      return;
    }
    const recent = this.rememberRecentAgentProxyConsultContext(question, context);
    const pending: PendingAgentProxyConsultContext = { context, question, recent };
    this.pendingAgentProxyConsultContexts.push(pending);
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      void this.runForcedAgentProxyConsult(pending);
    }, DISCORD_REALTIME_FORCED_CONSULT_FALLBACK_DELAY_MS);
    pending.timer.unref?.();
  }

  private clearForcedConsultTimers(): void {
    for (const pending of this.pendingAgentProxyConsultContexts) {
      this.clearForcedConsultTimer(pending);
    }
  }

  private clearForcedConsultTimer(pending: PendingAgentProxyConsultContext): void {
    if (!pending.timer) {
      return;
    }
    clearTimeout(pending.timer);
    pending.timer = undefined;
  }

  private consumeAgentProxyConsultContext(
    consultMessage: string,
  ): PendingAgentProxyConsultContext | undefined {
    let pending: PendingAgentProxyConsultContext | undefined;
    if (this.pendingAgentProxyConsultContexts.length === 1) {
      pending = this.pendingAgentProxyConsultContexts.shift();
    } else if (this.pendingAgentProxyConsultContexts.length > 1) {
      const index = this.pendingAgentProxyConsultContexts.findIndex((candidate) =>
        matchesPendingAgentProxyQuestion(consultMessage, candidate.question),
      );
      if (index < 0) {
        return undefined;
      }
      pending = this.pendingAgentProxyConsultContexts.splice(index, 1)[0];
    }
    if (!pending) {
      return undefined;
    }
    this.clearForcedConsultTimer(pending);
    return pending;
  }

  private removePendingAgentProxyConsultContext(pending: PendingAgentProxyConsultContext): void {
    this.clearForcedConsultTimer(pending);
    const index = this.pendingAgentProxyConsultContexts.indexOf(pending);
    if (index >= 0) {
      this.pendingAgentProxyConsultContexts.splice(index, 1);
    }
  }

  private async runForcedAgentProxyConsult(
    pending: PendingAgentProxyConsultContext,
  ): Promise<void> {
    this.removePendingAgentProxyConsultContext(pending);
    const { context, question } = pending;
    if (this.stopped) {
      return;
    }
    const startedAt = Date.now();
    logger.info(
      `discord voice: realtime forced agent consult starting chars=${question.length} voiceSession=${this.params.entry.voiceSessionKey} supervisorSession=${this.params.entry.route.sessionKey} agent=${this.params.entry.route.agentId} speaker=${context.speakerLabel} owner=${context.senderIsOwner}`,
    );
    if (this.hasInterruptibleOutputAudio()) {
      logger.info(
        `discord voice: realtime barge-in requested reason=forced-agent-consult guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} outputAudioMs=${Math.floor(this.outputAudioTimestampMs)} outputActive=${this.isOutputAudioActive()} playbackChunks=${this.outputAudioChunks} force=true`,
      );
      this.bridge?.handleBargeIn({ audioPlaybackActive: true, force: true });
      this.clearOutputAudio("forced-agent-consult");
    }
    pending.recent.handledByForcedPlayback = true;
    try {
      const promise = this.runAgentTurn({
        context,
        message: [
          question,
          "Context: The realtime model produced a final user transcript without calling openclaw_agent_consult. OpenClaw is forcing the consult because consultPolicy is always.",
        ].join("\n\n"),
      });
      this.setRecentAgentProxyConsultPromise(pending.recent, promise);
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
    this.prunePendingSpeakerTurns();
    this.expireClosedSpeakerTurnsBeforeLaterAudio();
    const index = this.pendingSpeakerTurns.findIndex((turn) => turn.hasAudio);
    if (index < 0) {
      return undefined;
    }
    const [turn] = this.pendingSpeakerTurns.splice(index, 1);
    this.prunePendingSpeakerTurns();
    return turn?.context;
  }

  private hasPendingSpeakerAudioContext(): boolean {
    this.prunePendingSpeakerTurns();
    this.expireClosedSpeakerTurnsBeforeLaterAudio();
    return this.pendingSpeakerTurns.some((turn) => turn.hasAudio);
  }

  private prunePendingSpeakerTurns(): void {
    for (let index = this.pendingSpeakerTurns.length - 1; index >= 0; index -= 1) {
      const turn = this.pendingSpeakerTurns[index];
      if (turn?.closed && !turn.hasAudio) {
        this.pendingSpeakerTurns.splice(index, 1);
      }
    }
    while (this.pendingSpeakerTurns.length > DISCORD_REALTIME_PENDING_SPEAKER_CONTEXT_LIMIT) {
      const completedIndex = this.pendingSpeakerTurns.findIndex((turn) => turn.closed);
      this.pendingSpeakerTurns.splice(Math.max(completedIndex, 0), 1);
    }
  }

  private expireClosedSpeakerTurnsBeforeLaterAudio(): void {
    let hasLaterAudio = false;
    for (let index = this.pendingSpeakerTurns.length - 1; index >= 0; index -= 1) {
      const turn = this.pendingSpeakerTurns[index];
      if (!turn?.hasAudio) {
        continue;
      }
      if (turn.closed && hasLaterAudio) {
        this.pendingSpeakerTurns.splice(index, 1);
        continue;
      }
      hasLaterAudio = true;
    }
  }

  private rememberRecentAgentProxyConsultContext(
    question: string,
    context: DiscordRealtimeSpeakerContext,
  ): RecentAgentProxyConsultContext {
    this.pruneRecentAgentProxyConsultContexts();
    const recent: RecentAgentProxyConsultContext = {
      context,
      createdAt: Date.now(),
      questions: [question],
    };
    this.recentAgentProxyConsultContexts.push(recent);
    this.pruneRecentAgentProxyConsultContexts();
    return recent;
  }

  private addRecentAgentProxyConsultQuestion(
    recent: RecentAgentProxyConsultContext,
    question: string,
  ): void {
    if (
      recent.questions.some((candidate) => matchesPendingAgentProxyQuestion(question, candidate))
    ) {
      return;
    }
    recent.questions.push(question);
  }

  private setRecentAgentProxyConsultPromise(
    recent: RecentAgentProxyConsultContext,
    promise: Promise<string>,
  ): void {
    recent.promise = promise;
    void promise
      .then((text) => {
        recent.result = { status: "fulfilled", text };
      })
      .catch((error: unknown) => {
        recent.result = { status: "rejected", error: formatErrorMessage(error) };
      });
  }

  private findRecentAgentProxyConsultContext(
    consultMessage: string,
  ): RecentAgentProxyConsultContext | undefined {
    this.pruneRecentAgentProxyConsultContexts();
    for (let index = this.recentAgentProxyConsultContexts.length - 1; index >= 0; index -= 1) {
      const recent = this.recentAgentProxyConsultContexts[index];
      if (
        recent?.questions.some((question) =>
          matchesPendingAgentProxyQuestion(consultMessage, question),
        )
      ) {
        return recent;
      }
    }
    return undefined;
  }

  private submitRecentAgentProxyConsultResult(
    callId: string,
    recent: RecentAgentProxyConsultContext,
    session: RealtimeVoiceBridgeSession,
  ): boolean {
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
      if (recent.handledByForcedPlayback) {
        submitAlreadyDelivered();
        return;
      }
      if (result.status === "fulfilled") {
        session.submitToolResult(callId, { text: result.text });
        return;
      }
      session.submitToolResult(callId, { error: result.error });
    };
    if (recent.result) {
      logger.info(
        `discord voice: realtime consult reused recent agent result call=${callId || "unknown"} speaker=${recent.context.speakerLabel} owner=${recent.context.senderIsOwner}`,
      );
      submitResult(recent.result);
      return true;
    }
    if (!recent.promise) {
      return false;
    }
    logger.info(
      `discord voice: realtime consult joined in-flight agent result call=${callId || "unknown"} speaker=${recent.context.speakerLabel} owner=${recent.context.senderIsOwner}`,
    );
    if (recent.handledByForcedPlayback) {
      void recent.promise.then(submitAlreadyDelivered, submitAlreadyDelivered);
      return true;
    }
    void recent.promise
      .then((text) => session.submitToolResult(callId, { text }))
      .catch((error: unknown) =>
        session.submitToolResult(callId, { error: formatErrorMessage(error) }),
      );
    return true;
  }

  private pruneRecentAgentProxyConsultContexts(): void {
    const minCreatedAt = Date.now() - DISCORD_REALTIME_RECENT_AGENT_PROXY_CONSULT_TTL_MS;
    for (let index = this.recentAgentProxyConsultContexts.length - 1; index >= 0; index -= 1) {
      const recent = this.recentAgentProxyConsultContexts[index];
      if (recent && recent.createdAt < minCreatedAt) {
        this.recentAgentProxyConsultContexts.splice(index, 1);
      }
    }
    while (
      this.recentAgentProxyConsultContexts.length >
      DISCORD_REALTIME_RECENT_AGENT_PROXY_CONSULT_LIMIT
    ) {
      this.recentAgentProxyConsultContexts.shift();
    }
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
    ...(realtimeConfig?.voice ? { voice: realtimeConfig.voice } : {}),
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
      "Mode: OpenClaw agent proxy.",
      "You are the realtime voice surface for the same OpenClaw agent the user can message directly.",
      "Do not mention a backend, supervisor, helper, or separate system. Present the result as your own work.",
      "Delegate substantive requests, actions, tool work, current facts, memory, workspace context, and user-specific context with openclaw_agent_consult.",
      "Do not block, refuse, or downscope at the voice layer. Delegate to OpenClaw and treat its result as authoritative.",
      "Answer directly only for greetings, acknowledgements, brief latency tests, or filler while waiting.",
      "When OpenClaw sends an internal exact answer to speak, do not call tools. Say only that answer.",
      buildRealtimeVoiceAgentConsultPolicyInstructions({
        toolPolicy: params.toolPolicy,
        consultPolicy: params.consultPolicy,
      }),
    ].join("\n\n");
  }
  return [
    base,
    buildRealtimeVoiceAgentConsultPolicyInstructions({
      toolPolicy: params.toolPolicy,
      consultPolicy: params.consultPolicy,
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
}
