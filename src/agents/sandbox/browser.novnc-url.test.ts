// noVNC auth tests cover observer URL construction, one-time tokens, and
// password generation for sandbox browser viewing.
import { describe, expect, it } from "vitest";
import {
  buildNoVncObserverTokenUrl,
  consumeNoVncObserverToken,
  generateNoVncPassword,
  issueNoVncObserverToken,
} from "./novnc-auth.js";

describe("noVNC auth helpers", () => {
  it("issues one-time short-lived observer tokens", () => {
    // Observer tokens are bearer access to a browser session, so consumption is
    // one-shot and bounded by a short TTL.
    const token = issueNoVncObserverToken({
      noVncPort: 50123,
      password: "abcd1234", // pragma: allowlist secret
      nowMs: 1000,
      ttlMs: 100,
    });
    expect(buildNoVncObserverTokenUrl("http://127.0.0.1:19999", token)).toBe(
      `http://127.0.0.1:19999/sandbox/novnc?token=${token}`,
    );
    expect(consumeNoVncObserverToken(token, 1050)).toEqual({
      noVncPort: 50123,
      password: "abcd1234", // pragma: allowlist secret
    });
    expect(consumeNoVncObserverToken(token, 1050)).toBeNull();
  });

  it("expires observer tokens", () => {
    const token = issueNoVncObserverToken({
      noVncPort: 50123,
      password: "abcd1234", // pragma: allowlist secret
      nowMs: 1000,
      ttlMs: 100,
    });
    expect(consumeNoVncObserverToken(token, 1200)).toBeNull();
  });

  it("uses the default ttl when observer token ttlMs is non-finite", () => {
    const liveToken = issueNoVncObserverToken({
      noVncPort: 50123,
      password: "abcd1234", // pragma: allowlist secret
      nowMs: 1000,
      ttlMs: Number.NaN,
    });
    const expiredToken = issueNoVncObserverToken({
      noVncPort: 50123,
      password: "abcd1234", // pragma: allowlist secret
      nowMs: 1000,
      ttlMs: Number.NaN,
    });

    expect(consumeNoVncObserverToken(liveToken, 60_999)).toEqual({
      noVncPort: 50123,
      password: "abcd1234", // pragma: allowlist secret
    });
    expect(consumeNoVncObserverToken(expiredToken, 61_001)).toBeNull();
  });

  it("uses the default ttl when observer token ttlMs is unsafe or too large", () => {
    const unsafeToken = issueNoVncObserverToken({
      noVncPort: 50123,
      password: "abcd1234", // pragma: allowlist secret
      nowMs: 1000,
      ttlMs: Number.MAX_SAFE_INTEGER,
    });
    const tooLargeToken = issueNoVncObserverToken({
      noVncPort: 50123,
      password: "abcd1234", // pragma: allowlist secret
      nowMs: 1000,
      ttlMs: 60_001,
    });

    expect(consumeNoVncObserverToken(unsafeToken, 61_001)).toBeNull();
    expect(consumeNoVncObserverToken(tooLargeToken, 61_001)).toBeNull();
  });

  it("does not issue usable observer tokens when the issue time is invalid", () => {
    const token = issueNoVncObserverToken({
      noVncPort: 50123,
      password: "abcd1234", // pragma: allowlist secret
      nowMs: Number.NaN,
      ttlMs: 100,
    });

    expect(consumeNoVncObserverToken(token, 1050)).toBeNull();
  });

  it("generates 8-char alphanumeric passwords", () => {
    const password = generateNoVncPassword();
    expect(password).toMatch(/^[a-zA-Z0-9]{8}$/);
  });
});
