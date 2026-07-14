import crypto, { type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyOfficialExternalPluginCatalogSignedEnvelope } from "./official-external-plugin-catalog-envelope.js";
import type { OfficialExternalPluginCatalogFeed } from "./official-external-plugin-catalog.js";

const PAYLOAD_TYPE = "openclaw.official-external-plugin-catalog-feed.v1";

type SigningKey = {
  keyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
};

function fixtureFeed(): OfficialExternalPluginCatalogFeed {
  return {
    schemaVersion: 2,
    id: "clawhub-official",
    generatedAt: "2026-06-30T00:00:00.000Z",
    sequence: 42,
    entries: [
      {
        type: "plugin",
        id: "@openclaw/signed-feed-proof",
        title: "Signed Feed Proof",
        state: "available",
        publisher: { id: "openclaw", trust: "official" },
      },
    ],
  };
}

function createSigningKey(keyId: string): SigningKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return { keyId, privateKey, publicKey };
}

function exportPublicKey(key: SigningKey): string {
  return key.publicKey.export({ type: "spki", format: "pem" });
}

function signingInput(payloadType: string, payloadBytes: Buffer): Buffer {
  const payloadTypeBytes = Buffer.from(payloadType, "utf8");
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${payloadTypeBytes.length} ${payloadType} ${payloadBytes.length} `, "utf8"),
    payloadBytes,
  ]);
}

function signedEnvelope(params: {
  keys: readonly SigningKey[];
  feed?: unknown;
  payloadType?: string;
  encoding?: "base64" | "base64url";
}) {
  const payloadType = params.payloadType ?? PAYLOAD_TYPE;
  const payloadBytes = Buffer.from(JSON.stringify(params.feed ?? fixtureFeed()), "utf8");
  const payload = payloadBytes.toString(params.encoding ?? "base64url");
  const input = signingInput(payloadType, payloadBytes);
  return {
    schemaVersion: 1,
    payloadType,
    payload,
    signatures: params.keys.map((key) => ({
      keyId: key.keyId,
      algorithm: "ed25519",
      signature: crypto.sign(null, input, key.privateKey).toString("base64url"),
    })),
  };
}

describe("official external plugin catalog signed envelopes", () => {
  it.each(["base64", "base64url"] as const)(
    "verifies decoded payload bytes from %s envelopes",
    (encoding) => {
      const key = createSigningKey("catalog-root");
      const result = verifyOfficialExternalPluginCatalogSignedEnvelope(
        signedEnvelope({ keys: [key], encoding }),
        { trustedKeys: [{ keyId: key.keyId, publicKey: exportPublicKey(key) }] },
      );

      expect(result).toMatchObject({ ok: true, feed: fixtureFeed(), signedBy: key.keyId });
    },
  );

  it("enforces distinct trusted key material for signature thresholds", () => {
    const first = createSigningKey("first");
    const second = createSigningKey("second");
    const result = verifyOfficialExternalPluginCatalogSignedEnvelope(
      signedEnvelope({ keys: [first, second] }),
      {
        trustedKeys: [
          { keyId: first.keyId, publicKey: exportPublicKey(first) },
          { keyId: second.keyId, publicKey: exportPublicKey(second) },
        ],
        threshold: 2,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      signedByKeyIds: ["first", "second"],
      signatureCount: 2,
      threshold: 2,
    });

    const duplicateId = { ...first, keyId: "duplicate-material" };
    const duplicateMaterial = verifyOfficialExternalPluginCatalogSignedEnvelope(
      signedEnvelope({ keys: [first, duplicateId] }),
      {
        trustedKeys: [
          { keyId: first.keyId, publicKey: exportPublicKey(first) },
          { keyId: duplicateId.keyId, publicKey: exportPublicKey(first) },
        ],
        threshold: 2,
      },
    );
    expect(duplicateMaterial).toMatchObject({ ok: false, error: "invalid-signature" });
  });

  it("rejects payload bytes changed after signing", () => {
    const key = createSigningKey("catalog-root");
    const envelope = signedEnvelope({ keys: [key] });
    envelope.payload = Buffer.from(
      JSON.stringify({ ...fixtureFeed(), sequence: 43 }),
      "utf8",
    ).toString("base64url");

    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(envelope, {
        trustedKeys: [{ keyId: key.keyId, publicKey: exportPublicKey(key) }],
      }),
    ).toMatchObject({ ok: false, error: "invalid-signature" });
  });

  it("distinguishes unknown keys from invalid trusted signatures", () => {
    const signer = createSigningKey("signer");
    const other = createSigningKey("other");
    const envelope = signedEnvelope({ keys: [signer] });

    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(envelope, {
        trustedKeys: [{ keyId: other.keyId, publicKey: exportPublicKey(other) }],
      }),
    ).toMatchObject({ ok: false, error: "missing-trust-key" });
    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(envelope, {
        trustedKeys: [{ keyId: signer.keyId, publicKey: exportPublicKey(other) }],
      }),
    ).toMatchObject({ ok: false, error: "invalid-signature" });
  });

  it("rejects duplicate key ids and excessive signature lists", () => {
    const key = createSigningKey("catalog-root");
    const envelope = signedEnvelope({ keys: [key] });
    const signature = envelope.signatures[0];
    const trustedKeys = [{ keyId: key.keyId, publicKey: exportPublicKey(key) }];

    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(
        { ...envelope, signatures: [signature, signature] },
        { trustedKeys },
      ),
    ).toMatchObject({ ok: false, error: "invalid-envelope" });
    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(
        {
          ...envelope,
          signatures: Array.from({ length: 17 }, (_, index) => ({
            ...signature,
            keyId: `key-${index}`,
          })),
        },
        { trustedKeys },
      ),
    ).toMatchObject({ ok: false, error: "invalid-envelope" });
  });

  it("rejects unsupported payload types and signed invalid feeds", () => {
    const key = createSigningKey("catalog-root");
    const trustedKeys = [{ keyId: key.keyId, publicKey: exportPublicKey(key) }];

    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(
        signedEnvelope({ keys: [key], payloadType: "example.unsupported" }),
        { trustedKeys },
      ),
    ).toMatchObject({ ok: false, error: "unsupported-payload" });
    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(
        signedEnvelope({ keys: [key], feed: { entries: [] } }),
        { trustedKeys },
      ),
    ).toMatchObject({ ok: false, error: "invalid-payload" });
  });

  it("rejects malformed envelopes before verification", () => {
    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(
        { schemaVersion: 1, payloadType: PAYLOAD_TYPE, payload: "", signatures: [] },
        { trustedKeys: [] },
      ),
    ).toMatchObject({ ok: false, error: "invalid-envelope" });
  });
});
