import { describe, it, expect } from "vitest";
import { verifyZoomWebhook, handleZoomChallenge } from "./webhook.js";

describe("verifyZoomWebhook", () => {
  const secret = "test-secret-token";

  it("returns true for valid signature", () => {
    const timestamp = "1234567890";
    const payload = '{"event":"bot_notification"}';
    // Pre-computed: v0:1234567890:{"event":"bot_notification"} with secret "test-secret-token"
    const crypto = require("node:crypto");
    const message = `v0:${timestamp}:${payload}`;
    const hash = crypto.createHmac("sha256", secret).update(message).digest("hex");
    const signature = `v0=${hash}`;

    const result = verifyZoomWebhook({ payload, signature, timestamp, secret });
    expect(result).toBe(true);
  });

  it("returns false for invalid signature", () => {
    const result = verifyZoomWebhook({
      payload: '{"event":"bot_notification"}',
      signature: "v0=invalid",
      timestamp: "1234567890",
      secret,
    });
    expect(result).toBe(false);
  });

  it("returns false for missing signature", () => {
    const result = verifyZoomWebhook({
      payload: '{"event":"bot_notification"}',
      signature: "",
      timestamp: "1234567890",
      secret,
    });
    expect(result).toBe(false);
  });

  it("returns false for missing timestamp", () => {
    const result = verifyZoomWebhook({
      payload: '{"event":"bot_notification"}',
      signature: "v0=abc",
      timestamp: "",
      secret,
    });
    expect(result).toBe(false);
  });

  it("returns false for missing secret", () => {
    const result = verifyZoomWebhook({
      payload: '{"event":"bot_notification"}',
      signature: "v0=abc",
      timestamp: "1234567890",
      secret: "",
    });
    expect(result).toBe(false);
  });
});

describe("handleZoomChallenge", () => {
  it("returns correct encrypted token", () => {
    const plainToken = "test-plain-token";
    const secret = "test-secret";

    const result = handleZoomChallenge({ plainToken, secret });

    expect(result.plainToken).toBe(plainToken);
    expect(result.encryptedToken).toBeDefined();
    expect(result.encryptedToken.length).toBe(64); // SHA256 hex is 64 chars

    // Verify it's deterministic
    const result2 = handleZoomChallenge({ plainToken, secret });
    expect(result2.encryptedToken).toBe(result.encryptedToken);
  });

  it("produces different tokens for different secrets", () => {
    const plainToken = "test-plain-token";

    const result1 = handleZoomChallenge({ plainToken, secret: "secret1" });
    const result2 = handleZoomChallenge({ plainToken, secret: "secret2" });

    expect(result1.encryptedToken).not.toBe(result2.encryptedToken);
  });
});
