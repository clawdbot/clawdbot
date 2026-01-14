export function elide(text?: string, limit = 400) {
  if (!text) return text;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… (truncated ${text.length - limit} chars)`;
}

export function isLikelyWhatsAppCryptoError(reason: unknown) {
  const formatReason = (value: unknown): string => {
    if (value == null) return "";
    if (typeof value === "string") return value;
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
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return String(value);
    if (typeof value === "bigint") return String(value);
    if (typeof value === "symbol") return value.description ?? value.toString();
    if (typeof value === "function")
      return value.name ? `[function ${value.name}]` : "[function]";
    return Object.prototype.toString.call(value);
  };
  const raw =
    reason instanceof Error
      ? `${reason.message}\n${reason.stack ?? ""}`
      : formatReason(reason);
  const haystack = raw.toLowerCase();
  const hasAuthError =
    haystack.includes("unsupported state or unable to authenticate data") ||
    haystack.includes("bad mac");
  if (!hasAuthError) return false;
  return (
    haystack.includes("@whiskeysockets/baileys") ||
    haystack.includes("baileys") ||
    haystack.includes("noise-handler") ||
    haystack.includes("aesdecryptgcm")
  );
}
