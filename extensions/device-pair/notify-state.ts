// Device Pair notify state helpers keep runtime and doctor migration in sync.
import { createHash } from "node:crypto";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const DEVICE_PAIR_NOTIFY_LEGACY_STATE_FILE = "device-pair-notify.json";
export const DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE = "notify-subscribers";
export const DEVICE_PAIR_NOTIFY_SEEN_REQUEST_NAMESPACE = "notify-seen-requests";
export const DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES = 1024;
export const DEVICE_PAIR_NOTIFY_SEEN_REQUEST_MAX_ENTRIES = 4096;
export const DEVICE_PAIR_NOTIFY_MAX_SEEN_AGE_MS = 24 * 60 * 60 * 1000;

export type NotifySubscription = {
  to: string;
  accountId?: string;
  messageThreadId?: string | number;
  mode: "persistent" | "once";
  addedAtMs: number;
};

export type NotifySeenRequest = {
  requestId: string;
  notifiedAtMs: number;
};

export type LegacyNotifyStateFile = {
  subscribers: NotifySubscription[];
  notifiedRequestIds: Record<string, number>;
};

export function normalizeLegacyNotifyState(raw: unknown): LegacyNotifyStateFile {
  const root = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const subscribersRaw = Array.isArray(root.subscribers) ? root.subscribers : [];
  const notifiedRaw =
    typeof root.notifiedRequestIds === "object" && root.notifiedRequestIds !== null
      ? (root.notifiedRequestIds as Record<string, unknown>)
      : {};

  const subscribers: NotifySubscription[] = [];
  for (const item of subscribersRaw) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const to = normalizeOptionalString(record.to) ?? "";
    if (!to) {
      continue;
    }
    const accountId = normalizeOptionalString(record.accountId) ?? undefined;
    const messageThreadId =
      typeof record.messageThreadId === "string"
        ? normalizeOptionalString(record.messageThreadId) || undefined
        : typeof record.messageThreadId === "number" && Number.isFinite(record.messageThreadId)
          ? Math.trunc(record.messageThreadId)
          : undefined;
    const mode = record.mode === "once" ? "once" : "persistent";
    const addedAtMs =
      typeof record.addedAtMs === "number" && Number.isFinite(record.addedAtMs)
        ? Math.trunc(record.addedAtMs)
        : Date.now();
    subscribers.push({
      to,
      accountId,
      messageThreadId,
      mode,
      addedAtMs,
    });
  }

  const notifiedRequestIds: Record<string, number> = {};
  for (const [requestId, ts] of Object.entries(notifiedRaw)) {
    const normalizedRequestId = normalizeOptionalString(requestId);
    if (!normalizedRequestId) {
      continue;
    }
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
      continue;
    }
    notifiedRequestIds[normalizedRequestId] = Math.trunc(ts);
  }

  return { subscribers, notifiedRequestIds };
}

export function normalizeNotifyThreadKey(messageThreadId?: string | number): string {
  if (typeof messageThreadId === "number" && Number.isFinite(messageThreadId)) {
    return String(Math.trunc(messageThreadId));
  }
  if (typeof messageThreadId !== "string") {
    return "";
  }
  const normalized = normalizeOptionalString(messageThreadId);
  if (!normalized) {
    return "";
  }
  if (!/^-?\d+$/u.test(normalized)) {
    return normalized;
  }
  try {
    return BigInt(normalized).toString();
  } catch {
    return normalized;
  }
}

export function notifySubscriberKey(subscriber: {
  to: string;
  accountId?: string;
  messageThreadId?: string | number;
}): string {
  return JSON.stringify([
    subscriber.to,
    subscriber.accountId ?? "",
    normalizeNotifyThreadKey(subscriber.messageThreadId),
  ]);
}

function hashStoreKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function notifySubscriberStoreKey(subscriber: {
  to: string;
  accountId?: string;
  messageThreadId?: string | number;
}): string {
  return hashStoreKey(notifySubscriberKey(subscriber));
}

export function notifyRequestStoreKey(requestId: string): string {
  return hashStoreKey(requestId);
}
