import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export function resolveLegacyGroupSessionKey(ctx: { From?: string }): {
  key: string;
  channel: string;
  id: string;
  chatType: "group";
} | null {
  const from = typeof ctx.From === "string" ? ctx.From.trim() : "";
  const normalized = normalizeLowercaseStringOrEmpty(from);
  if (!from || from.includes(":") || !normalized.endsWith("@g.us")) {
    return null;
  }
  return {
    key: `whatsapp:group:${normalized}`,
    channel: "whatsapp",
    id: normalized,
    chatType: "group",
  };
}
