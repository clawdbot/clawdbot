import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WebhookContext } from "../types.js";
import { TelnyxProvider } from "./telnyx.js";

function createCtx(params?: Partial<WebhookContext>): WebhookContext {
  return {
    headers: {},
    rawBody: "{}",
    url: "http://localhost/voice/webhook",
    method: "POST",
    query: {},
    remoteAddress: "127.0.0.1",
    ...params,
  };
}

function decodeBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLen);
  return Buffer.from(padded, "base64");
}

function createSignedTelnyxCtx(params: {
  privateKey: crypto.KeyObject;
  rawBody: string;
}): WebhookContext {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signedPayload = `${timestamp}|${params.rawBody}`;
  const signature = crypto
    .sign(null, Buffer.from(signedPayload), params.privateKey)
    .toString("base64");

  return createCtx({
    rawBody: params.rawBody,
    headers: {
      "telnyx-signature-ed25519": signature,
      "telnyx-timestamp": timestamp,
    },
  });
}

function expectReplayVerification(
  results: Array<{ ok: boolean; isReplay?: boolean; verifiedRequestKey?: string }>,
) {
  expect(results.map((result) => result.ok)).toEqual([true, true]);
  expect(results.map((result) => Boolean(result.isReplay))).toEqual([false, true]);
  const firstResult = results[0];
  if (!firstResult?.verifiedRequestKey) {
    throw new Error("expected Telnyx verification to produce a request key");
  }
  const secondResult = results[1];
  if (!secondResult?.verifiedRequestKey) {
    throw new Error("expected replayed Telnyx verification to preserve the request key");
  }
  const firstKey = firstResult.verifiedRequestKey;
  const secondKey = secondResult.verifiedRequestKey;
  expect(firstKey.length).toBeGreaterThan(0);
  expect(secondKey).toBe(firstKey);
}

function requireJwkX(jwk: JsonWebKey) {
  if (typeof jwk.x !== "string" || jwk.x.length === 0) {
    throw new Error("expected Ed25519 JWK export to expose x");
  }
  return jwk.x;
}

function expectWebhookVerificationSucceeds(params: {
  publicKey: string;
  privateKey: crypto.KeyObject;
}) {
  const provider = new TelnyxProvider(
    { apiKey: "KEY123", connectionId: "CONN456", publicKey: params.publicKey },
    { skipVerification: false },
  );

  const rawBody = JSON.stringify({
    event_type: "call.initiated",
    payload: { call_control_id: "x" },
  });
  const result = provider.verifyWebhook(
    createSignedTelnyxCtx({ privateKey: params.privateKey, rawBody }),
  );
  expect(result.ok).toBe(true);
}

describe("TelnyxProvider.verifyWebhook", () => {
  it("fails closed when public key is missing and skipVerification is false", () => {
    const provider = new TelnyxProvider(
      { apiKey: "KEY123", connectionId: "CONN456", publicKey: undefined },
      { skipVerification: false },
    );

    const result = provider.verifyWebhook(createCtx());
    expect(result.ok).toBe(false);
  });

  it("allows requests when skipVerification is true (development only)", () => {
    const provider = new TelnyxProvider(
      { apiKey: "KEY123", connectionId: "CONN456", publicKey: undefined },
      { skipVerification: true },
    );

    const result = provider.verifyWebhook(createCtx());
    expect(result.ok).toBe(true);
  });

  it("fails when signature headers are missing (with public key configured)", () => {
    const provider = new TelnyxProvider(
      { apiKey: "KEY123", connectionId: "CONN456", publicKey: "public-key" },
      { skipVerification: false },
    );

    const result = provider.verifyWebhook(createCtx({ headers: {} }));
    expect(result.ok).toBe(false);
  });

  it("verifies a valid signature with a raw Ed25519 public key (Base64)", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

    const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
    expect(jwk.kty).toBe("OKP");
    expect(jwk.crv).toBe("Ed25519");

    const rawPublicKey = decodeBase64Url(requireJwkX(jwk));
    const rawPublicKeyBase64 = rawPublicKey.toString("base64");
    expectWebhookVerificationSucceeds({ publicKey: rawPublicKeyBase64, privateKey });
  });

  it("verifies a valid signature with a DER SPKI public key (Base64)", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const spkiDerBase64 = spkiDer.toString("base64");
    expectWebhookVerificationSucceeds({ publicKey: spkiDerBase64, privateKey });
  });

  it("returns replay status when the same signed request is seen twice", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const provider = new TelnyxProvider(
      { apiKey: "KEY123", connectionId: "CONN456", publicKey: spkiDer.toString("base64") },
      { skipVerification: false },
    );

    const rawBody = JSON.stringify({
      event_type: "call.initiated",
      payload: { call_control_id: "call-replay-test" },
      nonce: crypto.randomUUID(),
    });
    const ctx = createSignedTelnyxCtx({ privateKey, rawBody });

    const first = provider.verifyWebhook(ctx);
    const second = provider.verifyWebhook(ctx);

    expectReplayVerification([first, second]);
  });
});

describe("TelnyxProvider.parseWebhookEvent", () => {
  it("uses verified request key for manager dedupe", () => {
    const provider = new TelnyxProvider({
      apiKey: "KEY123",
      connectionId: "CONN456",
      publicKey: undefined,
    });
    const result = provider.parseWebhookEvent(
      createCtx({
        rawBody: JSON.stringify({
          data: {
            id: "evt-123",
            event_type: "call.initiated",
            payload: { call_control_id: "call-1" },
          },
        }),
      }),
      { verifiedRequestKey: "telnyx:req:abc" },
    );

    expect(result.events).toHaveLength(1);
    const event = result.events[0];
    if (!event) {
      throw new Error("expected Telnyx parseWebhookEvent to produce one event");
    }
    expect(event.dedupeKey).toBe("telnyx:req:abc");
  });
});
