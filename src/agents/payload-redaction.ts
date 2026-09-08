/**
 * Redacts diagnostic payloads before persistence. It removes credential-like
 * fields, masks embedded auth strings, and replaces media/base64 data with
 * size and digest metadata.
 */
import crypto from "node:crypto";
import { projectDiagnosticValue, type DiagnosticProjectionPolicy } from "@openclaw/ai/diagnostics";

const REDACTED_MEDIA_DATA = "<redacted>";

function mediaDigest(source: string | Uint8Array): string {
  return crypto.createHash("sha256").update(source).digest("hex");
}

const CORE_DIAGNOSTIC_PROJECTION = {
  // Auth profile ids come from a tiny enumerable set, so hashing them would be
  // a dictionary-attack away from plaintext; they stay out of captures entirely.
  omitField: (key) => key === "providerReplay" || key === "authProfileId",
  propertyScope: "enumerable",
  projectBinary: (binary) => ({
    redacted: REDACTED_MEDIA_DATA,
    bytes: binary.byteLength,
    sha256: mediaDigest(binary),
  }),
  projectMedia: (key, media) => ({
    [key]: REDACTED_MEDIA_DATA,
    ...(media.source === undefined
      ? {}
      : { bytes: media.bytes, sha256: mediaDigest(media.source) }),
  }),
} satisfies DiagnosticProjectionPolicy;

/** Removes credentials and inline media bytes from diagnostic payloads before persistence. */
export function sanitizeDiagnosticPayload(value: unknown): unknown {
  return projectDiagnosticValue(value, CORE_DIAGNOSTIC_PROJECTION);
}
