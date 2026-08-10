/**
 * Redacts diagnostic payloads before persistence. It removes credential-like
 * fields, masks embedded auth strings, and replaces media/base64 data with
 * size and digest metadata.
 */
import crypto from "node:crypto";
import {
  diagnosticBinaryView,
  diagnosticMediaBytes,
  isCredentialFieldName,
  isDiagnosticMediaPayload,
  redactDiagnosticText,
} from "@openclaw/ai/internal/shared";
import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";

const REDACTED_MEDIA_DATA = "<redacted>";

/** Removes credentials and inline media bytes from diagnostic payloads before persistence. */
export function sanitizeDiagnosticPayload(value: unknown): unknown {
  const seen = new WeakSet<object>();

  const visit = (input: unknown, mediaPayload = false): unknown => {
    const binary = diagnosticBinaryView(input);
    if (binary) {
      return {
        redacted: REDACTED_MEDIA_DATA,
        bytes: binary.byteLength,
        sha256: crypto.createHash("sha256").update(binary).digest("hex"),
      };
    }
    if (Array.isArray(input)) {
      return input.map((entry) => visit(entry, mediaPayload));
    }
    if (typeof input === "string") {
      return redactDiagnosticText(input);
    }
    if (!input || typeof input !== "object") {
      return input;
    }
    if (seen.has(input)) {
      return "[Circular]";
    }
    seen.add(input);

    const descriptors = Object.getOwnPropertyDescriptors(input);
    const out: Record<string, unknown> = {};
    const rawName =
      typeof descriptors.name?.value === "string" ? descriptors.name.value : descriptors.key?.value;
    const redactValueField = typeof rawName === "string" && isCredentialFieldName(rawName);
    const redactMedia = mediaPayload || isDiagnosticMediaPayload(descriptors);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor)) {
        continue;
      }
      if (key === "providerReplay" || isCredentialFieldName(key)) {
        continue;
      }
      const alwaysPrivateMedia = key === "videoBytes" || key === "b64_json";
      const privateMediaField =
        alwaysPrivateMedia || (redactMedia && (key === "data" || key === "blob"));
      const encoded = privateMediaField
        ? (diagnosticMediaBytes(descriptor.value) ??
          (typeof descriptor.value === "string" ? descriptor.value : undefined))
        : undefined;
      if (encoded !== undefined) {
        out[key] = REDACTED_MEDIA_DATA;
        out.bytes =
          typeof encoded === "string" ? estimateBase64DecodedBytes(encoded) : encoded.byteLength;
        out.sha256 = crypto.createHash("sha256").update(encoded).digest("hex");
        continue;
      }
      out[key] =
        redactValueField && key === "value" ? "<redacted>" : visit(descriptor.value, redactMedia);
    }
    return out;
  };

  try {
    return visit(value);
  } catch {
    return "[unreadable diagnostic payload]";
  }
}
