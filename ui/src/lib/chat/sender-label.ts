type SenderIdentity = {
  id?: unknown;
  name?: unknown;
  username?: unknown;
};

function normalizeLabelPart(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Formats durable sender identity without assuming ids will always be email addresses. */
export function formatSenderLabel(sender: SenderIdentity | null | undefined): string | null {
  const displayName = normalizeLabelPart(sender?.name) ?? normalizeLabelPart(sender?.username);
  if (displayName) {
    return displayName;
  }
  const id = normalizeLabelPart(sender?.id);
  if (!id) {
    return null;
  }
  return /^([^@\s]+)@[^@\s]+$/.exec(id)?.[1] ?? id;
}
