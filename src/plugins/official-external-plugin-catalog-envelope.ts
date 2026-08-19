import {
  normalizeEd25519PublicKeyBase64Url,
  verifyEd25519SignatureBytes,
} from "../infra/ed25519-signature.js";
import { isRecord } from "../utils.js";
import {
  isOfficialExternalPluginCatalogFeed,
  type OfficialExternalPluginCatalogFeed,
} from "./official-external-plugin-catalog.js";

export const OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PAYLOAD_TYPE =
  "openclaw.official-external-plugin-catalog-feed.v1";
export const OFFICIAL_EXTERNAL_PLUGIN_CATALOG_SHARD_ROOT_PAYLOAD_TYPE =
  "openclaw.official-external-plugin-catalog-shard-root.v1";
const OFFICIAL_EXTERNAL_PLUGIN_CATALOG_MAX_SIGNATURES = 16;

type OfficialExternalPluginCatalogEnvelopeSignature = {
  keyid?: string;
  sig?: string;
};
type LegacyOfficialExternalPluginCatalogEnvelopeSignature = {
  keyId?: string;
  algorithm?: string;
  signature?: string;
};
type OfficialExternalPluginCatalogTrustedSigningKey = {
  keyId: string;
  publicKey: string;
};

type OfficialExternalPluginCatalogEnvelopeVerificationError = {
  ok: false;
  error:
    | "invalid-envelope"
    | "unsupported-payload"
    | "invalid-payload"
    | "missing-trust-key"
    | "invalid-signature";
  message: string;
  authenticatedPayload?: unknown;
};

type OfficialExternalPluginCatalogEnvelopePayloadVerificationResult =
  | {
      ok: true;
      payloadType: string;
      payload: unknown;
      payloadBytes: Buffer;
      signedBy: string;
      signedByKeyIds?: readonly string[];
      signatureCount?: number;
      threshold?: number;
    }
  | OfficialExternalPluginCatalogEnvelopeVerificationError;

type OfficialExternalPluginCatalogEnvelopeVerificationResult =
  | {
      ok: true;
      feed: OfficialExternalPluginCatalogFeed;
      signedBy: string;
      signedByKeyIds?: readonly string[];
      signatureCount?: number;
      threshold?: number;
    }
  | OfficialExternalPluginCatalogEnvelopeVerificationError;

function createOfficialExternalPluginCatalogEnvelopeSigningInput(params: {
  payloadType: string;
  payloadBytes: Buffer;
}): Buffer {
  return dssePreAuthenticationEncoding(params.payloadType, params.payloadBytes);
}

export function verifyOfficialExternalPluginCatalogEnvelopePayload(
  raw: unknown,
  params: {
    trustedKeys: readonly OfficialExternalPluginCatalogTrustedSigningKey[];
    acceptedPayloadTypes: ReadonlySet<string>;
    threshold?: number;
    allowLegacyBetaEnvelope?: boolean;
  },
): OfficialExternalPluginCatalogEnvelopePayloadVerificationResult {
  const envelope = parseOfficialExternalPluginCatalogSignedEnvelope(raw, {
    allowLegacyBetaEnvelope: params.allowLegacyBetaEnvelope === true,
  });
  if (!envelope) {
    return {
      ok: false,
      error: "invalid-envelope",
      message: "hosted catalog signed envelope is malformed",
    };
  }
  if (!params.acceptedPayloadTypes.has(envelope.payloadType)) {
    return {
      ok: false,
      error: "unsupported-payload",
      message: "hosted catalog signed envelope payload type is unsupported",
    };
  }
  const payloadBytes = decodeOfficialExternalPluginCatalogEnvelopePayloadBytes(envelope.payload);
  if (!payloadBytes) {
    return {
      ok: false,
      error: "invalid-payload",
      message: "hosted catalog signed envelope payload is invalid",
    };
  }
  const signingInput = createOfficialExternalPluginCatalogEnvelopeSigningInput({
    payloadType: envelope.payloadType,
    payloadBytes,
  });
  const threshold = Math.max(1, Math.trunc(params.threshold ?? 1));
  const trustedSignatureKeyIds: string[] = [];
  const trustedSignaturePublicKeys = new Set<string>();
  for (const envelopeSignature of envelope.signatures) {
    const keyId = envelopeSignature.keyid;
    const trustedKey = params.trustedKeys.find((candidate) => candidate.keyId === keyId);
    if (!trustedKey || trustedSignatureKeyIds.includes(trustedKey.keyId)) {
      continue;
    }
    const normalizedPublicKey = normalizeEd25519PublicKeyBase64Url(trustedKey.publicKey);
    if (!normalizedPublicKey || trustedSignaturePublicKeys.has(normalizedPublicKey)) {
      continue;
    }
    if (
      verifyEd25519SignatureBytes({
        publicKey: trustedKey.publicKey,
        payload: signingInput,
        signatureBase64Url: envelopeSignature.sig,
      })
    ) {
      trustedSignatureKeyIds.push(trustedKey.keyId);
      trustedSignaturePublicKeys.add(normalizedPublicKey);
      if (trustedSignaturePublicKeys.size >= threshold) {
        break;
      }
    }
  }
  if (trustedSignaturePublicKeys.size >= threshold) {
    const decoded = decodeOfficialExternalPluginCatalogEnvelopePayload(payloadBytes);
    if (!decoded) {
      return {
        ok: false,
        error: "invalid-payload",
        message: "hosted catalog signed envelope payload is invalid",
      };
    }
    return {
      ok: true,
      payloadType: envelope.payloadType,
      payload: decoded.raw,
      payloadBytes,
      signedBy: trustedSignatureKeyIds[0] ?? "",
      ...(threshold > 1
        ? {
            signedByKeyIds: trustedSignatureKeyIds,
            signatureCount: trustedSignaturePublicKeys.size,
            threshold,
          }
        : {}),
    };
  }
  const hasKnownKey = envelope.signatures.some((signature) =>
    params.trustedKeys.some((key) => key.keyId === signature.keyid),
  );
  return hasKnownKey
    ? {
        ok: false,
        error: "invalid-signature",
        message:
          trustedSignatureKeyIds.length > 0
            ? "hosted catalog signed envelope did not meet the configured signature threshold"
            : "hosted catalog signed envelope signature is invalid",
      }
    : {
        ok: false,
        error: "missing-trust-key",
        message: "hosted catalog signed envelope was not signed by a trusted key",
      };
}

export function verifyOfficialExternalPluginCatalogSignedEnvelope(
  raw: unknown,
  params: {
    trustedKeys: readonly OfficialExternalPluginCatalogTrustedSigningKey[];
    threshold?: number;
    allowLegacyBetaEnvelope?: boolean;
  },
): OfficialExternalPluginCatalogEnvelopeVerificationResult {
  const verification = verifyOfficialExternalPluginCatalogEnvelopePayload(raw, {
    ...params,
    acceptedPayloadTypes: new Set([OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PAYLOAD_TYPE]),
  });
  if (!verification.ok) {
    return verification;
  }
  if (!isOfficialExternalPluginCatalogFeed(verification.payload)) {
    return {
      ok: false,
      error: "invalid-payload",
      message: "hosted catalog signed envelope payload is invalid",
      authenticatedPayload: verification.payload,
    };
  }
  return {
    ok: true,
    feed: verification.payload,
    signedBy: verification.signedBy,
    ...(verification.signedByKeyIds ? { signedByKeyIds: verification.signedByKeyIds } : {}),
    ...(verification.signatureCount !== undefined
      ? { signatureCount: verification.signatureCount }
      : {}),
    ...(verification.threshold !== undefined ? { threshold: verification.threshold } : {}),
  };
}

function parseOfficialExternalPluginCatalogSignedEnvelope(
  raw: unknown,
  params: { allowLegacyBetaEnvelope: boolean },
): {
  payloadType: string;
  payload: string;
  signatures: readonly Required<OfficialExternalPluginCatalogEnvelopeSignature>[];
} | null {
  if (!isRecord(raw)) {
    return null;
  }
  const payloadType = raw.payloadType;
  const payload = raw.payload;
  const signatures = raw.signatures;
  if (typeof payloadType !== "string" || typeof payload !== "string") {
    return null;
  }
  if (!Array.isArray(signatures) || signatures.length === 0) {
    return null;
  }
  if (signatures.length > OFFICIAL_EXTERNAL_PLUGIN_CATALOG_MAX_SIGNATURES) {
    return null;
  }
  // Hosted Feed v1 requires keyid even though generic DSSE makes it optional:
  // trust thresholds and rotation are resolved against configured key ids.
  const standardSignatures = signatures.filter(
    (signature): signature is Required<OfficialExternalPluginCatalogEnvelopeSignature> =>
      isRecord(signature) &&
      typeof signature.keyid === "string" &&
      signature.keyid.trim().length > 0 &&
      typeof signature.sig === "string" &&
      signature.sig.trim().length > 0,
  );
  // Beta releases briefly persisted this pre-DSSE field shape. It remains an
  // all-or-nothing snapshot read path only; live publishers must use DSSE.
  const legacySignatures =
    raw.schemaVersion === 1
      ? signatures
          .filter(
            (
              signature,
            ): signature is Required<LegacyOfficialExternalPluginCatalogEnvelopeSignature> =>
              isRecord(signature) &&
              typeof signature.keyId === "string" &&
              signature.keyId.trim().length > 0 &&
              signature.algorithm === "ed25519" &&
              typeof signature.signature === "string" &&
              signature.signature.trim().length > 0,
          )
          .map((signature) => ({ keyid: signature.keyId, sig: signature.signature }))
      : [];
  if (standardSignatures.length > 0 && legacySignatures.length > 0) {
    return null;
  }
  const parsedSignatures =
    standardSignatures.length > 0
      ? standardSignatures
      : params.allowLegacyBetaEnvelope
        ? legacySignatures
        : [];
  if (parsedSignatures.length === 0) {
    return null;
  }
  if (parsedSignatures.length > OFFICIAL_EXTERNAL_PLUGIN_CATALOG_MAX_SIGNATURES) {
    return null;
  }
  const keyIds = new Set<string>();
  for (const signature of parsedSignatures) {
    if (keyIds.has(signature.keyid)) {
      return null;
    }
    keyIds.add(signature.keyid);
  }
  return {
    payloadType,
    payload,
    signatures: parsedSignatures,
  };
}

function dssePreAuthenticationEncoding(payloadType: string, payloadBytes: Buffer): Buffer {
  const payloadTypeBytes = Buffer.from(payloadType, "utf8");
  const prefix = Buffer.from(
    `DSSEv1 ${payloadTypeBytes.length} ${payloadType} ${payloadBytes.length} `,
    "utf8",
  );
  return Buffer.concat([prefix, payloadBytes]);
}

function decodeOfficialExternalPluginCatalogEnvelopePayloadBytes(payload: string): Buffer | null {
  try {
    return Buffer.from(payload, "base64");
  } catch {
    return null;
  }
}

function decodeOfficialExternalPluginCatalogEnvelopePayload(
  payloadBytes: Buffer,
): { raw: unknown } | null {
  try {
    const raw = JSON.parse(payloadBytes.toString("utf8")) as unknown;
    return { raw };
  } catch {
    return null;
  }
}
