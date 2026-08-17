import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  buildRealtimeVoiceSessionInstructions,
  buildRealtimeVoiceSpeakExactMessage,
  createRealtimeVoiceSessionHarness,
  isRealtimeVoiceWakeNameRequired,
  matchRealtimeVoiceConsultQuestions,
  REALTIME_VOICE_AGENT_CONTROL_TOOL,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  resolveConfiguredRealtimeVoiceProvider,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceBargeIn,
  resolveRealtimeVoiceInterruptResponseOnInputAudio,
  resolveRealtimeVoiceMinBargeInAudioEndMs,
  resolveRealtimeVoiceSessionPolicy,
  type RealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceBridgeEvent,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceSessionHarness,
  type RealtimeVoiceWakeNamePolicy,
} from "openclaw/plugin-sdk/realtime-voice";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { formatVoiceLogPreview } from "./log-preview.js";
import { DiscordRealtimeConsults, type AgentProxyConsultState } from "./realtime-consults.js";
import { DiscordRealtimePlayback } from "./realtime-playback.js";
import { DiscordRealtimeTurns } from "./realtime-turns.js";
import {
  logVoiceVerbose,
  type DiscordVoiceMode,
  type VoiceRealtimeAgentTurnParams,
  type VoiceRealtimeSession,
  type VoiceRealtimeSpeakerContext,
  type VoiceRealtimeSpeakerTurn,
  type VoiceSessionEntry,
} from "./session.js";

const logger = createSubsystemLogger("discord/voice");
const DISCORD_REALTIME_DUPLICATE_ERROR_SUPPRESS_MS = 60_000;
const discordRealtimeTalkPayload = () => ({});
const DISCORD_REALTIME_VERBOSE_OMITTED_EVENTS = new Set([
  "conversation.output_audio.delta",
  "input_audio_buffer.append",
  "response.audio.delta",
  "response.output_audio.delta",
]);

type DiscordRealtimeVoiceConfig = NonNullable<DiscordAccountConfig["voice"]>["realtime"];

type DiscordRealtimeLifecycle =
  | { status: "inactive"; generation: number }
  | { status: "starting"; generation: number; instance: DiscordRealtimeVoiceSession }
  | { status: "active"; generation: number; instance: DiscordRealtimeVoiceSession }
  | { status: "stopped"; generation: number; reason: string };

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

function isDiscordAgentProxyVoiceMode(mode: DiscordVoiceMode): boolean {
  return mode === "agent-proxy";
}

export class DiscordRealtimeVoiceSession implements VoiceRealtimeSession {
  private bridge: RealtimeVoiceBridgeSession | null = null;
  private readonly harness: RealtimeVoiceSessionHarness<AgentProxyConsultState>;
  private readonly playback: DiscordRealtimePlayback<AgentProxyConsultState>;
  private readonly turns: DiscordRealtimeTurns;
  private readonly consults: DiscordRealtimeConsults;
  private lifecycle: DiscordRealtimeLifecycle = { status: "inactive", generation: 0 };
  private nextLifecycleGeneration = 0;
  private consultToolPolicy: RealtimeVoiceAgentConsultToolPolicy = "safe-read-only";
  private consultToolsAllow: string[] | undefined;
  private consultPolicy: "auto" | "always" = "auto";
  private wakeNamePolicy: RealtimeVoiceWakeNamePolicy = "never";
  private wakeNames: string[] = [];
  private realtimeProviderId: string | undefined;
  private providerGenerationObserved = false;
  private providerContinuityEpoch = 0;
  private lastRealtimeError:
    | { message: string; suppressed: number; lastLoggedAt: number }
    | undefined;

  constructor(
    private readonly params: {
      cfg: OpenClawConfig;
      discordConfig: DiscordAccountConfig;
      entry: VoiceSessionEntry;
      mode: Exclude<DiscordVoiceMode, "stt-tts">;
      bootstrapContextInstructions?: string;
      getHumanParticipantCount?: () => number;
      onTerminalError: (error: Error) => void;
      runAgentTurn: (params: VoiceRealtimeAgentTurnParams) => Promise<string>;
    },
  ) {
    this.harness = createRealtimeVoiceSessionHarness<AgentProxyConsultState>({
      talk: {
        sessionId: `discord:${this.params.entry.voiceSessionKey}:realtime`,
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
      },
      talkPayloads: {
        turnStarted: discordRealtimeTalkPayload,
        turnEnded: discordRealtimeTalkPayload,
        inputAudioDelta: discordRealtimeTalkPayload,
        outputAudioStarted: discordRealtimeTalkPayload,
        outputAudioDelta: discordRealtimeTalkPayload,
        outputAudioDone: discordRealtimeTalkPayload,
      },
      forcedConsults: {
        limit: 16,
        nativeDedupeMs: 15_000,
        questionsMatch: matchRealtimeVoiceConsultQuestions,
      },
    });
    this.playback = new DiscordRealtimePlayback({
      bridge: () => this.bridge,
      bridgeReady: () => this.isReady(),
      buildSpeakExactMessage: (text) =>
        buildRealtimeVoiceSpeakExactMessage({
          text,
          surfaceLabel: "the Discord voice channel",
        }),
      entry: this.params.entry,
      harness: this.harness,
      markProviderGenerationObserved: () => this.markProviderGenerationObserved(),
      mode: this.params.mode,
      onTerminalError: this.params.onTerminalError,
      providerId: () => this.realtimeProviderId,
      realtimeConfig: () => this.realtimeConfig,
      stopTerminally: () => {
        this.stopLifecycle("exact-speech overflow");
        this.consults.close();
      },
      stopped: () => this.isStopped(),
      wakeNameRequired: () => this.isWakeNameRequired(),
    });
    this.turns = new DiscordRealtimeTurns({
      bridge: () => this.bridge,
      entry: this.params.entry,
      getHumanParticipantCount: () => this.humanParticipantCount(),
      onAcceptedTranscript: (text, context, providerEpoch) =>
        this.consults.handleAcceptedTranscript(text, context, providerEpoch),
      playback: this.playback,
      providerEpoch: () => this.providerContinuityEpoch,
      providerId: () => this.realtimeProviderId,
      realtimeConfig: () => this.realtimeConfig,
      recordInputAudio: (audio) => this.harness.recordInputAudio(audio),
      stopped: () => this.isStopped(),
      wakeNamePolicy: () => this.wakeNamePolicy,
      wakeNames: () => this.wakeNames,
    });
    this.consults = new DiscordRealtimeConsults({
      consultPolicy: () => this.consultPolicy,
      consultToolPolicy: () => this.consultToolPolicy,
      consultToolsAllow: () => this.consultToolsAllow,
      debounceMs: () => this.realtimeConfig?.debounceMs,
      entry: this.params.entry,
      harness: this.harness,
      isAgentProxy: isDiscordAgentProxyVoiceMode(this.params.mode),
      isWakeNameRequired: () => this.isWakeNameRequired(),
      playback: this.playback,
      providerEpoch: () => this.providerContinuityEpoch,
      runAgentTurn: this.params.runAgentTurn,
      stopped: () => this.isStopped(),
      turns: this.turns,
      usesRealtimeAgentHandoff: () =>
        this.params.mode === "bidi" || this.consultToolPolicy !== "none",
      wakeNamePolicy: () => this.wakeNamePolicy,
    });
  }

  async connect(): Promise<void> {
    const lifecycleGeneration = ++this.nextLifecycleGeneration;
    this.lifecycle = {
      status: "starting",
      generation: lifecycleGeneration,
      instance: this,
    };
    const resolved = resolveConfiguredRealtimeVoiceProvider({
      configuredProviderId: this.realtimeConfig?.provider,
      providerConfigs: buildProviderConfigs(this.realtimeConfig),
      providerConfigOverrides: buildProviderConfigOverrides(this.realtimeConfig),
      cfg: this.params.cfg,
      agentId: this.params.entry.route.agentId,
      defaultModel: this.realtimeConfig?.model,
      noRegisteredProviderMessage: "No configured realtime voice provider registered",
    });
    this.realtimeProviderId = resolved.provider.id;
    const isAgentProxy = isDiscordAgentProxyVoiceMode(this.params.mode);
    const sessionPolicy = resolveRealtimeVoiceSessionPolicy({
      isAgentProxy,
      supportsActivationNameGating:
        resolved.provider.capabilities?.supportsActivationNameGating === true,
      configuredToolPolicy: this.realtimeConfig?.toolPolicy,
      configuredConsultPolicy: this.realtimeConfig?.consultPolicy,
      requireWakeName: this.realtimeConfig?.requireWakeName,
      configuredWakeNames: this.realtimeConfig?.wakeNames,
      cfg: this.params.cfg,
      agentId: this.params.entry.route.agentId,
    });
    const {
      toolPolicy,
      consultToolsAllow,
      consultPolicy,
      wakeNamePolicy,
      wakeNames,
      autoRespondToAudio,
    } = sessionPolicy;
    this.consultToolPolicy = toolPolicy;
    this.consultToolsAllow = consultToolsAllow;
    this.consultPolicy = consultPolicy;
    this.wakeNamePolicy = wakeNamePolicy;
    this.wakeNames = wakeNames;
    const usesRealtimeAgentHandoff = this.params.mode === "bidi" || toolPolicy !== "none";
    const providerInterruptResponseOnInputAudio =
      this.realtimeConfig?.providers?.[resolved.provider.id]?.interruptResponseOnInputAudio;
    const interruptResponseOnInputAudio =
      this.wakeNamePolicy === "never" &&
      resolveRealtimeVoiceInterruptResponseOnInputAudio(providerInterruptResponseOnInputAudio);
    const bargeIn = resolveRealtimeVoiceBargeIn({
      configuredBargeIn: this.realtimeConfig?.bargeIn,
      interruptResponseOnInputAudio: providerInterruptResponseOnInputAudio,
    });
    const minBargeInAudioEndMs = resolveRealtimeVoiceMinBargeInAudioEndMs(
      this.realtimeConfig?.minBargeInAudioEndMs,
    );
    const instructions = buildRealtimeVoiceSessionInstructions({
      base:
        this.realtimeConfig?.instructions ??
        [
          "You are OpenClaw's Discord voice interface.",
          "Keep spoken replies concise, natural, and suitable for a live Discord voice channel.",
        ].join("\n"),
      isAgentProxy,
      bootstrapContextInstructions: this.params.bootstrapContextInstructions,
      toolPolicy,
      consultPolicy,
    });
    this.bridge = this.harness.createBridge({
      provider: resolved.provider,
      cfg: this.params.cfg,
      agentId: this.params.entry.route.agentId,
      providerConfig: resolved.providerConfig,
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      instructions,
      autoRespondToAudio,
      interruptResponseOnInputAudio,
      markStrategy: "ack-immediately",
      tools: usesRealtimeAgentHandoff
        ? resolveRealtimeVoiceAgentConsultTools(
            toolPolicy,
            toolPolicy !== "none" ? [REALTIME_VOICE_AGENT_CONTROL_TOOL] : [],
          )
        : [],
      audioSink: {
        isOpen: () => !this.isStopped(),
        sendAudio: (audio) => this.playback.sendOutputAudio(audio),
        clearAudio: () => {
          this.markProviderGenerationObserved();
          this.harness.flushOutput(() => this.playback.clearOutputAudio("provider-clear-audio"));
        },
      },
      onTranscript: (role, text, isFinal) => {
        this.markProviderGenerationObserved();
        if (isFinal && text.trim()) {
          logger.info(
            `discord voice: realtime ${role} transcript (${text.length} chars): ${formatVoiceLogPreview(text)}`,
          );
        }
        if (isFinal && role === "assistant") {
          this.playback.suppressDuplicateControlSpeech(text);
        }
        if (role !== "user") {
          return;
        }
        if (!isFinal) {
          this.turns.handlePartialUserTranscript(text);
          return;
        }
        void this.turns.handleFinalUserTranscript(text);
      },
      onToolCall: (event, session) => {
        this.markProviderGenerationObserved();
        return this.consults.handleToolCall(event, session);
      },
      onReady: () => {
        this.markProviderGenerationObserved();
        if (this.markLifecycleReady(lifecycleGeneration)) {
          this.playback.drainQueuedExactSpeechMessages("provider-ready");
        }
      },
      onEvent: (event) => this.handleBridgeEvent(event),
      onResponseDone: (outcome) => {
        this.markProviderGenerationObserved();
        this.playback.handleResponseDone(outcome);
        if (outcome.status === "cancelled") {
          logger.info(
            `discord voice: realtime model interrupt confirmed server:response.done status=cancelled${outcome.reason ? ` reason=${outcome.reason}` : ""}`,
          );
        } else if (outcome.status === "failed" || outcome.status === "incomplete") {
          this.logRealtimeError(outcome.message);
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
    const humanParticipantCount = this.humanParticipantCount();
    logger.info(
      `discord voice: realtime bridge starting mode=${this.params.mode} provider=${resolved.provider.id} model=${resolvedModel ?? "default"} voice=${resolvedVoice ?? "default"} consultPolicy=${consultPolicy} toolPolicy=${toolPolicy} autoRespond=${autoRespondToAudio} wakeNamePolicy=${this.wakeNamePolicy} requireWakeName=${this.isWakeNameRequired(humanParticipantCount)} humanParticipants=${humanParticipantCount} wakeNames=${this.wakeNames.join(",") || "none"} interruptResponse=${interruptResponseOnInputAudio} bargeIn=${bargeIn} minBargeInAudioEndMs=${minBargeInAudioEndMs}`,
    );
    this.playback.attachPlayer();
    await this.bridge.connect();
    if (!this.markLifecycleReady(lifecycleGeneration)) {
      this.bridge?.close();
      return;
    }
    this.markProviderGenerationObserved();
    this.playback.drainQueuedExactSpeechMessages("provider-connected");
    logger.info(
      `discord voice: realtime bridge ready mode=${this.params.mode} provider=${resolved.provider.id} model=${resolvedModel ?? "default"} voice=${resolvedVoice ?? "default"}`,
    );
  }

  close(): void {
    this.stopLifecycle("session close");
    this.providerContinuityEpoch += 1;
    this.flushSuppressedRealtimeErrors();
    this.consults.close();
    this.harness.close();
    this.turns.clear();
    this.playback.close();
    this.bridge?.close();
    this.bridge = null;
    this.realtimeProviderId = undefined;
  }

  beginSpeakerTurn(context: VoiceRealtimeSpeakerContext, userId: string): VoiceRealtimeSpeakerTurn {
    return this.turns.beginSpeakerTurn(context, userId);
  }

  handleBargeIn(reason = "barge-in"): void {
    this.playback.handleBargeIn(reason);
  }

  isBargeInEnabled(): boolean {
    if (this.isWakeNameRequired()) {
      return false;
    }
    return this.playback.isBargeInEnabled();
  }

  private get realtimeConfig(): DiscordRealtimeVoiceConfig {
    return this.params.discordConfig.voice?.realtime;
  }

  private isStopped(): boolean {
    return this.lifecycle.status === "stopped";
  }

  private isReady(): boolean {
    return this.lifecycle.status === "active";
  }

  private markLifecycleReady(generation: number): boolean {
    if (
      (this.lifecycle.status !== "starting" && this.lifecycle.status !== "active") ||
      this.lifecycle.generation !== generation
    ) {
      return false;
    }
    this.lifecycle = { status: "active", generation, instance: this };
    return true;
  }

  private stopLifecycle(reason: string): void {
    const generation = this.lifecycle.generation;
    this.lifecycle = { status: "stopped", generation, reason };
  }

  private humanParticipantCount(): number {
    return this.params.getHumanParticipantCount?.() ?? 0;
  }

  private isWakeNameRequired(humanParticipantCount = this.humanParticipantCount()): boolean {
    return isRealtimeVoiceWakeNameRequired(this.wakeNamePolicy, humanParticipantCount);
  }

  private handleBridgeEvent(event: RealtimeVoiceBridgeEvent): void {
    if (!(event.direction === "client" && event.type === "session.continuity.reset")) {
      this.markProviderGenerationObserved();
    }
    const detail = event.detail ? ` ${event.detail}` : "";
    if (event.direction === "client" && event.type === "session.continuity.reset") {
      this.resetProviderContinuity(event.type);
    }
    if (event.direction === "server" && event.type === "input_audio_buffer.speech_started") {
      this.turns.resetPartialWakeNameTracking();
    }
    if (shouldLogRealtimeVerboseEvent(event)) {
      logVoiceVerbose(`realtime ${event.direction}:${event.type}${detail}`);
    }
    this.playback.handleProviderEvent(event);
    const interruptionLog = formatRealtimeInterruptionLog(event);
    if (interruptionLog) {
      logger.info(interruptionLog);
    }
    const lifecycleLog = formatRealtimeLifecycleLog(event);
    if (lifecycleLog) {
      logger.info(lifecycleLog);
    }
  }

  private markProviderGenerationObserved(): void {
    this.providerGenerationObserved = true;
  }

  private resetProviderContinuity(reason: string): void {
    if (!this.providerGenerationObserved) {
      return;
    }
    this.providerGenerationObserved = false;
    if (this.lifecycle.status === "active") {
      this.lifecycle = {
        status: "starting",
        generation: this.lifecycle.generation,
        instance: this,
      };
    }
    this.providerContinuityEpoch += 1;
    this.consults.resetProviderContinuity();
    this.turns.resetProviderContinuity();
    this.playback.resetProviderContinuity(reason);
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
        : {}),
    ...(typeof realtimeConfig?.minBargeInAudioEndMs === "number"
      ? { minBargeInAudioEndMs: realtimeConfig.minBargeInAudioEndMs }
      : {}),
  };
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}
