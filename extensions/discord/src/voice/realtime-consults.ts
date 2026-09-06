import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  buildRealtimeVoiceAgentErrorProviderResult,
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

const CANCELLED_CONSULT_RESULT = {
  status: "cancelled",
  message: "OpenClaw cancelled this consult before completion. Do not restart it.",
};

type AgentProxyConsultResult =
  | { text: string }
  | ReturnType<typeof buildRealtimeVoiceAgentErrorProviderResult>;

type AgentProxyProviderDelivery = ReturnType<typeof createDeferred<void>>;

export type AgentProxyConsultState = {
  speaker: DiscordRealtimeSpeakerContext;
  providerEpoch: number;
  handledByForcedPlayback?: boolean;
  promise?: Promise<AgentProxyConsultResult>;
  result?: AgentProxyConsultResult;
};

type AgentProxyConsultHandle = RealtimeVoiceForcedConsultHandle<AgentProxyConsultState>;

export class DiscordRealtimeConsults {
  private talkback: RealtimeVoiceAgentTalkbackQueue;
  // Pending deliveries outlive the coordinator's recent-result dedupe window.
  private readonly providerDeliveries = new Map<
    AgentProxyConsultState,
    Set<AgentProxyProviderDelivery>
  >();

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

  isIdle(): boolean {
    return (
      this.talkback.isIdle() &&
      this.providerDeliveries.size === 0 &&
      this.params.harness.forcedConsults.handles().every((handle) => handle.context?.result)
    );
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
    if (this.params.stopped() || !this.params.turns.speakerContext()) {
      await session.submitToolResult(callId, { error: "No Discord speaker context available" });
      return;
    }
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
      await this.submitTerminalRealtimeToolResult(callId, session, CANCELLED_CONSULT_RESULT);
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
    const result = await this.trackAgentProxyConsult(
      recent,
      this.runAgentTurn({ context, message: consultMessage }),
    );
    if (providerEpoch !== this.params.providerEpoch()) {
      return;
    }
    if ("text" in result) {
      logger.info(
        `discord voice: realtime consult answer (${result.text.length} chars) voiceSession=${this.params.entry.voiceSessionKey} supervisorSession=${this.params.entry.route.sessionKey} agent=${this.params.entry.route.agentId} speaker=${context.speakerLabel} owner=${context.senderIsOwner}: ${formatVoiceLogPreview(result.text)}`,
      );
    } else if ("error" in result) {
      logger.warn(`discord voice: realtime consult failed call=${callId}: ${result.error}`);
    }
    await this.submitAgentProxyConsultResult(callId, session, result);
  }

  async handleAcceptedTranscript(
    acceptedText: string,
    forcedSpeakerContext: DiscordRealtimeSpeakerContext | undefined,
    providerEpoch: number,
  ): Promise<void> {
    const usesRealtimeAgentHandoff = this.params.usesRealtimeAgentHandoff();
    const usesFallbackTalkback = this.params.isAgentProxy && !usesRealtimeAgentHandoff;
    // Claim fallback talkback context before active-run control awaits. Concurrent
    // final transcripts can otherwise resume out of order and swap owner flags.
    const fallbackSpeakerContext = usesFallbackTalkback
      ? (forcedSpeakerContext ?? this.params.turns.consumePendingSpeakerContext())
      : undefined;
    const pendingForcedConsult =
      this.params.isAgentProxy && usesRealtimeAgentHandoff
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
    if (usesRealtimeAgentHandoff) {
      if (pendingForcedConsult) {
        this.schedulePreparedForcedAgentProxyConsult(pendingForcedConsult);
      }
      return;
    }
    this.talkback.enqueue(acceptedText, fallbackSpeakerContext);
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
    const context = speakerContext ?? this.params.turns.consumePendingSpeakerContext();
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
    const result = await this.trackAgentProxyConsult(
      pending,
      this.runAgentTurn({ context, message: question }),
    );
    const deliveries = this.providerDeliveries.get(state);
    await Promise.all(Array.from(deliveries ?? [], (delivery) => delivery.promise));
    if (state.providerEpoch !== this.params.providerEpoch() || "status" in result) {
      return;
    }
    if ("text" in result) {
      logger.info(
        `discord voice: realtime forced agent consult answer (${result.text.length} chars) elapsedMs=${Date.now() - startedAt} voiceSession=${this.params.entry.voiceSessionKey} supervisorSession=${this.params.entry.route.sessionKey} agent=${this.params.entry.route.agentId}: ${formatVoiceLogPreview(result.text)}`,
      );
    } else {
      logger.warn(
        `discord voice: realtime forced agent consult failed elapsedMs=${Date.now() - startedAt}: ${result.error}`,
      );
    }
    const text = "text" in result ? result.text : DISCORD_REALTIME_FALLBACK_TEXT;
    if (text.trim() && state.handledByForcedPlayback) {
      this.params.playback.enqueueExactSpeechMessage(text);
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

  private trackAgentProxyConsult(
    recent: AgentProxyConsultHandle | undefined,
    promise: Promise<string>,
  ): Promise<AgentProxyConsultResult> {
    const state = recent?.context;
    if (recent) {
      this.params.harness.forcedConsults.markStarted(recent);
    }
    const tracked = promise
      .then((text) => ({ text }), buildRealtimeVoiceAgentErrorProviderResult)
      .then((result) => {
        if (recent && state && state.providerEpoch === this.params.providerEpoch()) {
          state.result = result;
          // Cancellation must reach the coordinator before delivery closes that transition.
          if ("status" in result) {
            this.params.harness.forcedConsults.markCancelled(recent);
          } else {
            this.params.harness.forcedConsults.markDelivered(recent);
          }
        }
        return result;
      });
    if (state) {
      state.promise = tracked;
    }
    return tracked;
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
    const pendingResult = state.result ?? state.promise;
    if (!pendingResult) {
      return false;
    }
    const providerDelivery =
      state.handledByForcedPlayback &&
      !state.result &&
      session.bridge.supportsToolResultSuppression === false
        ? createDeferred<void>()
        : undefined;
    if (providerDelivery) {
      // Keep every native attempt until settlement: one failed joiner cannot hand
      // playback back while another may still accept the answer.
      const deliveries =
        this.providerDeliveries.get(state) ?? new Set<AgentProxyProviderDelivery>();
      deliveries.add(providerDelivery);
      this.providerDeliveries.set(state, deliveries);
    }
    logger.info(
      `discord voice: realtime consult ${state.result ? "reused recent" : "joined in-flight"} agent result call=${callId} speaker=${state.speaker.speakerLabel} owner=${state.speaker.senderIsOwner}`,
    );
    try {
      const result = await pendingResult;
      if (state.providerEpoch !== this.params.providerEpoch()) {
        return true;
      }
      await this.submitAgentProxyConsultResult(
        callId,
        session,
        result,
        Boolean(state.handledByForcedPlayback && !providerDelivery),
      );
      if (providerDelivery && state.providerEpoch === this.params.providerEpoch()) {
        state.handledByForcedPlayback = false;
      }
    } finally {
      if (providerDelivery) {
        providerDelivery.resolve();
        const deliveries = this.providerDeliveries.get(state);
        deliveries?.delete(providerDelivery);
        if (deliveries?.size === 0) {
          this.providerDeliveries.delete(state);
        }
      }
    }
    return true;
  }

  private async submitAgentProxyConsultResult(
    callId: string,
    session: RealtimeVoiceBridgeSession,
    result: AgentProxyConsultResult,
    alreadyDelivered = false,
  ): Promise<void> {
    if ("status" in result) {
      await this.submitTerminalRealtimeToolResult(callId, session, CANCELLED_CONSULT_RESULT);
    } else if (alreadyDelivered) {
      await this.submitTerminalRealtimeToolResult(callId, session, {
        status: "already_delivered",
        message: "OpenClaw already delivered this answer to Discord voice. Do not repeat it.",
      });
    } else {
      await session.submitToolResult(callId, result);
    }
  }

  private clearProviderConsultState(): void {
    for (const [state, deliveries] of this.providerDeliveries) {
      state.handledByForcedPlayback = false;
      for (const delivery of deliveries) {
        delivery.resolve();
      }
    }
    this.providerDeliveries.clear();
    this.params.harness.forcedConsults.clear();
  }
}
