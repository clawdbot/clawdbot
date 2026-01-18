import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifySlackSignature } from "./signature.js";

type SignatureFixture = {
  timestamp: string;
  body: string;
  signingSecret: string;
};

const makeSignature = ({ timestamp, body, signingSecret }: SignatureFixture) => {
  const baseString = `v0:${timestamp}:${body}`;
  const digest = createHmac("sha256", signingSecret)
    .update(baseString)
    .digest("hex");
  return `v0=${digest}`;
};

describe("verifySlackSignature", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a valid signature with the correct HMAC", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const fixture = {
      timestamp: String(nowSeconds),
      body: "token=abc123&team_id=T123456&event=%7B%22type%22%3A%22message%22%7D",
      signingSecret: "whispered-secret",
    };
    const signature = makeSignature(fixture);

    const result = verifySlackSignature({ ...fixture, signature });

    expect(result).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const fixture = {
      timestamp: String(nowSeconds),
      body: "token=abc123&team_id=T123456&event=%7B%22type%22%3A%22app_mention%22%7D",
      signingSecret: "whispered-secret",
    };
    const signature = makeSignature(fixture);
    const invalidSignature =
      signature.slice(0, -1) + (signature.endsWith("0") ? "1" : "0");

    const result = verifySlackSignature({
      ...fixture,
      signature: invalidSignature,
    });

    expect(result).toBe(false);
  });

  it("rejects an expired timestamp older than 5 minutes", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const fixture = {
      timestamp: String(nowSeconds - 301),
      body: "token=abc123&team_id=T123456&event=%7B%22type%22%3A%22url_verification%22%7D",
      signingSecret: "whispered-secret",
    };
    const signature = makeSignature(fixture);

    const result = verifySlackSignature({ ...fixture, signature });

    expect(result).toBe(false);
  });

  it("handles edge cases like missing params and malformed data", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const validFixture = {
      timestamp: String(nowSeconds),
      body: "token=abc123&team_id=T123456&event=%7B%22type%22%3A%22reaction_added%22%7D",
      signingSecret: "whispered-secret",
    };
    const validSignature = makeSignature(validFixture);

    const cases = [
      {
        signature: "",
        timestamp: validFixture.timestamp,
        body: validFixture.body,
        signingSecret: validFixture.signingSecret,
      },
      {
        signature: validSignature,
        timestamp: "",
        body: validFixture.body,
        signingSecret: validFixture.signingSecret,
      },
      {
        signature: validSignature,
        timestamp: "not-a-number",
        body: validFixture.body,
        signingSecret: validFixture.signingSecret,
      },
      {
        signature: "v0=short",
        timestamp: validFixture.timestamp,
        body: "",
        signingSecret: validFixture.signingSecret,
      },
    ];

    for (const testCase of cases) {
      expect(verifySlackSignature(testCase)).toBe(false);
    }
  });
});
