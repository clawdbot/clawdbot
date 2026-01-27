import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyPlivoWebhook, verifyTwilioWebhook } from "./webhook-security.js";

function canonicalizeBase64(input: string): string {
  return Buffer.from(input, "base64").toString("base64");
}

function plivoV2Signature(params: {
  authToken: string;
  urlNoQuery: string;
  nonce: string;
}): string {
  const digest = crypto
    .createHmac("sha256", params.authToken)
    .update(params.urlNoQuery + params.nonce)
    .digest("base64");
  return canonicalizeBase64(digest);
}

function plivoV3Signature(params: {
  authToken: string;
  urlWithQuery: string;
  postBody: string;
  nonce: string;
}): string {
  const u = new URL(params.urlWithQuery);
  const baseNoQuery = `${u.protocol}//${u.host}${u.pathname}`;
  const queryPairs: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams.entries()) queryPairs.push([k, v]);

  const queryMap = new Map<string, string[]>();
  for (const [k, v] of queryPairs) {
    queryMap.set(k, (queryMap.get(k) ?? []).concat(v));
  }

  const sortedQuery = Array.from(queryMap.keys())
    .sort()
    .flatMap((k) =>
      [...(queryMap.get(k) ?? [])].sort().map((v) => `${k}=${v}`),
    )
    .join("&");

  const postParams = new URLSearchParams(params.postBody);
  const postMap = new Map<string, string[]>();
  for (const [k, v] of postParams.entries()) {
    postMap.set(k, (postMap.get(k) ?? []).concat(v));
  }

  const sortedPost = Array.from(postMap.keys())
    .sort()
    .flatMap((k) => [...(postMap.get(k) ?? [])].sort().map((v) => `${k}${v}`))
    .join("");

  const hasPost = sortedPost.length > 0;
  let baseUrl = baseNoQuery;
  if (sortedQuery.length > 0 || hasPost) {
    baseUrl = `${baseNoQuery}?${sortedQuery}`;
  }
  if (sortedQuery.length > 0 && hasPost) {
    baseUrl = `${baseUrl}.`;
  }
  baseUrl = `${baseUrl}${sortedPost}`;

  const digest = crypto
    .createHmac("sha256", params.authToken)
    .update(`${baseUrl}.${params.nonce}`)
    .digest("base64");
  return canonicalizeBase64(digest);
}

function twilioSignature(params: {
  authToken: string;
  url: string;
  postBody: string;
}): string {
  let dataToSign = params.url;
  const sortedParams = Array.from(
    new URLSearchParams(params.postBody).entries(),
  ).sort((a, b) => a[0].localeCompare(b[0]));

  for (const [key, value] of sortedParams) {
    dataToSign += key + value;
  }

  return crypto
    .createHmac("sha1", params.authToken)
    .update(dataToSign)
    .digest("base64");
}

describe("verifyPlivoWebhook", () => {
  it("accepts valid V2 signature", () => {
    const authToken = "test-auth-token";
    const nonce = "nonce-123";

    const ctxUrl = "http://local/voice/webhook?flow=answer&callId=abc";
    const verificationUrl = "https://example.com/voice/webhook";
    const signature = plivoV2Signature({
      authToken,
      urlNoQuery: verificationUrl,
      nonce,
    });

    const result = verifyPlivoWebhook(
      {
        headers: {
          host: "example.com",
          "x-forwarded-proto": "https",
          "x-plivo-signature-v2": signature,
          "x-plivo-signature-v2-nonce": nonce,
        },
        rawBody: "CallUUID=uuid&CallStatus=in-progress",
        url: ctxUrl,
        method: "POST",
        query: { flow: "answer", callId: "abc" },
      },
      authToken,
    );

    expect(result.ok).toBe(true);
    expect(result.version).toBe("v2");
  });

  it("accepts valid V3 signature (including multi-signature header)", () => {
    const authToken = "test-auth-token";
    const nonce = "nonce-456";

    const urlWithQuery = "https://example.com/voice/webhook?flow=answer&callId=abc";
    const postBody = "CallUUID=uuid&CallStatus=in-progress&From=%2B15550000000";

    const good = plivoV3Signature({
      authToken,
      urlWithQuery,
      postBody,
      nonce,
    });

    const result = verifyPlivoWebhook(
      {
        headers: {
          host: "example.com",
          "x-forwarded-proto": "https",
          "x-plivo-signature-v3": `bad, ${good}`,
          "x-plivo-signature-v3-nonce": nonce,
        },
        rawBody: postBody,
        url: urlWithQuery,
        method: "POST",
        query: { flow: "answer", callId: "abc" },
      },
      authToken,
    );

    expect(result.ok).toBe(true);
    expect(result.version).toBe("v3");
  });

  it("rejects missing signatures", () => {
    const result = verifyPlivoWebhook(
      {
        headers: { host: "example.com", "x-forwarded-proto": "https" },
        rawBody: "",
        url: "https://example.com/voice/webhook",
        method: "POST",
      },
      "token",
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Missing Plivo signature headers/);
  });
});

describe("verifyTwilioWebhook", () => {
  it("uses request query when publicUrl omits it", () => {
    const authToken = "test-auth-token";
    const publicUrl = "https://example.com/voice/webhook";
    const urlWithQuery = `${publicUrl}?callId=abc`;
    const postBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";

    const signature = twilioSignature({
      authToken,
      url: urlWithQuery,
      postBody,
    });

    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "example.com",
          "x-forwarded-proto": "https",
          "x-twilio-signature": signature,
        },
        rawBody: postBody,
        url: "http://local/voice/webhook?callId=abc",
        method: "POST",
        query: { callId: "abc" },
      },
      authToken,
      { publicUrl },
    );

    expect(result.ok).toBe(true);
  });

  it("rejects invalid signatures even with ngrok free tier enabled", () => {
    const authToken = "test-auth-token";
    const postBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";

    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "127.0.0.1:3334",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "attacker.ngrok-free.app",
          "x-twilio-signature": "invalid",
        },
        rawBody: postBody,
        url: "http://127.0.0.1:3334/voice/webhook",
        method: "POST",
        remoteAddress: "203.0.113.10",
      },
      authToken,
      { allowNgrokFreeTierLoopbackBypass: true },
    );

    expect(result.ok).toBe(false);
    expect(result.isNgrokFreeTier).toBe(true);
    expect(result.reason).toMatch(/Invalid signature/);
  });

  it("allows invalid signatures for ngrok free tier only on loopback", () => {
    const authToken = "test-auth-token";
    const postBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";

    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "127.0.0.1:3334",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "local.ngrok-free.app",
          "x-twilio-signature": "invalid",
        },
        rawBody: postBody,
        url: "http://127.0.0.1:3334/voice/webhook",
        method: "POST",
        remoteAddress: "127.0.0.1",
      },
      authToken,
      { allowNgrokFreeTierLoopbackBypass: true },
    );

    expect(result.ok).toBe(true);
    expect(result.isNgrokFreeTier).toBe(true);
    expect(result.reason).toMatch(/compatibility mode/);
  });
});
