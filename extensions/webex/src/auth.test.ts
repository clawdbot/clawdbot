/**
 * Webex authentication tests
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  extractBotIdFromToken,
  getWebexAuthHeader,
  parseWebexBotToken,
  verifyWebexWebhookSignature,
} from "./auth.js";

describe("verifyWebexWebhookSignature", () => {
  const secret = "test-webhook-secret";

  it("should verify valid signature with computed HMAC", () => {
    const body = '{"id":"test","resource":"messages"}';
    // Compute the actual expected signature
    const expectedSignature = createHmac("sha1", secret).update(body).digest("hex");

    expect(verifyWebexWebhookSignature(body, expectedSignature, secret)).toBe(true);
  });

  it("should verify signature with Buffer body", () => {
    const bodyStr = '{"id":"test","resource":"messages"}';
    const body = Buffer.from(bodyStr, "utf8");
    const expectedSignature = createHmac("sha1", secret).update(body).digest("hex");

    expect(verifyWebexWebhookSignature(body, expectedSignature, secret)).toBe(true);
  });

  it("should reject missing signature", () => {
    const body = '{"id":"test"}';
    expect(verifyWebexWebhookSignature(body, undefined, secret)).toBe(false);
  });

  it("should reject empty signature", () => {
    const body = '{"id":"test"}';
    expect(verifyWebexWebhookSignature(body, "", secret)).toBe(false);
  });

  it("should reject wrong length signature", () => {
    const body = '{"id":"test"}';
    expect(verifyWebexWebhookSignature(body, "tooshort", secret)).toBe(false);
  });

  it("should reject incorrect signature (timing-safe)", () => {
    const body = '{"id":"test"}';
    // SHA1 produces 40 hex chars
    const wrongSignature = "0".repeat(40);
    expect(verifyWebexWebhookSignature(body, wrongSignature, secret)).toBe(false);
  });

  it("should reject signature with wrong secret", () => {
    const body = '{"id":"test"}';
    const signatureWithWrongSecret = createHmac("sha1", "wrong-secret").update(body).digest("hex");
    expect(verifyWebexWebhookSignature(body, signatureWithWrongSecret, secret)).toBe(false);
  });

  it("should reject signature for modified body", () => {
    const originalBody = '{"id":"test"}';
    const signature = createHmac("sha1", secret).update(originalBody).digest("hex");
    const modifiedBody = '{"id":"modified"}';
    expect(verifyWebexWebhookSignature(modifiedBody, signature, secret)).toBe(false);
  });
});

describe("parseWebexBotToken", () => {
  it("should reject undefined token", () => {
    const result = parseWebexBotToken(undefined);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("No token provided");
  });

  it("should reject empty string token", () => {
    const result = parseWebexBotToken("");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("No token provided");
  });

  it("should reject whitespace-only token", () => {
    const result = parseWebexBotToken("   ");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Empty token");
  });

  it("should reject short token", () => {
    const result = parseWebexBotToken("shorttoken");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Token appears too short");
  });

  it("should accept valid length token as unknown type", () => {
    const longToken = "a".repeat(100);
    const result = parseWebexBotToken(longToken);
    expect(result.valid).toBe(true);
    expect(result.token).toBe(longToken);
    expect(result.type).toBe("unknown");
  });

  it("should detect bot token type from decoded content", () => {
    // Create a base64 token that contains "bot" and is long enough (50+ chars)
    const tokenContent = JSON.stringify({
      type: "bot",
      id: "test-bot-id-that-is-long-enough-to-pass-validation",
    });
    const token = Buffer.from(tokenContent).toString("base64");
    const result = parseWebexBotToken(token);
    expect(result.valid).toBe(true);
    expect(result.type).toBe("bot");
  });

  it("should detect integration token type", () => {
    const tokenContent = JSON.stringify({
      type: "integration",
      id: "test-integration-id-that-is-long-enough-to-pass-validation",
    });
    const token = Buffer.from(tokenContent).toString("base64");
    const result = parseWebexBotToken(token);
    expect(result.valid).toBe(true);
    expect(result.type).toBe("integration");
  });

  it("should detect guest token type", () => {
    const tokenContent = JSON.stringify({
      type: "guest",
      id: "test-guest-id-that-is-long-enough-to-pass-minimum-validation",
    });
    const token = Buffer.from(tokenContent).toString("base64");
    const result = parseWebexBotToken(token);
    expect(result.valid).toBe(true);
    expect(result.type).toBe("guest");
  });

  it("should trim whitespace from token", () => {
    const longToken = "a".repeat(100);
    const result = parseWebexBotToken(`  ${longToken}  `);
    expect(result.valid).toBe(true);
    expect(result.token).toBe(longToken);
  });

  it("should handle non-base64 token gracefully", () => {
    // Create a long token that's not valid base64
    const invalidBase64Token = "!" + "a".repeat(99);
    const result = parseWebexBotToken(invalidBase64Token);
    // Should still accept it as unknown type since it's long enough
    expect(result.valid).toBe(true);
    expect(result.type).toBe("unknown");
  });
});

describe("extractBotIdFromToken", () => {
  it("should extract machineAccountUuid from token", () => {
    const tokenContent = JSON.stringify({ machineAccountUuid: "test-machine-id-123" });
    const token = Buffer.from(tokenContent).toString("base64");
    const result = extractBotIdFromToken(token);
    expect(result).toBe("test-machine-id-123");
  });

  it("should extract id from token when no machineAccountUuid", () => {
    const tokenContent = JSON.stringify({ id: "test-bot-id-456" });
    const token = Buffer.from(tokenContent).toString("base64");
    const result = extractBotIdFromToken(token);
    expect(result).toBe("test-bot-id-456");
  });

  it("should prefer machineAccountUuid over id", () => {
    const tokenContent = JSON.stringify({
      machineAccountUuid: "machine-id",
      id: "regular-id",
    });
    const token = Buffer.from(tokenContent).toString("base64");
    const result = extractBotIdFromToken(token);
    expect(result).toBe("machine-id");
  });

  it("should return undefined for token without id fields", () => {
    const tokenContent = JSON.stringify({ type: "bot", name: "test" });
    const token = Buffer.from(tokenContent).toString("base64");
    const result = extractBotIdFromToken(token);
    expect(result).toBeUndefined();
  });

  it("should return undefined for invalid base64", () => {
    const result = extractBotIdFromToken("!!!invalid!!!");
    expect(result).toBeUndefined();
  });

  it("should return undefined for empty token", () => {
    const result = extractBotIdFromToken("");
    expect(result).toBeUndefined();
  });
});

describe("getWebexAuthHeader", () => {
  it("should return Bearer token format", () => {
    const token = "test-bot-token-123";
    const result = getWebexAuthHeader(token);
    expect(result).toBe("Bearer test-bot-token-123");
  });

  it("should handle empty token", () => {
    const result = getWebexAuthHeader("");
    expect(result).toBe("Bearer ");
  });

  it("should preserve token whitespace", () => {
    const result = getWebexAuthHeader("  token  ");
    expect(result).toBe("Bearer   token  ");
  });
});
