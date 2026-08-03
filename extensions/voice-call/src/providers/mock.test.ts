// Voice Call tests cover mock plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebhookContext } from "../types.js";
import { MockProvider } from "./mock.js";

function createWebhookContext(rawBody: string): WebhookContext {
  return {
    headers: {},
    rawBody,
    url: "http://localhost/voice/webhook",
    method: "POST",
    query: {},
  };
}

describe("MockProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("derives stable request keys and detects replays", () => {
    const provider = new MockProvider();
    const repeated = createWebhookContext(
      JSON.stringify({ event: { type: "call.answered", callId: "c1" } }),
    );
    const distinct = createWebhookContext(
      JSON.stringify({ event: { type: "call.ended", callId: "c2" } }),
    );

    const first = provider.verifyWebhook(repeated);
    const second = provider.verifyWebhook(repeated);
    const other = provider.verifyWebhook(distinct);

    expect(first).toMatchObject({ ok: true, isReplay: false });
    expect(first.verifiedRequestKey).toMatch(/^mock:/);
    expect(second.verifiedRequestKey).toBe(first.verifiedRequestKey);
    expect(second.isReplay).toBe(true);
    expect(other.isReplay).toBe(false);
    expect(other.verifiedRequestKey).not.toBe(first.verifiedRequestKey);
  });

  it("expires replay keys after the mock replay window elapses", () => {
    vi.useFakeTimers();
    const provider = new MockProvider();
    const ctx = createWebhookContext(
      JSON.stringify({ event: { type: "call.answered", callId: "call-expire" } }),
    );

    const first = provider.verifyWebhook(ctx);
    vi.advanceTimersByTime(5 * 60 * 1000);
    const beforeExpiry = provider.verifyWebhook(ctx);
    vi.advanceTimersByTime(6 * 60 * 1000);
    const afterExpiry = provider.verifyWebhook(ctx);

    expect(first.isReplay).toBe(false);
    expect(beforeExpiry.isReplay).toBe(true);
    expect(afterExpiry.isReplay).toBe(false);
    expect(afterExpiry.verifiedRequestKey).toBe(first.verifiedRequestKey);
  });

  it("preserves explicit falsy event values", () => {
    const provider = new MockProvider();
    const beforeParse = Date.now();
    const result = provider.parseWebhookEvent(
      createWebhookContext(
        JSON.stringify({
          events: [
            {
              id: "evt-error",
              type: "call.error",
              callId: "call-1",
              timestamp: 0,
              error: "",
              retryable: false,
            },
            {
              id: "evt-ended",
              type: "call.ended",
              callId: "call-2",
              reason: "",
            },
            {
              id: "evt-speech",
              type: "call.speech",
              callId: "call-3",
              transcript: "",
              isFinal: false,
            },
            {
              id: "evt-assistant-speech",
              type: "call.assistant-speech",
              callId: "call-4",
              transcript: "",
            },
          ],
        }),
      ),
    );
    const afterParse = Date.now();
    const endedTimestamp = result.events[1]?.timestamp;
    const speechTimestamp = result.events[2]?.timestamp;

    expect(result.events).toEqual([
      {
        id: "evt-error",
        type: "call.error",
        callId: "call-1",
        providerCallId: undefined,
        timestamp: 0,
        error: "",
        retryable: false,
      },
      {
        id: "evt-ended",
        type: "call.ended",
        callId: "call-2",
        providerCallId: undefined,
        timestamp: endedTimestamp,
        reason: "",
      },
      {
        id: "evt-speech",
        type: "call.speech",
        callId: "call-3",
        providerCallId: undefined,
        timestamp: speechTimestamp,
        transcript: "",
        isFinal: false,
        confidence: undefined,
      },
      {
        id: "evt-assistant-speech",
        type: "call.assistant-speech",
        callId: "call-4",
        providerCallId: undefined,
        timestamp: expect.any(Number),
        transcript: "",
      },
    ]);
    expect(endedTimestamp).toBeGreaterThanOrEqual(beforeParse);
    expect(endedTimestamp).toBeLessThanOrEqual(afterParse);
    expect(speechTimestamp).toBeGreaterThanOrEqual(beforeParse);
    expect(speechTimestamp).toBeLessThanOrEqual(afterParse);
  });
});
