import { describe, expect, it } from "vitest";
import {
  computeRelayAuthProof,
  deriveRelayAuthKeyId,
  extensionRelayAuthResource,
  type RelayAuthProofFields,
} from "./relay-auth-v2-crypto.js";
import { createExtensionRelayAuthClient, parseRelayAuthJson } from "./relay-auth-v2.js";

const VECTOR = {
  token: Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0")).join(""),
  fields: {
    keyId: "Yw3NKWbEM2aRElRIu7JbT_",
    instanceId: "EREREREREREREREREREREQ",
    sessionId: "IiIiIiIiIiIiIiIiIiIiIg",
    clientNonce: "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM",
    serverNonce: "REREREREREREREREREREREREREREREREREREREREREQ",
    issuedAtMs: 1_786_123_456_000,
    expiresAtMs: 1_786_123_466_000,
    role: "extension",
    transport: "websocket",
    method: "GET",
    resource: "/extension?profile=chrome",
    flow: "extension",
  } satisfies RelayAuthProofFields,
  serverProof: "ynhaAA_l2HkOGXQ8DvIWfzWwwGjDcV93aumHNe_NM-Q",
  clientProof: "Rl8TStMYlPLxJPDYwSe__mtEjgMf1C4TM-ZN6sUipZ4",
  acceptProof: "1R5MpHs6qnAdc0_X6vKBwj91tlRoWfNuGXaNfSD7VnI",
};

function challenge(overrides: Record<string, unknown> = {}) {
  return {
    type: "auth.challenge",
    v: 2,
    ...VECTOR.fields,
    serverProof: VECTOR.serverProof,
    ...overrides,
  };
}

async function client() {
  return await createExtensionRelayAuthClient({
    token: VECTOR.token,
    relayUrl: "ws://127.0.0.1:18797/extension?profile=chrome",
    clientNonce: VECTOR.fields.clientNonce,
    now: () => VECTOR.fields.issuedAtMs + 1,
  });
}

describe("Browser Relay Authentication v2 WebCrypto vectors", () => {
  it("matches the fixed Node HMAC vector", async () => {
    await expect(deriveRelayAuthKeyId(VECTOR.token)).resolves.toBe(VECTOR.fields.keyId);
    await expect(computeRelayAuthProof(VECTOR.token, "server", VECTOR.fields)).resolves.toBe(
      VECTOR.serverProof,
    );
    await expect(computeRelayAuthProof(VECTOR.token, "client", VECTOR.fields)).resolves.toBe(
      VECTOR.clientProof,
    );
    await expect(
      computeRelayAuthProof(VECTOR.token, "accept", VECTOR.fields, VECTOR.clientProof),
    ).resolves.toBe(VECTOR.acceptProof);
  });

  it("verifies server proof before producing client proof and verifies accept proof", async () => {
    const auth = await client();
    expect(auth.start()).toEqual({
      type: "auth.hello",
      v: 2,
      keyId: VECTOR.fields.keyId,
      clientNonce: VECTOR.fields.clientNonce,
    });
    await expect(auth.acceptChallenge(challenge())).resolves.toEqual({
      type: "auth.response",
      v: 2,
      sessionId: VECTOR.fields.sessionId,
      clientProof: VECTOR.clientProof,
    });
    expect(auth.authenticated).toBe(false);
    await expect(
      auth.acceptOk({
        type: "auth.ok",
        v: 2,
        sessionId: VECTOR.fields.sessionId,
        acceptProof: VECTOR.acceptProof,
      }),
    ).resolves.toBeUndefined();
    expect(auth.authenticated).toBe(true);
  });
});

describe("Browser Relay Authentication v2 client validation", () => {
  it("rejects a bad server proof without producing a client proof", async () => {
    const auth = await client();
    auth.start();
    await expect(auth.acceptChallenge(challenge({ serverProof: "A".repeat(43) }))).rejects.toThrow(
      "server proof is invalid",
    );
    expect(auth.authenticated).toBe(false);
    await expect(auth.acceptChallenge(challenge())).rejects.toThrow("out of sequence");
  });

  it("rejects every substituted challenge binding", async () => {
    const substitutions: Array<[string, unknown]> = [
      ["v", 1],
      ["keyId", "A".repeat(22)],
      ["instanceId", "A".repeat(22)],
      ["sessionId", "A".repeat(22)],
      ["clientNonce", "A".repeat(43)],
      ["serverNonce", "A".repeat(43)],
      ["issuedAtMs", VECTOR.fields.issuedAtMs - 1],
      ["expiresAtMs", VECTOR.fields.expiresAtMs - 1],
      ["role", "cdp"],
      ["transport", "connection"],
      ["method", "POST"],
      ["resource", "/other"],
      ["flow", "json-list"],
    ];
    for (const [field, value] of substitutions) {
      const auth = await client();
      auth.start();
      await expect(auth.acceptChallenge(challenge({ [field]: value }))).rejects.toThrow();
    }
  });

  it("rejects expired, overlong, and extra-field challenges", async () => {
    for (const mutation of [
      {
        issuedAtMs: VECTOR.fields.issuedAtMs - 20_000,
        expiresAtMs: VECTOR.fields.issuedAtMs - 10_000,
      },
      { expiresAtMs: VECTOR.fields.issuedAtMs + 10_001 },
      { unexpected: true },
    ]) {
      const auth = await client();
      auth.start();
      await expect(auth.acceptChallenge(challenge(mutation))).rejects.toThrow();
    }
  });

  it("rejects bad accept proof and exact-sequence violations", async () => {
    const early = await client();
    await expect(
      early.acceptOk({
        type: "auth.ok",
        v: 2,
        sessionId: VECTOR.fields.sessionId,
        acceptProof: VECTOR.acceptProof,
      }),
    ).rejects.toThrow("out of sequence");

    const auth = await client();
    auth.start();
    await auth.acceptChallenge(challenge());
    await expect(
      auth.acceptOk({
        type: "auth.ok",
        v: 2,
        sessionId: VECTOR.fields.sessionId,
        acceptProof: "A".repeat(43),
      }),
    ).rejects.toThrow("accept proof is invalid");
    expect(auth.authenticated).toBe(false);
  });

  it("canonicalizes only the allowed profile query", () => {
    expect(
      extensionRelayAuthResource("wss://gateway.example/base/browser/extension?profile=work"),
    ).toBe("/base/browser/extension?profile=work");
    expect(() =>
      extensionRelayAuthResource("ws://127.0.0.1/extension?profile=a&profile=b"),
    ).toThrow("unsupported query");
    expect(() => extensionRelayAuthResource("ws://127.0.0.1/extension?token=nope")).toThrow(
      "unsupported query",
    );
  });

  it("rejects duplicate security fields before JSON parsing", () => {
    expect(parseRelayAuthJson('{"type":"auth.ok","v":2,"v":1}')).toBeNull();
    expect(parseRelayAuthJson('{"type":"auth.ok","v":2}')).toEqual({
      type: "auth.ok",
      v: 2,
    });
  });

  it("rejects oversized authentication frames before JSON parsing", () => {
    expect(parseRelayAuthJson(`{"padding":"${"a".repeat(16 * 1024)}"}`)).toBeNull();
    expect(parseRelayAuthJson(`{"padding":"${"é".repeat(9 * 1024)}"}`)).toBeNull();
  });
});
