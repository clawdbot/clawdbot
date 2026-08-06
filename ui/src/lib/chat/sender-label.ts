export type SenderIdentity = {
  id?: string;
  name?: string;
  username?: string;
  profileAvatarUrl?: string;
};

type SenderIdentityInput = {
  id?: unknown;
  name?: unknown;
  username?: unknown;
  profileAvatarUrl?: unknown;
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

export function normalizeSenderIdentity(
  sender: SenderIdentityInput | null | undefined,
): SenderIdentity | null {
  const id = normalizeLabelPart(sender?.id);
  const name = normalizeLabelPart(sender?.name);
  const username = normalizeLabelPart(sender?.username);
  const profileAvatarUrl = normalizeLabelPart(sender?.profileAvatarUrl);
  if (!id && !name && !username && !profileAvatarUrl) {
    return null;
  }
  return {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(username ? { username } : {}),
    ...(profileAvatarUrl ? { profileAvatarUrl } : {}),
  };
}

export function senderIdentityKey(sender: SenderIdentity | null | undefined): string | null {
  if (!sender) {
    return null;
  }
  return [
    sender.id ?? "",
    sender.name ?? "",
    sender.username ?? "",
    sender.profileAvatarUrl ?? "",
  ].join("\u0000");
}
