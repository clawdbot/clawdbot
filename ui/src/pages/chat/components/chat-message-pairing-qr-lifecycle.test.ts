/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isChatMediaResourceCurrent,
  observeChatMediaResource,
  releaseChatMediaResourceSubscriber,
  schedulePairingQrExpiryRefresh,
} from "./chat-message-media.ts";

const subscribers = new Set<() => void>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
});

afterEach(() => {
  for (const subscriber of subscribers) {
    releaseChatMediaResourceSubscriber(subscriber);
  }
  subscribers.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function observeSubscriber(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return subscriber;
}

function pairingQrMessage(expiresAtMs: number): { content: Record<string, unknown>[] } {
  return {
    content: [
      {
        type: "openclaw_pairing_qr",
        image_url: "data:image/png;base64,cXJwbmc=",
        expiresAtMs,
      },
    ],
  };
}

describe("pairing QR expiry resource lifecycle", () => {
  it.each([
    { name: "ordinary messages", message: { content: [{ type: "text", text: "hello" }] } },
    {
      name: "expired pairing QR messages",
      message: () => pairingQrMessage(Date.now() - 1),
    },
  ])("does not subscribe or schedule expiry for $name", ({ message }) => {
    const messageKey = crypto.randomUUID();
    const refresh = observeSubscriber(vi.fn());
    const resolvedMessage = typeof message === "function" ? message() : message;

    schedulePairingQrExpiryRefresh(messageKey, resolvedMessage, refresh);

    expect(vi.getTimerCount()).toBe(0);
    expect(observeChatMediaResource<void>("pairing-qr", messageKey).subscribers.size).toBe(0);

    // Reattach the probe so normal subscriber cleanup also removes its resource.
    schedulePairingQrExpiryRefresh(messageKey, pairingQrMessage(Date.now() + 1_000), refresh);
  });

  it("removes the last subscription when a previously active QR loses its expiry", async () => {
    const messageKey = crypto.randomUUID();
    const refresh = observeSubscriber(vi.fn());

    schedulePairingQrExpiryRefresh(messageKey, pairingQrMessage(Date.now() + 1_000), refresh);
    const resource = observeChatMediaResource<void>("pairing-qr", messageKey);

    schedulePairingQrExpiryRefresh(messageKey, { content: [] }, refresh);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(isChatMediaResourceCurrent(resource)).toBe(false);
    expect(resource.subscribers.size).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the other split pane and unrelated media subscriptions alive", async () => {
    const messageKey = crypto.randomUUID();
    const first = observeSubscriber(vi.fn());
    const second = observeSubscriber(vi.fn());
    const message = pairingQrMessage(Date.now() + 1_000);
    const independentResource = observeChatMediaResource<void>(
      "assistant-attachment",
      crypto.randomUUID(),
      first,
    );

    schedulePairingQrExpiryRefresh(messageKey, message, first);
    schedulePairingQrExpiryRefresh(messageKey, message, second);
    schedulePairingQrExpiryRefresh(messageKey, { content: [] }, first);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(independentResource.subscribers.has(first)).toBe(true);
    expect(isChatMediaResourceCurrent(independentResource)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
