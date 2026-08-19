import {
  classifyRealtimeVoiceConsultToolCall,
  classifySkippableRealtimeVoiceConsultTranscript,
  controlRealtimeVoiceAgentRun,
  createRealtimeVoiceAgentTalkbackQueue,
  parseRealtimeVoiceAgentControlToolArgs,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  type RealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceAgentControlResult,
  type RealtimeVoiceAgentTalkbackQueue,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceForcedConsultHandle,
  type RealtimeVoiceSessionHarness,
  type RealtimeVoiceToolCallEvent,
  type RealtimeVoiceWakeNamePolicy,
} from "openclaw/plugin-sdk/realtime-voice";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { maybeControlDiscordVoiceAgentRun } from "./agent-control.js";
import { formatVoiceLogPreview } from "./log-preview.js";
import { formatVoiceIngressPrompt } from "./prompt.js";
import type { DiscordRealtimePlaybackPort } from "./realtime-playback.js";
import type { DiscordRealtimeSpeakerContext, DiscordRealtimeTurns } from "./realtime-turns.js";
import { isDiscordRealtimeSpeakerContext } from "./realtime-turns.js";
import type { VoiceRealtimeAgentTurnParams, VoiceSessionEntry } from "./session.js";
import { logVoiceVerbose } from "./session.js";

const logger = createSubsystemLogger("discord/voice");
const DISCORD_REALTIME_TALKBACK_DEBOUNCE_MS = 350;
const DISCORD_REALTIME_FALLBACK_TEXT = "I hit an error while checking that. Please try again.";
const DISCORD_REALTIME_FORCED_CONSULT_FALLBACK_DELAY_MS = 200;
const DISCORD_REALTIME_FORCED_CONSULT_REASON =
  "provider_final_transcript_without_openclaw_agent_consult";

type RecentAgentProxyConsultResult =
  | { status: "fulfilled"; text: string }
  | { status: "rejected"; error: string };

export type AgentProxyConsultState = {
  speaker: DiscordRealtimeSpeakerContext;
  providerEpoch: number;
  handledByForcedPlayback?: boolean;
  providerDelivery?: Promise<boolean>;
  settleProviderDelivery?: (accepted: boolean) => void;
  promise?: Promise<string>;
  result?: RecentAgentProxyConsultResult;
};

type AgentProxyConsultHandle = RealtimeVoiceForcedConsultHandle<AgentProxyConsultState>;

export class DiscordRealtimeConsults {
  private talkback: RealtimeVoiceAgentTalkbackQueue;

  constructor(
    private readonly params: {
      consultPolicy: () => "auto" | "always";
      consultToolPolicy: () => RealtimeVoiceAgentConsultToolPolicy;
      consultToolsAllow: () => string[] | undefined;
      debounceMs: () => number | undefined;
      entry: VoiceSessionEntry;
      harness: RealtimeVoiceSessionHarness<AgentProxyConsultState>;
      isAgentProxy: boolean;
      isWakeNameRequired: () => boolean;
      playback: DiscordRealtimePlaybackPort;
      providerEpoch: () => number;
      runAgentTurn: (params: VoiceRealtimeAgentTurnParams) => Promise<string>;
      stopped: () => boolean;
      turns: DiscordRealtimeTurns;
      usesRealtimeAgentHandoff: () => boolean;
      wakeNamePolicy: () => RealtimeVoiceWakeNamePolicy;
    },
  ) {
    this.talkback = this.createTalkbackQueue();
  }

  close(): void {
    this.talkback.close();
    this.clearProviderConsultState();
  }

  resetProviderContinuity(): void {
    this.talkback.close();
    this.talkback = this.createTalkbackQueue();
    this.clearProviderConsultState();
  }

  async handleToolCall(
    event: RealtimeVoiceToolCallEvent,
    session: RealtimeVoiceBridgeSession,
  ): Promise<void> {
    const providerEpoch = this.params.providerEpoch();
    const callId = event.callId || event.itemId || "unknown";
    if (event.name === REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME) {
      await this.handleAgentControlToolCall(event, session, callId, providerEpoch);
      return;
    }
    if (event.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      await session.submitToolResult(callId, { error: `Tool "${event.name}" not available` });
      return;
    }
    if (this.params.consultToolPolicy() === "none") {
      await session.submitToolResult(callId, { error: `Tool "${event.name}" not available` });
      return;
    }
    const outcome = classifyRealtimeVoiceConsultToolCall(event.args, {
      retainedExactSpeechTexts: this.params.playback.retainedExactSpeechTexts(),
    });
    switch (outcome.kind) {
      case "exact-speech-echo":
        logger.info(
          `discord voice: realtime exact speech consult bypassed call=${callId || "unknown"} answerChars=${outcome.text.length}`,
        );
        await session.submitToolResult(callId, { text: outcome.text });
        return;
      case "malformed":
        logger.warn(
          `discord voice: realtime consult rejected malformed args call=${callId || "unknown"}: ${outcome.error}`,
        );
        await session.submitToolResult(callId, { error: outcome.error });
        return;
      case "consult":
        break;
    }
    const consultMessage = outcome.message;
    logger.info(
      `discord voice: realtime consult requested call=${callId || "unknown"} voiceSession=${this.params.entry.voiceSessionKey} supervisorSession=${this.params.entry.route.sessionKey} agent=${this.params.entry.route.agentId} question=${formatVoiceLogPreview(consultMessage)}`,
    );
    const nativeConsult = this.params.harness.forcedConsults.recordNativeConsult(
      event.args,
      callId,
    );
    if (
      nativeConsult.kind === "already_delivered" &&
      this.params.harness.forcedConsults.isCancelled(nativeConsult.handle)
    ) {
      await this.submitTerminalRealtimeToolResult(callId, session, {
        status: "cancelled",
        message: "OpenClaw cancelled this consult before completion. Do not restart it.",
      });
      return;
    }
    const pendingConsult = nativeConsult.kind === "pending" ? nativeConsult.handle : undefined;
    if (pendingConsult) {
      this.params.harness.forcedConsults.rememberQuestion(pendingConsult, consultMessage);
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
        if (this.params.turns.hasPendingSpeakerAudioContext()) {
          logger.info(
            `discord voice: realtime consult matched recent agent result but newer speaker audio is pending call=${callId} speaker=${recentSpeaker?.speakerLabel ?? "unknown"} owner=${recentSpeaker?.senderIsOwner ?? false}`,
          );
          await session.submitToolResult(callId, {
            error: "Discord speaker context changed before this realtime consult completed",
          });
          return;
        }
        if (await this.submitRecentAgentProxyConsultResult(callId, recentConsult, session)) {
          return;
        }
      }
    }
    if (!context) {
      context = this.params.turns.consumePendingSpeakerContext();
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
      await session.submitToolResult(callId, { error: "No Discord speaker context available" });
      return;
    }
    const promise = this.runAgentTurn({ context, message: consultMessage });
    if (recent) {
      this.setRecentAgentProxyConsultPromise(recent, promise);
    }
    let text: string;
    try {
      text = await promise;
    } catch (error) {
      if (providerEpoch !== this.params.providerEpoch()) {
        return;
      }
      const message = formatErrorMessage(error);
      logger.warn(`discord voice: realtime consult failed call=${callId || "unknown"}: ${message}`);
      await session.submitToolResult(callId, { error: message });
      return;
    }
    if (providerEpoch !== this.params.providerEpoch()) {
      return;
    }
    logger.info(
      `discord voice: realtime consult answer (${text.length} chars) voiceSession=${this.params.entry.voiceSessionKey} supervisorSession=${this.params.entry.route.sessionKey} agent=${this.params.entry.route.agentId} speaker=${context.speakerLabel} owner=${context.senderIsOwner}: ${formatVoiceLogPreview(text)}`,
    );
    await session.submitToolResult(callId, { text });
  }

  async handleAcceptedTranscript(
    acceptedText: string,
    forcedSpeakerContext: DiscordRealtimeSpeakerContext | undefined,
    providerEpoch: number,
  ): Promise<void> {
    const pendingForcedConsult =
      this.params.isAgentProxy && this.params.usesRealtimeAgentHandoff()
        ? this.prepareForcedAgentProxyConsult(acceptedText, forcedSpeakerContext)
        : undefined;
    let control: Awaited<ReturnType<typeof maybeControlDiscordVoiceAgentRun>> | undefined;
    try {
      control = await maybeControlDiscordVoiceAgentRun({
        entry: this.params.entry,
        text: acceptedText,
      });
    } catch (error) {
      if (providerEpoch !== this.params.providerEpoch()) {
        return;
      }
      logger.warn(
        `discord voice: realtime active-run control failed; falling back to normal transcript handling: ${formatErrorMessage(error)}`,
      );
      control = undefined;
    }
    if (providerEpoch !== this.params.providerEpoch()) {
      return;
    }
    if (control?.handled) {
      if (pendingForcedConsult) {
        this.params.harness.forcedConsults.remove(pendingForcedConsult);
      }
      this.logAgentControlResult(control.result);
      if (control.speakText) {
        this.params.playback.speakControlResult(control.speakText);
      }
      return;
    }
    if (!this.params.isAgentProxy) {
      return;
    }
    if (this.params.usesRealtimeAgentHandoff()) {
      if (pendingForcedConsult) {
        this.schedulePreparedForcedAgentProxyConsult(pendingForcedConsult);
      }
      return;
    }
    this.talkback.enqueue(
      acceptedText,
      forcedSpeakerContext ?? this.params.turns.consumePendingSpeakerContext(),
    );
  }

  private createTalkbackQueue(): RealtimeVoiceAgentTalkbackQueue {
    const providerEpoch = this.params.providerEpoch();
    return createRealtimeVoiceAgentTalkbackQueue({
      debounceMs: this.params.debounceMs() ?? DISCORD_REALTIME_TALKBACK_DEBOUNCE_MS,
      isStopped: () => this.params.stopped() || providerEpoch !== this.params.providerEpoch(),
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
      deliver: (text) => this.params.playback.enqueueExactSpeechMessage(text),
    });
  }

  private async handleAgentControlToolCall(
    event: RealtimeVoiceToolCallEvent,
    session: RealtimeVoiceBridgeSession,
    callId: string,
    providerEpoch: number,
  ): Promise<void> {
    let result: RealtimeVoiceAgentControlResult;
    try {
      const parsed = parseRealtimeVoiceAgentControlToolArgs(event.args);
      result = await controlRealtimeVoiceAgentRun({
        sessionKey: this.params.entry.route.sessionKey,
        text: parsed.text,
        mode: parsed.mode,
      });
    } catch (error) {
      if (providerEpoch !== this.params.providerEpoch()) {
        return;
      }
      await session.submitToolResult(callId, { error: formatErrorMessage(error) });
      return;
    }
    if (providerEpoch !== this.params.providerEpoch()) {
      return;
    }
    this.logAgentControlResult(result);
    await session.submitToolResult(callId, result);
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
      toolsAllow: this.params.consultToolsAllow(),
      userId: context.userId,
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
    if (this.params.consultPolicy() !== "always" && this.params.wakeNamePolicy() === "never") {
      return undefined;
    }
    const question = transcript.trim();
    if (!question) {
      return undefined;
    }
    const skipReason = classifySkippableRealtimeVoiceConsultTranscript(question);
    if (skipReason) {
      const context = this.params.turns.consumePendingSpeakerContext();
      logger.info(
        `discord voice: realtime forced agent consult skipped reason=${skipReason} chars=${question.length} speaker=${context?.speakerLabel ?? "unknown"} transcript=${formatVoiceLogPreview(question)}`,
      );
      return undefined;
    }
    let context = speakerContext ?? this.params.turns.consumePendingSpeakerContext();
    if (!context) {
      context = this.params.turns.consumeRecentIgnoredWakeNameSpeakerContext();
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
    return this.params.harness.forcedConsults.prepare(question, {
      context: { speaker: context, providerEpoch: this.params.providerEpoch() },
    });
  }

  private schedulePreparedForcedAgentProxyConsult(pending: AgentProxyConsultHandle): void {
    this.params.harness.forcedConsults.schedule(
      pending,
      DISCORD_REALTIME_FORCED_CONSULT_FALLBACK_DELAY_MS,
      (handle) => void this.runForcedAgentProxyConsult(handle),
    );
  }

  private async runForcedAgentProxyConsult(pending: AgentProxyConsultHandle): Promise<void> {
    this.params.harness.forcedConsults.markStarted(pending);
    const state = pending.context;
    if (!state) {
      this.params.harness.forcedConsults.markCancelled(pending);
      return;
    }
    const context = state.speaker;
    const { question } = pending;
    if (this.params.stopped() || state.providerEpoch !== this.params.providerEpoch()) {
      this.params.harness.forcedConsults.markCancelled(pending);
      return;
    }
    const startedAt = Date.now();
    logger.info(
      `discord voice: realtime forced agent consult starting chars=${question.length} voiceSession=${this.params.entry.voiceSessionKey} supervisorSession=${this.params.entry.route.sessionKey} agent=${this.params.entry.route.agentId} speaker=${context.speakerLabel} owner=${context.senderIsOwner}`,
    );
    logger.debug(
      `discord voice: realtime forced agent consult reason=${DISCORD_REALTIME_FORCED_CONSULT_REASON} consultPolicy=${this.params.consultPolicy()} wakeNamePolicy=${this.params.wakeNamePolicy()} requireWakeName=${this.params.isWakeNameRequired()} voiceSession=${this.params.entry.voiceSessionKey} supervisorSession=${this.params.entry.route.sessionKey} agent=${this.params.entry.route.agentId} speaker=${context.speakerLabel}`,
    );
    if (this.params.playback.hasInterruptibleOutputAudio()) {
      logger.info(
        `discord voice: realtime forced agent consult preserving active playback guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} outputAudioMs=${this.params.playback.outputAudioMs()} outputActive=${this.params.playback.isOutputAudioActive()} playbackChunks=${this.params.harness.outputActivity.snapshot().chunks}`,
      );
    }
    state.handledByForcedPlayback = true;
    try {
      const promise = this.runAgentTurn({ context, message: question });
      this.setRecentAgentProxyConsultPromise(pending, promise);
      const text = await promise;
      await state.providerDelivery;
      if (state.providerEpoch !== this.params.providerEpoch()) {
        return;
      }
      logger.info(
        `discord voice: realtime forced agent consult answer (${text.length} chars) elapsedMs=${Date.now() - startedAt} voiceSession=${this.params.entry.voiceSessionKey} supervisorSession=${this.params.entry.route.sessionKey} agent=${this.params.entry.route.agentId}: ${formatVoiceLogPreview(text)}`,
      );
      if (text.trim() && state.handledByForcedPlayback) {
        this.params.playback.enqueueExactSpeechMessage(text);
      }
    } catch (error) {
      await state.providerDelivery;
      if (state.providerEpoch !== this.params.providerEpoch()) {
        return;
      }
      logger.warn(
        `discord voice: realtime forced agent consult failed elapsedMs=${Date.now() - startedAt}: ${formatErrorMessage(error)}`,
      );
      if (state.handledByForcedPlayback) {
        this.params.playback.enqueueExactSpeechMessage(DISCORD_REALTIME_FALLBACK_TEXT);
      }
    }
  }

  private rememberRecentAgentProxyConsultContext(
    question: string,
    context: DiscordRealtimeSpeakerContext,
    options: { id?: string; started?: boolean } = {},
  ): AgentProxyConsultHandle {
    const handle = this.params.harness.forcedConsults.prepare(question, {
      context: { speaker: context, providerEpoch: this.params.providerEpoch() },
      ...(options.id ? { id: options.id } : {}),
    });
    if (!handle) {
      throw new Error("Discord realtime consult context requires a non-empty question");
    }
    if (options.started) {
      this.params.harness.forcedConsults.markStarted(handle);
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
    this.params.harness.forcedConsults.markStarted(recent);
    state.promise = promise;
    void promise
      .then((text) => {
        if (state.providerEpoch !== this.params.providerEpoch()) {
          return;
        }
        state.result = { status: "fulfilled", text };
        this.params.harness.forcedConsults.markDelivered(recent);
      })
      .catch((error: unknown) => {
        if (state.providerEpoch !== this.params.providerEpoch()) {
          return;
        }
        state.result = { status: "rejected", error: formatErrorMessage(error) };
        this.params.harness.forcedConsults.markDelivered(recent);
      });
  }

  private findRecentAgentProxyConsultContext(
    consultMessage: string,
  ): AgentProxyConsultHandle | undefined {
    return this.params.harness.forcedConsults.findRecent(consultMessage);
  }

  private async submitTerminalRealtimeToolResult(
    callId: string,
    session: RealtimeVoiceBridgeSession,
    result: Record<string, string>,
  ): Promise<void> {
    // Providers without suppressed results still need a terminal result; the payload tells the
    // model not to repeat audio that Discord already played or restart cancelled work.
    if (session.bridge.supportsToolResultSuppression === false) {
      await session.submitToolResult(callId, result);
      return;
    }
    await session.submitToolResult(callId, result, { suppressResponse: true });
  }

  private async submitRecentAgentProxyConsultResult(
    callId: string,
    recent: AgentProxyConsultHandle,
    session: RealtimeVoiceBridgeSession,
  ): Promise<boolean> {
    const state = recent.context;
    if (!state) {
      return false;
    }
    if (state.providerEpoch !== this.params.providerEpoch()) {
      return true;
    }
    const providerOwnsDelivery = Boolean(
      state.handledByForcedPlayback &&
      state.promise &&
      !state.result &&
      session.bridge.supportsToolResultSuppression === false,
    );
    let resolveProviderDelivery: ((accepted: boolean) => void) | undefined;
    if (providerOwnsDelivery) {
      // Forced playback waits for native acceptance so a failed delivery can restore
      // the local success/fallback path instead of losing the answer entirely.
      state.providerDelivery = new Promise<boolean>((resolve) => {
        resolveProviderDelivery = resolve;
        state.settleProviderDelivery = resolve;
      });
    }
    const submitAlreadyDelivered = async (): Promise<void> => {
      if (state.providerEpoch !== this.params.providerEpoch()) {
        return;
      }
      await this.submitTerminalRealtimeToolResult(callId, session, {
        status: "already_delivered",
        message: "OpenClaw already delivered this answer to Discord voice. Do not repeat it.",
      });
    };
    const submitResult = async (result: RecentAgentProxyConsultResult): Promise<void> => {
      if (state.providerEpoch !== this.params.providerEpoch()) {
        return;
      }
      if (state.handledByForcedPlayback && !providerOwnsDelivery) {
        await submitAlreadyDelivered();
        return;
      }
      if (result.status === "fulfilled") {
        await session.submitToolResult(callId, { text: result.text });
        return;
      }
      await session.submitToolResult(callId, { error: result.error });
    };
    if (state.result) {
      logger.info(
        `discord voice: realtime consult reused recent agent result call=${callId || "unknown"} speaker=${state.speaker.speakerLabel} owner=${state.speaker.senderIsOwner}`,
      );
      await submitResult(state.result);
      return true;
    }
    if (!state.promise) {
      return false;
    }
    logger.info(
      `discord voice: realtime consult joined in-flight agent result call=${callId || "unknown"} speaker=${state.speaker.speakerLabel} owner=${state.speaker.senderIsOwner}`,
    );
    if (state.handledByForcedPlayback && !providerOwnsDelivery) {
      await state.promise.catch(() => undefined);
      if (state.providerEpoch !== this.params.providerEpoch()) {
        return true;
      }
      await submitAlreadyDelivered();
      return true;
    }
    let result: RecentAgentProxyConsultResult;
    try {
      result = { status: "fulfilled", text: await state.promise };
    } catch (error) {
      result = { status: "rejected", error: formatErrorMessage(error) };
    }
    if (state.providerEpoch !== this.params.providerEpoch()) {
      return true;
    }
    try {
      await submitResult(result);
      if (providerOwnsDelivery) {
        state.handledByForcedPlayback = false;
        state.settleProviderDelivery = undefined;
        resolveProviderDelivery?.(true);
      }
    } catch (error) {
      state.settleProviderDelivery = undefined;
      resolveProviderDelivery?.(false);
      throw error;
    }
    return true;
  }

  private clearProviderConsultState(): void {
    for (const handle of this.params.harness.forcedConsults.handles()) {
      const state = handle.context;
      if (!state) {
        continue;
      }
      state.handledByForcedPlayback = false;
      state.settleProviderDelivery?.(false);
      state.settleProviderDelivery = undefined;
      state.providerDelivery = undefined;
    }
    this.params.harness.forcedConsults.clear();
  }
}
