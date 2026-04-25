import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { VoiceCallConfig } from "./config.js";
import type { CallManagerContext } from "./manager/context.js";
import { processEvent as processManagerEvent } from "./manager/events.js";
import { getCallByProviderCallId as getCallByProviderCallIdFromMaps } from "./manager/lookup.js";
import {
  continueCall as continueCallWithContext,
  endCall as endCallWithContext,
  initiateCall as initiateCallWithContext,
  sendDtmf as sendDtmfWithContext,
  speak as speakWithContext,
  speakInitialMessage as speakInitialMessageWithContext,
} from "./manager/outbound.js";
import {
  getCallHistoryFromStore,
  loadActiveCallsFromStore,
  persistCallRecord,
} from "./manager/store.js";
import { startMaxDurationTimer } from "./manager/timers.js";
import type { VoiceCallProvider } from "./providers/base.js";
import {
  TerminalStates,
  type CallId,
  type CallRecord,
  type NormalizedEvent,
  type OutboundCallOptions,
} from "./types.js";
import { resolveUserPath } from "./utils.js";

function markRestoredCallSkipped(call: CallRecord, endReason: "completed" | "timeout"): void {
  call.endedAt = Date.now();
  call.endReason = endReason;
  call.state = endReason;
}

function resolveDefaultStoreBase(config: VoiceCallConfig, storePath?: string): string {
  const rawOverride = storePath?.trim() || config.store?.trim();
  if (rawOverride) {
    return resolveUserPath(rawOverride);
  }
  const preferred = path.join(os.homedir(), ".openclaw", "voice-calls");
  const candidates = [preferred].map((dir) => resolveUserPath(dir));
  const existing =
    candidates.find((dir) => {
      try {
        return fs.existsSync(path.join(dir, "calls.jsonl")) || fs.existsSync(dir);
      } catch {
        return false;
      }
    }) ?? resolveUserPath(preferred);
  return existing;
}

/**
 * Manages voice calls: state ownership and delegation to manager helper modules.
 */
export class CallManager {
  private activeCalls = new Map<CallId, CallRecord>();
  private providerCallIdMap = new Map<string, CallId>();
  private processedEventIds = new Set<string>();
  private rejectedProviderCallIds = new Set<string>();
  private provider: VoiceCallProvider | null = null;
  private config: VoiceCallConfig;
  private storePath: string;
  private webhookUrl: string | null = null;
  private activeTurnCalls = new Set<CallId>();
  private transcriptWaiters = new Map<
    CallId,
    {
      resolve: (text: string) => void;
      reject: (err: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private maxDurationTimers = new Map<CallId, NodeJS.Timeout>();
  private initialMessageInFlight = new Set<CallId>();

  constructor(config: VoiceCallConfig, storePath?: string) {
    this.config = config;
    this.storePath = resolveDefaultStoreBase(config, storePath);
  }

  /**
   * Initialize the call manager with a provider.
   * Verifies persisted calls with the provider and restarts timers.
   */
  async initialize(provider: VoiceCallProvider, webhookUrl: string): Promise<void> {
    this.provider = provider;
    this.webhookUrl = webhookUrl;

    fs.mkdirSync(this.storePath, { recursive: true });

    const persisted = loadActiveCallsFromStore(this.storePath);
    this.processedEventIds = persisted.processedEventIds;
    this.rejectedProviderCallIds = persisted.rejectedProviderCallIds;

    const verified = await this.verifyRestoredCalls(provider, persisted.activeCalls);
    this.activeCalls = verified;

    // Rebuild providerCallIdMap from verified calls only
    this.providerCallIdMap = new Map();
    for (const [callId, call] of verified) {
      if (call.providerCallId) {
        this.providerCallIdMap.set(call.providerCallId, callId);
      }
    }

    // Restart max-duration timers for restored calls that are past the answered state
    for (const [callId, call] of verified) {
      if (call.answeredAt && !TerminalStates.has(call.state)) {
        const elapsed = Date.now() - call.answeredAt;
        const maxDurationMs = this.config.maxDurationSeconds * 1000;
        if (elapsed >= maxDurationMs) {
          // Already expired — remove instead of keeping
          verified.delete(callId);
          if (call.providerCallId) {
            this.providerCallIdMap.delete(call.providerCallId);
          }
          console.log(
            `[voice-call] Skipping restored call ${callId} (max duration already elapsed)`,
          );
          continue;
        }
        startMaxDurationTimer({
          ctx: this.getContext(),
          callId,
          timeoutMs: maxDurationMs - elapsed,
          onTimeout: async (id) => {
            await endCallWithContext(this.getContext(), id, { reason: "timeout" });
          },
        });
        console.log(`[voice-call] Restarted max-duration timer for restored call ${callId}`);
      }
    }

    if (verified.size > 0) {
      console.log(`[voice-call] Restored ${verified.size} active call(s) from store`);
    }
  }

  /**
   * Verify persisted calls with the provider before restoring.
   * Calls without providerCallId or older than maxDurationSeconds are skipped.
   * Transient provider errors keep the call (rely on timer fallback).
   */
  private async verifyRestoredCalls(
    provider: VoiceCallProvider,
    candidates: Map<CallId, CallRecord>,
  ): Promise<Map<CallId, CallRecord>> {
    if (candidates.size === 0) {
      return new Map();
    }

    const maxAgeMs = this.config.maxDurationSeconds * 1000;
    const now = Date.now();
    const verified = new Map<CallId, CallRecord>();
    const verifyTasks: Array<{ callId: CallId; call: CallRecord; promise: Promise<void> }> = [];

    for (const [callId, call] of candidates) {
      // Skip calls without a provider ID — can't verify
      if (!call.providerCallId) {
        console.log(`[voice-call] Skipping restored call ${callId} (no providerCallId)`);
        continue;
      }

      // Skip calls older than maxDurationSeconds (time-based fallback)
      if (now - call.startedAt > maxAgeMs) {
        console.log(
          `[voice-call] Skipping restored call ${callId} (older than maxDurationSeconds)`,
        );
        markRestoredCallSkipped(call, "timeout");
        persistCallRecord(this.storePath, call);
        await provider
          .hangupCall({
            callId,
            providerCallId: call.providerCallId,
            reason: "timeout",
          })
          .catch((err) => {
            console.warn(
              `[voice-call] Failed to hang up expired restored call ${callId}:`,
              err instanceof Error ? err.message : String(err),
            );
          });
        continue;
      }

      const task = {
        callId,
        call,
        promise: provider
          .getCallStatus({ providerCallId: call.providerCallId })
          .then((result) => {
            if (result.isTerminal) {
              console.log(
                `[voice-call] Skipping restored call ${callId} (provider status: ${result.status})`,
              );
              markRestoredCallSkipped(call, "completed");
              persistCallRecord(this.storePath, call);
            } else if (result.isUnknown) {
              console.log(
                `[voice-call] Keeping restored call ${callId} (provider status unknown, relying on timer)`,
              );
              verified.set(callId, call);
            } else {
              verified.set(callId, call);
            }
          })
          .catch(() => {
            // Verification failed entirely — keep the call, rely on timer
            console.log(
              `[voice-call] Keeping restored call ${callId} (verification failed, relying on timer)`,
            );
            verified.set(callId, call);
          }),
      };
      verifyTasks.push(task);
    }

    await Promise.allSettled(verifyTasks.map((t) => t.promise));
    return verified;
  }

  /**
   * Get the current provider.
   */
  getProvider(): VoiceCallProvider | null {
    return this.provider;
  }

  /**
   * Initiate an outbound call.
   */
  async initiateCall(
    to: string,
    sessionKey?: string,
    options?: OutboundCallOptions | string,
  ): Promise<{ callId: CallId; success: boolean; error?: string }> {
    return initiateCallWithContext(this.getContext(), to, sessionKey, options);
  }

  /**
   * Speak to user in an active call.
   */
  async speak(callId: CallId, text: string): Promise<{ success: boolean; error?: string }> {
    return speakWithContext(this.getContext(), callId, text);
  }

  /**
   * Send DTMF digits to an active call.
   */
  async sendDtmf(callId: CallId, digits: string): Promise<{ success: boolean; error?: string }> {
    return sendDtmfWithContext(this.getContext(), callId, digits);
  }

  /**
   * Speak the initial message for a call (called when media stream connects).
   */
  async speakInitialMessage(providerCallId: string): Promise<void> {
    return speakInitialMessageWithContext(this.getContext(), providerCallId);
  }

  /**
   * Continue call: speak prompt, then wait for user's final transcript.
   */
  async continueCall(
    callId: CallId,
    prompt: string,
  ): Promise<{ success: boolean; transcript?: string; error?: string }> {
    return continueCallWithContext(this.getContext(), callId, prompt);
  }

  /**
   * End an active call.
   */
  async endCall(callId: CallId): Promise<{ success: boolean; error?: string }> {
    return endCallWithContext(this.getContext(), callId);
  }

  private getContext(): CallManagerContext {
    return {
      activeCalls: this.activeCalls,
      providerCallIdMap: this.providerCallIdMap,
      processedEventIds: this.processedEventIds,
      rejectedProviderCallIds: this.rejectedProviderCallIds,
      provider: this.provider,
      config: this.config,
      storePath: this.storePath,
      webhookUrl: this.webhookUrl,
      activeTurnCalls: this.activeTurnCalls,
      transcriptWaiters: this.transcriptWaiters,
      maxDurationTimers: this.maxDurationTimers,
      initialMessageInFlight: this.initialMessageInFlight,
      onCallAnswered: (call) => {
        this.maybeSpeakInitialMessageOnAnswered(call);
      },
    };
  }

  /**
   * Process a webhook event.
   */
  processEvent(event: NormalizedEvent): void {
    processManagerEvent(this.getContext(), event);
  }

  private shouldDeferConversationInitialMessageUntilStreamConnect(): boolean {
    if (!this.provider || this.provider.name !== "twilio" || !this.config.streaming.enabled) {
      return false;
    }

    const streamAwareProvider = this.provider as VoiceCallProvider & {
      isConversationStreamConnectEnabled?: () => boolean;
    };
    if (typeof streamAwareProvider.isConversationStreamConnectEnabled !== "function") {
      return false;
    }

    return streamAwareProvider.isConversationStreamConnectEnabled();
  }

  private maybeSpeakInitialMessageOnAnswered(call: CallRecord): void {
    const initialMessage = normalizeOptionalString(call.metadata?.initialMessage) ?? "";

    if (!initialMessage) {
      return;
    }

    // Notify mode should speak as soon as the provider reports "answered".
    // Conversation mode should defer only when the Twilio stream-connect path
    // is actually available; otherwise speak immediately on answered.
    const mode = (call.metadata?.mode as string | undefined) ?? "conversation";
    if (mode === "conversation") {
      if (this.config.realtime.enabled) {
        return;
      }
      const shouldWaitForStreamConnect =
        this.shouldDeferConversationInitialMessageUntilStreamConnect();
      if (shouldWaitForStreamConnect) {
        return;
      }
    } else if (mode !== "notify") {
      return;
    }

    if (!this.provider || !call.providerCallId) {
      return;
    }

    void this.speakInitialMessage(call.providerCallId);
  }

  /**
   * Get an active call by ID.
   */
  getCall(callId: CallId): CallRecord | undefined {
    return this.activeCalls.get(callId);
  }

  /**
   * Get an active call by provider call ID (e.g., Twilio CallSid).
   */
  getCallByProviderCallId(providerCallId: string): CallRecord | undefined {
    return getCallByProviderCallIdFromMaps({
      activeCalls: this.activeCalls,
      providerCallIdMap: this.providerCallIdMap,
      providerCallId,
    });
  }

  /**
   * Get all active calls.
   */
  getActiveCalls(): CallRecord[] {
    return Array.from(this.activeCalls.values());
  }

  /**
   * Get call history (from persisted logs).
   */
  async getCallHistory(limit = 50): Promise<CallRecord[]> {
    return getCallHistoryFromStore(this.storePath, limit);
  }
}
