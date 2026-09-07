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
