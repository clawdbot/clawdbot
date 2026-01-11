import crypto from "node:crypto";

import type {
  EndReason,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "../types.js";
import type { VoiceCallProvider } from "./base.js";

/**
 * Mock voice call provider for local testing.
 *
 * Events are driven via webhook POST with JSON body:
 * - { events: NormalizedEvent[] } for bulk events
 * - { event: NormalizedEvent } for single event
 */
export class MockProvider implements VoiceCallProvider {
  readonly name = "mock" as const;

  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    return { ok: true };
  }

  parseWebhookEvent(ctx: WebhookContext): ProviderWebhookParseResult {
    try {
      const payload = JSON.parse(ctx.rawBody);
      const events: NormalizedEvent[] = [];

      if (Array.isArray(payload.events)) {
        for (const evt of payload.events) {
          const normalized = this.normalizeEvent(evt);
          if (normalized) events.push(normalized);
        }
      } else if (payload.event) {
        const normalized = this.normalizeEvent(payload.event);
        if (normalized) events.push(normalized);
      }

      return { events, statusCode: 200 };
    } catch {
      return { events: [], statusCode: 400 };
    }
  }

  private normalizeEvent(
    evt: Partial<NormalizedEvent>,
  ): NormalizedEvent | null {
    if (!evt.type || !evt.callId) return null;

    const base = {
      id: evt.id || crypto.randomUUID(),
      callId: evt.callId,
      providerCallId: evt.providerCallId,
      timestamp: evt.timestamp || Date.now(),
    };

    switch (evt.type) {
      case "call.initiated":
      case "call.ringing":
      case "call.answered":
      case "call.active":
        return { ...base, type: evt.type };

      case "call.speaking": {
        const payload = evt as Partial<NormalizedEvent & { text?: string }>;
        return {
          ...base,
          type: evt.type,
          text: payload.text || "",
        };
      }

      case "call.speech": {
        const payload = evt as Partial<
          NormalizedEvent & {
            transcript?: string;
            isFinal?: boolean;
            confidence?: number;
          }
        >;
        return {
          ...base,
          type: evt.type,
          transcript: payload.transcript || "",
          isFinal: payload.isFinal ?? true,
          confidence: payload.confidence,
        };
      }

      case "call.silence": {
        const payload = evt as Partial<
          NormalizedEvent & { durationMs?: number }
        >;
        return {
          ...base,
          type: evt.type,
          durationMs: payload.durationMs || 0,
        };
      }

      case "call.dtmf": {
        const payload = evt as Partial<NormalizedEvent & { digits?: string }>;
        return {
          ...base,
          type: evt.type,
          digits: payload.digits || "",
        };
      }

      case "call.ended": {
        const payload = evt as Partial<
          NormalizedEvent & { reason?: EndReason }
        >;
        return {
          ...base,
          type: evt.type,
          reason: payload.reason || "completed",
        };
      }

      case "call.error": {
        const payload = evt as Partial<
          NormalizedEvent & { error?: string; retryable?: boolean }
        >;
        return {
          ...base,
          type: evt.type,
          error: payload.error || "unknown error",
          retryable: payload.retryable,
        };
      }

      default:
        return null;
    }
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    return {
      providerCallId: `mock-${input.callId}`,
      status: "initiated",
    };
  }

  async hangupCall(_input: HangupCallInput): Promise<void> {
    // No-op for mock
  }

  async playTts(_input: PlayTtsInput): Promise<void> {
    // No-op for mock
  }

  async startListening(_input: StartListeningInput): Promise<void> {
    // No-op for mock
  }

  async stopListening(_input: StopListeningInput): Promise<void> {
    // No-op for mock
  }
}
