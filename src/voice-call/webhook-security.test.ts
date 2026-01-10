import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  reconstructWebhookUrl,
  validateTwilioSignature,
  verifyTwilioWebhook,
} from "./webhook-security.js";

describe("validateTwilioSignature", () => {
  const authToken = "test-auth-token-123";

  // Helper to compute a valid signature
  function computeSignature(
    token: string,
    url: string,
    params: URLSearchParams,
  ): string {
    let dataToSign = url;
    const sortedParams = Array.from(params.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [key, value] of sortedParams) {
      dataToSign += key + value;
    }
    return crypto.createHmac("sha1", token).update(dataToSign).digest("base64");
  }

  it("validates a correct signature", () => {
    const url = "https://example.com/voice/webhook";
    const params = new URLSearchParams({
      CallSid: "CA123",
      From: "+15551234567",
      To: "+15559876543",
    });
    const signature = computeSignature(authToken, url, params);

    expect(validateTwilioSignature(authToken, signature, url, params)).toBe(
      true,
    );
  });

  it("rejects an incorrect signature", () => {
    const url = "https://example.com/voice/webhook";
    const params = new URLSearchParams({ CallSid: "CA123" });
    const wrongSignature = "invalid-signature-base64==";

    expect(
      validateTwilioSignature(authToken, wrongSignature, url, params),
    ).toBe(false);
  });

  it("rejects when signature is undefined", () => {
    const url = "https://example.com/voice/webhook";
    const params = new URLSearchParams();

    expect(validateTwilioSignature(authToken, undefined, url, params)).toBe(
      false,
    );
  });

  it("handles empty params", () => {
    const url = "https://example.com/voice/webhook";
    const params = new URLSearchParams();
    const signature = computeSignature(authToken, url, params);

    expect(validateTwilioSignature(authToken, signature, url, params)).toBe(
      true,
    );
  });

  it("is sensitive to param order (internally sorted)", () => {
    const url = "https://example.com/voice/webhook";
    const params1 = new URLSearchParams();
    params1.append("Zebra", "1");
    params1.append("Alpha", "2");

    const params2 = new URLSearchParams();
    params2.append("Alpha", "2");
    params2.append("Zebra", "1");

    // Both should produce the same signature since params are sorted internally
    const sig1 = computeSignature(authToken, url, params1);
    const sig2 = computeSignature(authToken, url, params2);

    expect(sig1).toBe(sig2);
  });
});

describe("reconstructWebhookUrl", () => {
  it("uses forwarded headers when present", () => {
    const ctx = {
      url: "http://localhost:3334/voice/webhook",
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "example.ngrok.io",
        host: "localhost:3334",
      },
      rawBody: "",
    };

    expect(reconstructWebhookUrl(ctx)).toBe(
      "https://example.ngrok.io/voice/webhook",
    );
  });

  it("falls back to host header", () => {
    const ctx = {
      url: "http://localhost:3334/voice/webhook?param=value",
      headers: {
        host: "localhost:3334",
      },
      rawBody: "",
    };

    expect(reconstructWebhookUrl(ctx)).toBe(
      "https://localhost/voice/webhook?param=value",
    );
  });

  it("uses ngrok-forwarded-host header", () => {
    const ctx = {
      url: "http://localhost:3334/voice/webhook",
      headers: {
        "ngrok-forwarded-host": "abc123.ngrok-free.app",
        host: "localhost:3334",
      },
      rawBody: "",
    };

    expect(reconstructWebhookUrl(ctx)).toBe(
      "https://abc123.ngrok-free.app/voice/webhook",
    );
  });

  it("strips port from host", () => {
    const ctx = {
      url: "http://localhost:3334/voice/webhook",
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "example.com:443",
      },
      rawBody: "",
    };

    expect(reconstructWebhookUrl(ctx)).toBe(
      "https://example.com/voice/webhook",
    );
  });

  it("handles array header values", () => {
    const ctx = {
      url: "http://localhost:3334/voice/webhook",
      headers: {
        "x-forwarded-proto": ["https", "http"],
        "x-forwarded-host": ["example.com", "fallback.com"],
      },
      rawBody: "",
    };

    expect(reconstructWebhookUrl(ctx)).toBe(
      "https://example.com/voice/webhook",
    );
  });
});

describe("verifyTwilioWebhook", () => {
  const authToken = "test-auth-token-123";

  function computeSignature(
    token: string,
    url: string,
    params: URLSearchParams,
  ): string {
    let dataToSign = url;
    const sortedParams = Array.from(params.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [key, value] of sortedParams) {
      dataToSign += key + value;
    }
    return crypto.createHmac("sha1", token).update(dataToSign).digest("base64");
  }

  it("accepts valid webhook with correct signature", () => {
    const url = "https://example.com/voice/webhook";
    const body = "CallSid=CA123&From=%2B15551234567";
    const params = new URLSearchParams(body);
    const signature = computeSignature(authToken, url, params);

    const ctx = {
      url: "http://localhost:3334/voice/webhook",
      headers: {
        "x-twilio-signature": signature,
        "x-forwarded-proto": "https",
        "x-forwarded-host": "example.com",
      },
      rawBody: body,
    };

    const result = verifyTwilioWebhook(ctx, authToken);
    expect(result.ok).toBe(true);
  });

  it("rejects webhook without signature header", () => {
    const ctx = {
      url: "http://localhost:3334/voice/webhook",
      headers: {},
      rawBody: "CallSid=CA123",
    };

    const result = verifyTwilioWebhook(ctx, authToken);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Missing X-Twilio-Signature header");
  });

  it("skips verification when skipVerification is true", () => {
    const ctx = {
      url: "http://localhost:3334/voice/webhook",
      headers: {},
      rawBody: "CallSid=CA123",
    };

    const result = verifyTwilioWebhook(ctx, authToken, {
      skipVerification: true,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("verification skipped (dev mode)");
  });

  it("uses publicUrl override for verification", () => {
    const publicUrl = "https://custom.example.com/voice/webhook";
    const body = "CallSid=CA123";
    const params = new URLSearchParams(body);
    const signature = computeSignature(authToken, publicUrl, params);

    const ctx = {
      url: "http://localhost:3334/voice/webhook",
      headers: {
        "x-twilio-signature": signature,
        // No forwarding headers - would fail without publicUrl override
      },
      rawBody: body,
    };

    const result = verifyTwilioWebhook(ctx, authToken, { publicUrl });
    expect(result.ok).toBe(true);
  });

  it("allows ngrok free tier with compatibility mode", () => {
    const ctx = {
      url: "http://localhost:3334/voice/webhook",
      headers: {
        "x-twilio-signature": "wrong-signature",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "abc123.ngrok-free.app",
      },
      rawBody: "CallSid=CA123",
    };

    const result = verifyTwilioWebhook(ctx, authToken, {
      allowNgrokFreeTier: true,
    });
    expect(result.ok).toBe(true);
    expect(result.isNgrokFreeTier).toBe(true);
  });

  it("rejects ngrok free tier without compatibility mode", () => {
    const ctx = {
      url: "http://localhost:3334/voice/webhook",
      headers: {
        "x-twilio-signature": "wrong-signature",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "abc123.ngrok-free.app",
      },
      rawBody: "CallSid=CA123",
    };

    const result = verifyTwilioWebhook(ctx, authToken, {
      allowNgrokFreeTier: false,
    });
    expect(result.ok).toBe(false);
    expect(result.isNgrokFreeTier).toBe(true);
  });
});
