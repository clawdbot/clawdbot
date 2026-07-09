import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { publicKeyRawBase64UrlFromEd25519Pem } from "../infra/ed25519-signature.js";
import {
  OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PAYLOAD_TYPE,
  createOfficialExternalPluginCatalogEnvelopePayload,
  createOfficialExternalPluginCatalogEnvelopeSigningInput,
  verifyOfficialExternalPluginCatalogSignedEnvelope,
  type OfficialExternalPluginCatalogSignedEnvelope,
} from "./official-external-plugin-catalog-envelope.js";
import type { OfficialExternalPluginCatalogFeed } from "./official-external-plugin-catalog.js";

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

function signedEnvelope(params?: {
  feed?: OfficialExternalPluginCatalogFeed;
  payload?: string;
  payloadType?: string;
  keyId?: string;
  privateKeyPem?: string;
}): {
  envelope: OfficialExternalPluginCatalogSignedEnvelope;
  publicKeyPem: string;
  rawPublicKey: string;
} {
  const { publicKey, privateKey } =
    params?.privateKeyPem === undefined
      ? crypto.generateKeyPairSync("ed25519", {
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        })
      : {
          publicKey: crypto
            .createPublicKey(params.privateKeyPem)
            .export({ type: "spki", format: "pem" }) as string,
          privateKey: params.privateKeyPem,
        };
  const payloadType = params?.payloadType ?? OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PAYLOAD_TYPE;
  const payload =
    params?.payload ??
    createOfficialExternalPluginCatalogEnvelopePayload(params?.feed ?? fixtureFeed());
  const payloadBytes = Buffer.from(payload, "base64");
  const signingInput = createOfficialExternalPluginCatalogEnvelopeSigningInput({
    payloadType,
    payloadBytes,
  });
  const signature = crypto
    .sign(null, signingInput, crypto.createPrivateKey(privateKey))
    .toString("base64url");
  return {
    envelope: {
      schemaVersion: 1,
      payloadType,
      payload,
      signatures: [
        {
          keyId: params?.keyId ?? "clawhub-root-2026",
          algorithm: "ed25519",
          signature,
        },
      ],
    },
    publicKeyPem: publicKey,
    rawPublicKey: publicKeyRawBase64UrlFromEd25519Pem(publicKey),
  };
}

describe("official external plugin catalog signed envelopes", () => {
  it("uses DSSE pre-authentication encoding for signature input", () => {
    expect(
      createOfficialExternalPluginCatalogEnvelopeSigningInput({
        payloadType: OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PAYLOAD_TYPE,
        payloadBytes: Buffer.from("abc", "utf8"),
      }).toString("utf8"),
    ).toBe("DSSEv1 49 openclaw.official-external-plugin-catalog-feed.v1 3 abc");
  });

  it("verifies a signed ClawHub feed envelope with a trusted PEM key", () => {
    const { envelope, publicKeyPem } = signedEnvelope();

    const result = verifyOfficialExternalPluginCatalogSignedEnvelope(envelope, {
      trustedKeys: [{ keyId: "clawhub-root-2026", publicKey: publicKeyPem }],
    });

    expect(result).toEqual({
      ok: true,
      signedBy: "clawhub-root-2026",
      feed: fixtureFeed(),
    });
  });

  it("verifies signatures over decoded payload bytes across base64 encodings", () => {
    const feedBytes = Buffer.from(JSON.stringify(fixtureFeed()), "utf8");
    const urlSafePayload = feedBytes.toString("base64url");
    const standardPayload = feedBytes.toString("base64");
    const { envelope, publicKeyPem } = signedEnvelope({ payload: urlSafePayload });

    const result = verifyOfficialExternalPluginCatalogSignedEnvelope(
      {
        ...envelope,
        payload: standardPayload,
      },
      {
        trustedKeys: [{ keyId: "clawhub-root-2026", publicKey: publicKeyPem }],
      },
    );

    expect(result).toEqual({
      ok: true,
      signedBy: "clawhub-root-2026",
      feed: fixtureFeed(),
    });
  });

  it("verifies a signed ClawHub feed envelope with a trusted raw base64url key", () => {
    const { envelope, rawPublicKey } = signedEnvelope();

    const result = verifyOfficialExternalPluginCatalogSignedEnvelope(envelope, {
      trustedKeys: [{ keyId: "clawhub-root-2026", publicKey: rawPublicKey }],
    });

    expect(result.ok).toBe(true);
  });

  it("enforces the configured trusted signature threshold", () => {
    const first = signedEnvelope({ keyId: "clawhub-root-a" });
    const second = signedEnvelope({ keyId: "clawhub-root-b" });
    const firstSignature = first.envelope.signatures?.[0];
    const secondSignature = second.envelope.signatures?.[0];
    if (!firstSignature || !secondSignature) {
      throw new Error("expected signatures");
    }
    const envelope = {
      ...first.envelope,
      signatures: [firstSignature, secondSignature],
    };

    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(envelope, {
        trustedKeys: [
          { keyId: "clawhub-root-a", publicKey: first.publicKeyPem },
          { keyId: "clawhub-root-b", publicKey: second.publicKeyPem },
        ],
        threshold: 2,
      }),
    ).toMatchObject({
      ok: true,
      signedBy: "clawhub-root-a",
      signedByKeyIds: ["clawhub-root-a", "clawhub-root-b"],
      signatureCount: 2,
      threshold: 2,
    });

    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(first.envelope, {
        trustedKeys: [
          { keyId: "clawhub-root-a", publicKey: first.publicKeyPem },
          { keyId: "clawhub-root-b", publicKey: second.publicKeyPem },
        ],
        threshold: 2,
      }),
    ).toMatchObject({
      ok: false,
      error: "invalid-signature",
    });
  });

  it("does not count duplicate trust key material toward the signature threshold", () => {
    const { envelope, publicKeyPem } = signedEnvelope({ keyId: "clawhub-root-a" });
    const firstSignature = envelope.signatures?.[0];
    if (!firstSignature) {
      throw new Error("expected signature");
    }
    const result = verifyOfficialExternalPluginCatalogSignedEnvelope(
      {
        ...envelope,
        signatures: [
          firstSignature,
          {
            ...firstSignature,
            keyId: "clawhub-root-b",
          },
        ],
      },
      {
        trustedKeys: [
          { keyId: "clawhub-root-a", publicKey: publicKeyPem },
          { keyId: "clawhub-root-b", publicKey: publicKeyPem },
        ],
        threshold: 2,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-signature",
    });
  });

  it("rejects payload bytes changed after signing", () => {
    const { envelope, publicKeyPem } = signedEnvelope();
    const tamperedFeed = { ...fixtureFeed(), sequence: 43 };
    const result = verifyOfficialExternalPluginCatalogSignedEnvelope(
      {
        ...envelope,
        payload: createOfficialExternalPluginCatalogEnvelopePayload(tamperedFeed),
      },
      {
        trustedKeys: [{ keyId: "clawhub-root-2026", publicKey: publicKeyPem }],
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-signature",
    });
  });

  it("rejects signatures made by an untrusted key id", () => {
    const { envelope, publicKeyPem } = signedEnvelope({ keyId: "unknown-key" });

    const result = verifyOfficialExternalPluginCatalogSignedEnvelope(envelope, {
      trustedKeys: [{ keyId: "clawhub-root-2026", publicKey: publicKeyPem }],
    });

    expect(result).toMatchObject({
      ok: false,
      error: "missing-trust-key",
    });
  });

  it("rejects signatures made by the wrong trusted key", () => {
    const { envelope } = signedEnvelope();
    const { publicKeyPem: wrongPublicKey } = signedEnvelope();

    const result = verifyOfficialExternalPluginCatalogSignedEnvelope(envelope, {
      trustedKeys: [{ keyId: "clawhub-root-2026", publicKey: wrongPublicKey }],
    });

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-signature",
    });
  });

  it("rejects duplicate key ids before signature verification", () => {
    const { envelope, publicKeyPem } = signedEnvelope();
    const [signature] = envelope.signatures ?? [];
    expect(signature).toBeDefined();

    const result = verifyOfficialExternalPluginCatalogSignedEnvelope(
      {
        ...envelope,
        signatures: [signature!, signature!],
      },
      {
        trustedKeys: [{ keyId: "clawhub-root-2026", publicKey: publicKeyPem }],
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-envelope",
    });
  });

  it("rejects excessive signature entries before signature verification", () => {
    const { envelope, publicKeyPem } = signedEnvelope();
    const [signature] = envelope.signatures ?? [];
    expect(signature).toBeDefined();

    const result = verifyOfficialExternalPluginCatalogSignedEnvelope(
      {
        ...envelope,
        signatures: Array.from({ length: 17 }, (_, index) => ({
          ...signature!,
          keyId: `key-${index}`,
        })),
      },
      {
        trustedKeys: [{ keyId: "clawhub-root-2026", publicKey: publicKeyPem }],
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-envelope",
    });
  });

  it("rejects excessive raw signature entries before filtering malformed entries", () => {
    const { envelope, publicKeyPem } = signedEnvelope();
    const [signature] = envelope.signatures ?? [];
    expect(signature).toBeDefined();

    const result = verifyOfficialExternalPluginCatalogSignedEnvelope(
      {
        ...envelope,
        signatures: [
          ...Array.from({ length: 16 }, () => ({
            algorithm: "ed25519",
          })),
          signature!,
        ],
      },
      {
        trustedKeys: [{ keyId: "clawhub-root-2026", publicKey: publicKeyPem }],
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-envelope",
    });
  });

  it("rejects unsupported payload types before trusting the payload", () => {
    const { envelope, publicKeyPem } = signedEnvelope({
      payloadType: "openclaw.other-feed.v1",
    });

    const result = verifyOfficialExternalPluginCatalogSignedEnvelope(envelope, {
      trustedKeys: [{ keyId: "clawhub-root-2026", publicKey: publicKeyPem }],
    });

    expect(result).toMatchObject({
      ok: false,
      error: "unsupported-payload",
    });
  });

  it("rejects malformed envelopes and invalid feed payloads", () => {
    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(
        { schemaVersion: 1, payloadType: OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PAYLOAD_TYPE },
        { trustedKeys: [] },
      ),
    ).toMatchObject({
      ok: false,
      error: "invalid-envelope",
    });

    const malformedPayload = signedEnvelope({
      payload: Buffer.from(JSON.stringify({ schemaVersion: 99 }), "utf8").toString("base64url"),
    });
    expect(
      verifyOfficialExternalPluginCatalogSignedEnvelope(malformedPayload.envelope, {
        trustedKeys: [{ keyId: "clawhub-root-2026", publicKey: malformedPayload.publicKeyPem }],
      }),
    ).toMatchObject({
      ok: false,
      error: "invalid-payload",
    });
  });
});
