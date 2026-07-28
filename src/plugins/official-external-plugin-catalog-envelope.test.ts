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
    payloadType,
    payload,
    signatures: params.keys.map((key) => ({
      keyid: key.keyId,
      sig: crypto.sign(null, input, key.privateKey).toString("base64url"),
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
            keyid: `key-${index}`,
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
    ).toMatchObject({
      ok: false,
      error: "invalid-payload",
      authenticatedPayload: { entries: [] },
    });
  });

  it("rejects malformed envelopes before verification", () => {
    const key = createSigningKey("catalog-root");
    const envelope = signedEnvelope({ keys: [key] });
    const signature = envelope.signatures[0];
    expect(signature).toBeDefined();
    if (!signature) {
      throw new Error("expected a generated signature");
    }
    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(
        { payloadType: PAYLOAD_TYPE, payload: "", signatures: [] },
        { trustedKeys: [] },
      ),
    ).toMatchObject({ ok: false, error: "invalid-envelope" });
    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(
        { ...envelope, signatures: [{ sig: signature.sig }] },
        { trustedKeys: [{ keyId: key.keyId, publicKey: exportPublicKey(key) }] },
      ),
    ).toMatchObject({ ok: false, error: "invalid-envelope" });
  });

  it("ignores unrecognized DSSE envelope and signature fields", () => {
    const key = createSigningKey("catalog-root");
    const envelope = signedEnvelope({ keys: [key] });
    const signature = envelope.signatures[0];
    expect(signature).toBeDefined();
    if (!signature) {
      throw new Error("expected a generated signature");
    }

    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(
        {
          ...envelope,
          futureEnvelopeField: true,
          signatures: [{ ...signature, futureSignatureField: true }],
        },
        { trustedKeys: [{ keyId: key.keyId, publicKey: exportPublicKey(key) }] },
      ),
    ).toMatchObject({ ok: true, signedBy: key.keyId });
  });

  it("accepts beta legacy field names only for persisted snapshots", () => {
    const key = createSigningKey("catalog-root");
    const envelope = signedEnvelope({ keys: [key] });
    const signature = envelope.signatures[0];
    expect(signature).toBeDefined();
    if (!signature) {
      throw new Error("expected a generated signature");
    }
    const legacySignature = {
      keyId: signature.keyid,
      algorithm: "ed25519",
      signature: signature.sig,
    };
    const trustedKeys = [{ keyId: key.keyId, publicKey: exportPublicKey(key) }];

    const legacyEnvelope = {
      ...envelope,
      schemaVersion: 1,
      signatures: [legacySignature],
    };

    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(legacyEnvelope, { trustedKeys }),
    ).toMatchObject({ ok: false, error: "invalid-envelope" });
    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(legacyEnvelope, {
        trustedKeys,
        allowLegacyBetaEnvelope: true,
      }),
    ).toMatchObject({ ok: true, signedBy: key.keyId });
    const mixedEnvelope = {
      ...envelope,
      schemaVersion: 1,
      signatures: [signature, legacySignature],
    };
    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(mixedEnvelope, { trustedKeys }),
    ).toMatchObject({ ok: false, error: "invalid-envelope" });
    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(mixedEnvelope, {
        trustedKeys,
        allowLegacyBetaEnvelope: true,
      }),
    ).toMatchObject({ ok: false, error: "invalid-envelope" });
  });
});
