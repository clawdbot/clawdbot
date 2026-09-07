// Whatsapp plugin module implements util behavior.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

export function elide(text?: string, limit = 400) {
  if (!text) {
    return text;
  }
  if (text.length <= limit) {
    return text;
  }
  const truncated = truncateUtf16Safe(text, limit);
  return `${truncated}… (truncated ${text.length - truncated.length} chars)`;
}

export function markWhatsAppVisibleDeliveryError(error: unknown): unknown {
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    try {
      Object.assign(error, { sentBeforeError: true, visibleReplySent: true });
      return error;
    } catch {
      // Fall back to a wrapper when a platform error object is non-extensible.
    }
  }
  const visibleError = new Error("visible WhatsApp reply delivery failed", { cause: error });
  Object.assign(visibleError, { sentBeforeError: true, visibleReplySent: true });
  return visibleError;
}

export function isLikelyWhatsAppCryptoError(reason: unknown) {
  const formatReason = (value: unknown): string => {
    if (value == null) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    if (value instanceof Error) {
      return `${value.message}\n${value.stack ?? ""}`;
    }
    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        return Object.prototype.toString.call(value);
      }
    }
    if (typeof value === "number") {
      return String(value);
    }
    if (typeof value === "boolean") {
      return String(value);
    }
    if (typeof value === "bigint") {
      return String(value);
    }
    if (typeof value === "symbol") {
      return value.description ?? value.toString();
    }
    if (typeof value === "function") {
      return value.name ? `[function ${value.name}]` : "[function]";
    }
    return Object.prototype.toString.call(value);
  };
  const raw =
    reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : formatReason(reason);
  const haystack = normalizeLowercaseStringOrEmpty(raw);
  const hasAuthError =
    haystack.includes("unsupported state or unable to authenticate data") ||
    haystack.includes("bad mac");
  if (!hasAuthError) {
    return false;
  }
  return (
    haystack.includes("baileys") ||
    haystack.includes("noise-handler") ||
    haystack.includes("aesdecryptgcm")
  );
}
