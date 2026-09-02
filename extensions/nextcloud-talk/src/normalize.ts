// Nextcloud Talk helper module supports normalize behavior.
export function stripNextcloudTalkTargetPrefix(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  let normalized = trimmed;

  if (/^nextcloud-talk:/i.test(normalized)) {
    normalized = normalized.slice("nextcloud-talk:".length).trim();
  } else if (/^nc-talk:/i.test(normalized)) {
    normalized = normalized.slice("nc-talk:".length).trim();
  } else if (/^nc:/i.test(normalized)) {
    normalized = normalized.slice("nc:".length).trim();
  }

  if (/^room:/i.test(normalized)) {
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

  if (/^(nextcloud-talk|nc-talk|nc|room):/i.test(trimmed)) {
    return true;
  }

  return /^[a-z0-9]{8,}$/i.test(trimmed);
}
