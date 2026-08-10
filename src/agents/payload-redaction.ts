/**
 * Redacts diagnostic payloads before persistence. It removes credential-like
 * fields, masks embedded auth strings, and replaces media/base64 data with
 * size and digest metadata.
 */
import crypto from "node:crypto";
import {
  diagnosticBytes,
  extractDiagnosticMediaField,
  isCredentialFieldName,
  isDiagnosticMediaPayload,
  redactDiagnosticText,
} from "@openclaw/ai/internal/shared";

const REDACTED_MEDIA_DATA = "<redacted>";

/** Removes credentials and inline media bytes from diagnostic payloads before persistence. */
export function sanitizeDiagnosticPayload(value: unknown): unknown {
  const seen = new WeakSet<object>();

  const visit = (input: unknown, mediaPayload = false): unknown => {
    const binary = diagnosticBytes(input);
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
    const redactValue = typeof rawName === "string" && isCredentialFieldName(rawName);
    const redactMedia = mediaPayload || isDiagnosticMediaPayload(descriptors);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor)) {
        continue;
      }
      if (key === "providerReplay" || isCredentialFieldName(key)) {
        continue;
      }
      const child = descriptor.value;
      const media = extractDiagnosticMediaField(key, child, redactMedia);
      if (media) {
        out[key] = media === true ? REDACTED_MEDIA_DATA : media[0].redacted;
        if (media !== true) {
          out.bytes = media[0].bytes;
          out.sha256 = crypto.createHash("sha256").update(media[1]).digest("hex");
        }
        continue;
      }
      out[key] = redactValue && key === "value" ? "<redacted>" : visit(child, media === false);
    }
    return out;
  };

  try {
    return visit(value);
  } catch {
    return "[unreadable diagnostic payload]";
  }
}
