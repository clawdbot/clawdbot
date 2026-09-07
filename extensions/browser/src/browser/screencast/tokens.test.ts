import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screencastParams } from "./test-support.js";
import {
  clearBrowserScreencastTokens,
  consumeBrowserScreencastToken,
  mintBrowserScreencastToken,
} from "./tokens.js";

afterEach(() => {
  clearBrowserScreencastTokens();
  vi.useRealTimers();
});

describe("browser screencast tokens", () => {
  it("revokes unconsumed tokens when their requester leaves", () => {
    const requester = new AbortController();
    const token = mintBrowserScreencastToken(
      screencastParams({ requesterSignal: requester.signal }),
    );
    requester.abort();
    expect(consumeBrowserScreencastToken(token.token)).toBeUndefined();
    expect(getEventListeners(requester.signal, "abort")).toHaveLength(0);
  });

  it.each(["consume", "expire", "shutdown"])("releases the requester listener on %s", (end) => {
    vi.useFakeTimers();
    const requester = new AbortController();
    const params = screencastParams({ requesterSignal: requester.signal });
    const token = mintBrowserScreencastToken(params);
    expect(getEventListeners(requester.signal, "abort")).toHaveLength(1);
    if (end === "consume") {
      expect(consumeBrowserScreencastToken(token.token)).toBe(params);
    } else if (end === "expire") {
      vi.advanceTimersByTime(60_000);
    } else {
      clearBrowserScreencastTokens();
    }
    expect(getEventListeners(requester.signal, "abort")).toHaveLength(0);
    requester.abort();
    expect(consumeBrowserScreencastToken(token.token)).toBeUndefined();
  });

  it("mints a 48-hex token that can only be consumed once", () => {
    const params = screencastParams();
    const token = mintBrowserScreencastToken(params);
    expect(token.token).toMatch(/^[a-f0-9]{48}$/u);
    expect(consumeBrowserScreencastToken(token.token)).toBe(params);
    expect(consumeBrowserScreencastToken(token.token)).toBeUndefined();
  });

  it("expires at 60 seconds, including before the expiry timer runs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const token = mintBrowserScreencastToken(screencastParams());
    expect(token.expiresAtMs).toBe(61_000);
    vi.setSystemTime(token.expiresAtMs);
    expect(consumeBrowserScreencastToken(token.token)).toBeUndefined();
    const timed = mintBrowserScreencastToken(screencastParams());
    vi.advanceTimersByTime(60_000);
    expect(consumeBrowserScreencastToken(timed.token)).toBeUndefined();
  });

  it.each(["", "a".repeat(47), "g".repeat(48), "A".repeat(48), "a".repeat(49)])(
    "rejects malformed token %j",
    (token) => {
      expect(consumeBrowserScreencastToken(token)).toBeUndefined();
    },
  );
});
