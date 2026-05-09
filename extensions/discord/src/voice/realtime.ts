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

export type DiscordVoiceMode = "stt-tts" | "talk-buffer" | "bidi";

type DiscordRealtimeSpeakerContext = VoiceRealtimeSpeakerContext & { userId: string };

type DiscordRealtimeVoiceConfig = NonNullable<DiscordAccountConfig["voice"]>["realtime"];

type PendingSpeakerTurn = {
  context: DiscordRealtimeSpeakerContext;
  hasAudio: boolean;
  closed: boolean;
};

export function resolveDiscordVoiceMode(voice: DiscordAccountConfig["voice"]): DiscordVoiceMode {
  const mode = voice?.mode;
  return mode === "talk-buffer" || mode === "bidi" ? mode : "stt-tts";
}

export function isDiscordRealtimeVoiceMode(mode: DiscordVoiceMode): boolean {
  return mode === "talk-buffer" || mode === "bidi";
}

export function buildDiscordSpeakExactUserMessage(text: string): string {
  return [
    "Speak this exact OpenClaw answer to the Discord voice channel, without adding, removing, or rephrasing words.",
    `Answer: ${JSON.stringify(text)}`,
  ].join("\n");
}

export class DiscordRealtimeVoiceSession implements VoiceRealtimeSession {
  private bridge: RealtimeVoiceBridgeSession | null = null;
  private outputStream: PassThrough | null = null;
  private readonly talkback: RealtimeVoiceAgentTalkbackQueue;
  private stopped = false;
  private consultToolPolicy: RealtimeVoiceAgentConsultToolPolicy = "safe-read-only";
  private consultToolsAllow: string[] | undefined;
  private readonly pendingSpeakerTurns: PendingSpeakerTurn[] = [];
  private readonly playerIdleHandler = () => {
    this.resetOutputStream();
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
      deliver: (text) => this.bridge?.sendUserMessage(buildDiscordSpeakExactUserMessage(text)),
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
    const toolPolicy = resolveRealtimeVoiceAgentConsultToolPolicy(
      this.realtimeConfig?.toolPolicy,
      "safe-read-only",
    );
    this.consultToolPolicy = toolPolicy;
    this.consultToolsAllow = resolveRealtimeVoiceAgentConsultToolsAllow(toolPolicy);
    const consultPolicy = this.realtimeConfig?.consultPolicy ?? "auto";
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
      autoRespondToAudio: this.params.mode === "bidi",
      markStrategy: "ack-immediately",
      tools: this.params.mode === "bidi" ? resolveRealtimeVoiceAgentConsultTools(toolPolicy) : [],
      audioSink: {
        isOpen: () => !this.stopped,
        sendAudio: (audio) => this.sendOutputAudio(audio),
        clearAudio: () => this.clearOutputAudio(),
      },
      onTranscript: (role, text, isFinal) => {
        if (!isFinal || role !== "user" || this.params.mode !== "talk-buffer") {
          return;
        }
        this.talkback.enqueue(text, this.consumePendingSpeakerContext());
      },
      onToolCall: (event, session) => this.handleToolCall(event, session),
      onEvent: (event) => {
        const detail = event.detail ? ` ${event.detail}` : "";
        logVoiceVerbose(`realtime ${event.direction}:${event.type}${detail}`);
      },
      onError: (error) =>
        logger.warn(`discord voice: realtime error: ${formatErrorMessage(error)}`),
      onClose: (reason) => logVoiceVerbose(`realtime closed: ${reason}`),
    });
    logVoiceVerbose(
      `realtime voice bridge starting: mode=${this.params.mode} provider=${resolved.provider.id}`,
    );
    const voiceSdk = loadDiscordVoiceSdk();
    this.params.entry.player.on(voiceSdk.AudioPlayerStatus.Idle, this.playerIdleHandler);
    await this.bridge.connect();
  }

  close(): void {
    this.stopped = true;
    this.talkback.close();
    this.pendingSpeakerTurns.length = 0;
    this.clearOutputAudio();
    this.bridge?.close();
    this.bridge = null;
    const voiceSdk = loadDiscordVoiceSdk();
    this.params.entry.player.off(voiceSdk.AudioPlayerStatus.Idle, this.playerIdleHandler);
  }

  beginSpeakerTurn(context: VoiceRealtimeSpeakerContext, userId: string): VoiceRealtimeSpeakerTurn {
    const turn: PendingSpeakerTurn = {
      context: { ...context, userId },
      hasAudio: false,
      closed: false,
    };
    this.pendingSpeakerTurns.push(turn);
    this.prunePendingSpeakerTurns();
    return {
      sendInputAudio: (discordPcm48kStereo) =>
        this.sendInputAudioForTurn(turn, discordPcm48kStereo),
      close: () => {
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
      this.bridge.sendAudio(realtimePcm);
    }
  }

  handleBargeIn(): void {
    this.bridge?.handleBargeIn({ audioPlaybackActive: Boolean(this.outputStream) });
    this.clearOutputAudio();
  }

  private get realtimeConfig(): DiscordRealtimeVoiceConfig {
    return this.params.discordConfig.voice?.realtime;
  }

  private sendOutputAudio(realtimePcm24kMono: Buffer): void {
    const discordPcm = convertRealtimePcm24kMonoToDiscordPcm48kStereo(realtimePcm24kMono);
    if (discordPcm.length === 0) {
      return;
    }
    const stream = this.ensureOutputStream();
    stream.write(discordPcm);
  }

  private ensureOutputStream(): PassThrough {
    if (this.outputStream && !this.outputStream.destroyed) {
      return this.outputStream;
    }
    const voiceSdk = loadDiscordVoiceSdk();
    const stream = new PassThrough();
    this.outputStream = stream;
    stream.once("close", () => {
      if (this.outputStream === stream) {
        this.outputStream = null;
      }
    });
    const resource = voiceSdk.createAudioResource(stream, {
      inputType: voiceSdk.StreamType.Raw,
    });
    this.params.entry.player.play(resource);
    return stream;
  }

  private clearOutputAudio(): void {
    this.resetOutputStream();
    this.params.entry.player.stop(true);
  }

  private resetOutputStream(): void {
    const stream = this.outputStream;
    this.outputStream = null;
    stream?.end();
    stream?.destroy();
  }

  private handleToolCall(
    event: RealtimeVoiceToolCallEvent,
    session: RealtimeVoiceBridgeSession,
  ): void {
    const callId = event.callId || event.itemId;
    if (this.params.mode !== "bidi") {
      session.submitToolResult(callId, {
        error: `Tool "${event.name}" is only available in bidi Discord voice mode`,
      });
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
    if (session.bridge.supportsToolResultContinuation) {
      session.submitToolResult(callId, buildRealtimeVoiceAgentConsultWorkingResponse("speaker"), {
        willContinue: true,
      });
    }
    const context = this.consumePendingSpeakerContext();
    if (!context) {
      session.submitToolResult(callId, { error: "No Discord speaker context available" });
      return;
    }
    void this.runAgentTurn({
      context,
      message: buildRealtimeVoiceAgentConsultChatMessage(event.args),
    })
      .then((text) => {
        session.submitToolResult(callId, { text });
      })
      .catch((error: unknown) => {
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
      toolsAllow: this.params.mode === "bidi" ? this.consultToolsAllow : undefined,
      userId: context.userId,
    });
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
  };
  return Object.keys(overrides).length > 0 ? overrides : undefined;
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
  if (params.mode === "talk-buffer") {
    return [
      base,
      "Mode: buffered OpenClaw agent talkback.",
      "Use audio input only to transcribe the speaker. Do not answer user speech by yourself.",
      "When OpenClaw sends an exact answer to speak, say only that answer.",
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
