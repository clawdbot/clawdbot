import { normalizeOptionalStringifiedId } from "openclaw/plugin-sdk/string-coerce-runtime";

// Zalouser plugin module implements message sid behavior.
function parseZalouserMessageSidFull(
  value?: string | number | null,
): { msgId: string; cliMsgId: string } | null {
  const raw = normalizeOptionalStringifiedId(value) ?? "";
  if (!raw) {
    return null;
  }
  const [msgIdPart, cliMsgIdPart] = raw.split(":").map((entry) => entry.trim());
  if (!msgIdPart || !cliMsgIdPart) {
    return null;
  }
  return { msgId: msgIdPart, cliMsgId: cliMsgIdPart };
}

export function resolveZalouserReactionMessageIds(params: {
  messageId?: string;
  cliMsgId?: string;
  currentMessageId?: string | number;
}): { msgId: string; cliMsgId: string } | null {
  const explicitMessageId = normalizeOptionalStringifiedId(params.messageId) ?? "";
  const explicitCliMsgId = normalizeOptionalStringifiedId(params.cliMsgId) ?? "";
  if (explicitMessageId && explicitCliMsgId) {
    return { msgId: explicitMessageId, cliMsgId: explicitCliMsgId };
  }

  const parsedFromCurrent = parseZalouserMessageSidFull(params.currentMessageId);
  if (parsedFromCurrent) {
    return parsedFromCurrent;
  }

  const currentRaw = normalizeOptionalStringifiedId(params.currentMessageId) ?? "";
  if (!currentRaw) {
    return null;
  }
  if (explicitMessageId && !explicitCliMsgId) {
    return { msgId: explicitMessageId, cliMsgId: currentRaw };
  }
  if (!explicitMessageId && explicitCliMsgId) {
    return { msgId: currentRaw, cliMsgId: explicitCliMsgId };
  }
  return { msgId: currentRaw, cliMsgId: currentRaw };
}

export function formatZalouserMessageSidFull(params: {
  msgId?: string | null;
  cliMsgId?: string | null;
}): string | undefined {
  const msgId = normalizeOptionalStringifiedId(params.msgId) ?? "";
  const cliMsgId = normalizeOptionalStringifiedId(params.cliMsgId) ?? "";
  if (!msgId && !cliMsgId) {
    return undefined;
  }
  if (msgId && cliMsgId) {
    return `${msgId}:${cliMsgId}`;
  }
  return msgId || cliMsgId || undefined;
}

export function resolveZalouserMessageSid(params: {
  msgId?: string | null;
  cliMsgId?: string | null;
  fallback?: string | null;
}): string | undefined {
  const msgId = normalizeOptionalStringifiedId(params.msgId) ?? "";
  const cliMsgId = normalizeOptionalStringifiedId(params.cliMsgId) ?? "";
  if (msgId || cliMsgId) {
    return msgId || cliMsgId;
  }
  return normalizeOptionalStringifiedId(params.fallback);
}
