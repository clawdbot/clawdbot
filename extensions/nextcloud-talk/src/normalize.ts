export function stripNextcloudTalkTargetPrefix(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  let normalized = trimmed;

  if (normalized.startsWith("nextcloud-talk:")) {
    normalized = normalized.slice("nextcloud-talk:".length).trim();
  } else if (normalized.startsWith("nc-talk:")) {
    normalized = normalized.slice("nc-talk:".length).trim();
  } else if (normalized.startsWith("nc:")) {
    normalized = normalized.slice("nc:".length).trim();
  }

  if (normalized.startsWith("room:")) {
    normalized = normalized.slice("room:".length).trim();
  }

  if (!normalized) {
    return undefined;
  }

  return normalized;
}

export function normalizeNextcloudTalkMessagingTarget(raw: string): string | undefined {
  const normalized = stripNextcloudTalkTargetPrefix(raw);
  return normalized ? `nextcloud-talk:${normalized}`.toLowerCase() : undefined;
}

export function looksLikeNextcloudTalkTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }

  if (/^(nextcloud-talk|nc-talk|nc):/i.test(trimmed)) {
    return true;
  }

  return /^[a-z0-9]{8,}$/i.test(trimmed);
}
