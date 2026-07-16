function toMessageSidPart(value?: string | number | null): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return "";
}

export function parseZalouserMessageSidFull(
  value?: string | number | null,
): { msgId: string; cliMsgId: string } | null {
  const raw = toMessageSidPart(value);
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
  const explicitMessageId = toMessageSidPart(params.messageId);
  const explicitCliMsgId = toMessageSidPart(params.cliMsgId);
  if (explicitMessageId && explicitCliMsgId) {
    return { msgId: explicitMessageId, cliMsgId: explicitCliMsgId };
  }

  const parsedFromCurrent = parseZalouserMessageSidFull(params.currentMessageId);
  if (parsedFromCurrent) {
    return parsedFromCurrent;
  }

  const currentRaw = toMessageSidPart(params.currentMessageId);
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
  const msgId = toMessageSidPart(params.msgId);
  const cliMsgId = toMessageSidPart(params.cliMsgId);
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
  const msgId = toMessageSidPart(params.msgId);
  const cliMsgId = toMessageSidPart(params.cliMsgId);
  if (msgId || cliMsgId) {
    return msgId || cliMsgId;
  }
  return toMessageSidPart(params.fallback) || undefined;
}
