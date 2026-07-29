// Device Pair plugin module implements notify behavior.
import { randomUUID } from "node:crypto";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/core";
import { listDevicePairing } from "openclaw/plugin-sdk/device-bootstrap";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEVICE_PAIR_NOTIFY_MAX_SEEN_AGE_MS,
  DEVICE_PAIR_NOTIFY_SEEN_REQUEST_MAX_ENTRIES,
  DEVICE_PAIR_NOTIFY_SEEN_REQUEST_NAMESPACE,
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
  notifyRequestStoreKey,
  notifySubscriberKey,
  notifySubscriberStoreKey,
  type NotifySeenRequest,
  type NotifySubscription,
} from "./notify-state.js";

const NOTIFY_POLL_INTERVAL_MS = 10_000;

// Config reload recreates plugin services before an uncancellable delivery may settle.
// Keep one module-owned poll so the replacement service cannot race state or delivery.
let notifyPollInFlight: Promise<void> | null = null;

type PendingPairingRequest = {
  requestId: string;
  deviceId: string;
  displayName?: string;
  platform?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  ts?: number;
};

function formatStringList(values?: readonly string[]): string {
  if (!Array.isArray(values) || values.length === 0) {
    return "none";
  }
  const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);
  return normalized.length > 0 ? normalized.join(", ") : "none";
}

function formatRoleList(request: PendingPairingRequest): string {
  const role = normalizeOptionalString(request.role);
  if (role) {
    return role;
  }
  return formatStringList(request.roles);
}

function formatScopeList(request: PendingPairingRequest): string {
  return formatStringList(request.scopes);
}

export function formatPendingRequests(pending: PendingPairingRequest[]): string {
  if (pending.length === 0) {
    return "No pending device pairing requests.";
  }
  const lines: string[] = ["Pending device pairing requests:"];
  for (const req of pending) {
    const label = normalizeOptionalString(req.displayName) || req.deviceId;
    const platform = normalizeOptionalString(req.platform);
    const ip = normalizeOptionalString(req.remoteIp);
    const parts = [
      `- ${req.requestId}`,
      label ? `name=${label}` : null,
      platform ? `platform=${platform}` : null,
      `role=${formatRoleList(req)}`,
      `scopes=${formatScopeList(req)}`,
      ip ? `ip=${ip}` : null,
    ].filter(Boolean);
    lines.push(parts.join(" · "));
  }
  return lines.join("\n");
}

type NotifySubscriberStore = PluginStateKeyedStore<NotifySubscription> & {
  deleteIf: NonNullable<PluginStateKeyedStore<NotifySubscription>["deleteIf"]>;
};

function openNotifySubscriberStore(api: OpenClawPluginApi): NotifySubscriberStore {
  const store = api.runtime.state.openKeyedStore<NotifySubscription>({
    namespace: DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
    maxEntries: DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
  });
  if (!store.deleteIf) {
    throw new Error(
      "device-pair notify requires a runtime with atomic plugin state conditional delete support",
    );
  }
  return store as NotifySubscriberStore;
}

function openNotifySeenRequestStore(
  api: OpenClawPluginApi,
): PluginStateKeyedStore<NotifySeenRequest> {
  return api.runtime.state.openKeyedStore<NotifySeenRequest>({
    namespace: DEVICE_PAIR_NOTIFY_SEEN_REQUEST_NAMESPACE,
    maxEntries: DEVICE_PAIR_NOTIFY_SEEN_REQUEST_MAX_ENTRIES,
    defaultTtlMs: DEVICE_PAIR_NOTIFY_MAX_SEEN_AGE_MS,
  });
}

type NotifyTarget = {
  to: string;
  accountId?: string;
  messageThreadId?: string | number;
};

function resolveNotifyTarget(ctx: {
  senderId?: string;
  from?: string;
  to?: string;
  accountId?: string;
  messageThreadId?: string | number;
}): NotifyTarget | null {
  const to =
    normalizeOptionalString(ctx.senderId) ||
    normalizeOptionalString(ctx.from) ||
    normalizeOptionalString(ctx.to) ||
    "";
  if (!to) {
    return null;
  }
  return {
    to,
    ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
    ...(ctx.messageThreadId != null ? { messageThreadId: ctx.messageThreadId } : {}),
  };
}

function nextNotifySubscription(
  target: NotifyTarget,
  mode: NotifySubscription["mode"],
): NotifySubscription {
  return {
    ...target,
    mode,
    addedAtMs: Date.now(),
    armId: randomUUID(),
  };
}

async function registerNotifySubscriber(params: {
  api: OpenClawPluginApi;
  target: NotifyTarget;
  mode: NotifySubscription["mode"];
  refresh: boolean;
}): Promise<boolean> {
  const store = openNotifySubscriberStore(params.api);
  const key = notifySubscriberStoreKey(params.target);
  const current = await store.lookup(key);
  if (!params.refresh && current?.mode === params.mode) {
    return false;
  }
  await store.register(key, nextNotifySubscription(params.target, params.mode));
  return true;
}

function isSameNotifySubscription(
  current: NotifySubscription,
  expected: NotifySubscription,
): boolean {
  if (expected.armId) {
    return current.armId === expected.armId;
  }
  // Doctor-imported legacy subscriptions have no arm id. Their original
  // fields remain the exact generation until a new arm replaces the row.
  return (
    current.armId === undefined &&
    current.mode === expected.mode &&
    current.addedAtMs === expected.addedAtMs &&
    notifySubscriberKey(current) === notifySubscriberKey(expected)
  );
}

function buildPairingRequestNotificationText(request: PendingPairingRequest): string {
  const label = normalizeOptionalString(request.displayName) || request.deviceId;
  const platform = normalizeOptionalString(request.platform);
  const ip = normalizeOptionalString(request.remoteIp);
  const role = formatRoleList(request);
  const scopes = formatScopeList(request);
  const lines = [
    "📲 New device pairing request",
    `ID: ${request.requestId}`,
    `Name: ${label}`,
    ...(platform ? [`Platform: ${platform}`] : []),
    `Role: ${role}`,
    `Scopes: ${scopes}`,
    ...(ip ? [`IP: ${ip}`] : []),
    "",
    `Approve: /pair approve ${request.requestId}`,
    "List pending: /pair pending",
  ];
  return lines.join("\n");
}

function requestTimestampMs(request: PendingPairingRequest): number | null {
  if (typeof request.ts !== "number" || !Number.isFinite(request.ts)) {
    return null;
  }
  const ts = Math.trunc(request.ts);
  return ts > 0 ? ts : null;
}

function shouldNotifySubscriberForRequest(
  subscriber: NotifySubscription,
  request: PendingPairingRequest,
): boolean {
  if (subscriber.mode !== "once") {
    return true;
  }
  const ts = requestTimestampMs(request);
  // One-shot subscriptions should only notify for new requests created after arming.
  if (ts == null) {
    return false;
  }
  return ts >= subscriber.addedAtMs;
}

async function notifySubscriber(params: {
  api: OpenClawPluginApi;
  subscriber: NotifySubscription;
  text: string;
}): Promise<boolean> {
  const adapter = await params.api.runtime.channel.outbound.loadAdapter("telegram");
  const send = adapter?.sendText;
  if (!send) {
    params.api.logger.warn(
      "device-pair: telegram outbound adapter unavailable for pairing notifications",
    );
    return false;
  }

  try {
    await send({
      cfg: params.api.config,
      to: params.subscriber.to,
      text: params.text,
      ...(params.subscriber.accountId ? { accountId: params.subscriber.accountId } : {}),
      ...(params.subscriber.messageThreadId != null
        ? { threadId: params.subscriber.messageThreadId }
        : {}),
    });
    return true;
  } catch (err) {
    params.api.logger.warn(
      `device-pair: failed to send pairing notification to ${params.subscriber.to}: ${formatErrorMessage(err)}`,
    );
    return false;
  }
}

async function notifyPendingPairingRequests(params: { api: OpenClawPluginApi }): Promise<void> {
  const subscriberStore = openNotifySubscriberStore(params.api);
  const seenRequestStore = openNotifySeenRequestStore(params.api);
  const [subscriberEntries, seenRequestEntries, pairing] = await Promise.all([
    subscriberStore.entries(),
    seenRequestStore.entries(),
    listDevicePairing(),
  ]);
  const subscribers = subscriberEntries.toSorted((a, b) => a.value.addedAtMs - b.value.addedAtMs);
  const pending: PendingPairingRequest[] = pairing.pending;
  const now = Date.now();
  const pendingIds = new Set(pending.map((entry) => entry.requestId));
  const notifiedRequestIds = new Set<string>();

  for (const entry of seenRequestEntries) {
    const requestId = normalizeOptionalString(entry.value.requestId);
    const notifiedAtMs = entry.value.notifiedAtMs;
    if (
      !requestId ||
      !Number.isFinite(notifiedAtMs) ||
      notifiedAtMs <= 0 ||
      !pendingIds.has(requestId) ||
      now - notifiedAtMs > DEVICE_PAIR_NOTIFY_MAX_SEEN_AGE_MS
    ) {
      await seenRequestStore.delete(entry.key);
      continue;
    }
    notifiedRequestIds.add(requestId);
  }

  if (subscribers.length > 0) {
    const deliveredOneShots = new Set<string>();
    for (const request of pending) {
      if (notifiedRequestIds.has(request.requestId)) {
        continue;
      }

      const text = buildPairingRequestNotificationText(request);
      let delivered = false;
      for (const entry of subscribers) {
        const subscriber = entry.value;
        if (subscriber.mode === "once" && deliveredOneShots.has(entry.key)) {
          continue;
        }
        if (!shouldNotifySubscriberForRequest(subscriber, request)) {
          continue;
        }
        const sent = await notifySubscriber({
          api: params.api,
          subscriber,
          text,
        });
        delivered = delivered || sent;
        if (sent && subscriber.mode === "once") {
          deliveredOneShots.add(entry.key);
          // Delivery is fallible and uncancellable. Delete only the exact arm
          // that was sent so an overlapping re-arm remains subscribed.
          await subscriberStore.deleteIf(entry.key, (current) =>
            isSameNotifySubscription(current, subscriber),
          );
        }
      }

      if (delivered) {
        await seenRequestStore.register(
          notifyRequestStoreKey(request.requestId),
          { requestId: request.requestId, notifiedAtMs: now },
          { ttlMs: DEVICE_PAIR_NOTIFY_MAX_SEEN_AGE_MS },
        );
        notifiedRequestIds.add(request.requestId);
      }
    }
  }
}

async function runNotifyPoll(api: OpenClawPluginApi): Promise<void> {
  if (notifyPollInFlight) {
    return;
  }
  notifyPollInFlight = notifyPendingPairingRequests({ api });
  try {
    await notifyPollInFlight;
  } finally {
    notifyPollInFlight = null;
  }
}

export async function armPairNotifyOnce(params: {
  api: OpenClawPluginApi;
  ctx: {
    channel: string;
    senderId?: string;
    from?: string;
    to?: string;
    accountId?: string;
    messageThreadId?: string | number;
  };
}): Promise<boolean> {
  if (params.ctx.channel !== "telegram") {
    return false;
  }
  const target = resolveNotifyTarget(params.ctx);
  if (!target) {
    return false;
  }

  await registerNotifySubscriber({
    api: params.api,
    target,
    mode: "once",
    refresh: true,
  });
  return true;
}

export async function handleNotifyCommand(params: {
  api: OpenClawPluginApi;
  ctx: {
    channel: string;
    senderId?: string;
    from?: string;
    to?: string;
    accountId?: string;
    messageThreadId?: string | number;
  };
  action: string;
}): Promise<{ text: string }> {
  if (params.ctx.channel !== "telegram") {
    return { text: "Pairing notifications are currently supported only on Telegram." };
  }

  const target = resolveNotifyTarget(params.ctx);
  if (!target) {
    return { text: "Could not resolve Telegram target for this chat." };
  }

  const subscriberStore = openNotifySubscriberStore(params.api);
  const targetStoreKey = notifySubscriberStoreKey(target);

  if (params.action === "on" || params.action === "enable") {
    await registerNotifySubscriber({
      api: params.api,
      target,
      mode: "persistent",
      refresh: false,
    });
    return {
      text:
        "✅ Pair request notifications enabled for this Telegram chat.\n" +
        "I will ping here when a new device pairing request arrives.",
    };
  }

  if (params.action === "off" || params.action === "disable") {
    await subscriberStore.delete(targetStoreKey);
    return { text: "✅ Pair request notifications disabled for this Telegram chat." };
  }

  if (params.action === "once" || params.action === "arm") {
    await armPairNotifyOnce({
      api: params.api,
      ctx: params.ctx,
    });
    return {
      text:
        "✅ One-shot pairing notification armed for this Telegram chat.\n" +
        "I will notify on the next new pairing request, then auto-disable.",
    };
  }

  if (params.action === "status" || params.action === "") {
    const [current, subscribers, pending] = await Promise.all([
      subscriberStore.lookup(targetStoreKey),
      subscriberStore.entries(),
      listDevicePairing(),
    ]);
    const enabled = Boolean(current);
    const mode = current?.mode ?? "off";
    return {
      text: [
        `Pair request notifications: ${enabled ? "enabled" : "disabled"} for this chat.`,
        `Mode: ${mode}`,
        `Subscribers: ${subscribers.length}`,
        `Pending requests: ${pending.pending.length}`,
        "",
        "Use /pair notify on|off|once",
      ].join("\n"),
    };
  }

  return { text: "Usage: /pair notify on|off|once|status" };
}

export function createPairingNotifierService(api: OpenClawPluginApi): OpenClawPluginService {
  let notifyInterval: ReturnType<typeof setInterval> | null = null;

  return {
    id: "device-pair-notifier",
    start: async () => {
      const tick = async () => {
        await runNotifyPoll(api);
      };

      await tick().catch((err: unknown) => {
        api.logger.warn(`device-pair: initial notify poll failed: ${formatErrorMessage(err)}`);
      });
      notifyInterval = setInterval(() => {
        tick().catch((err: unknown) => {
          api.logger.warn(`device-pair: notify poll failed: ${formatErrorMessage(err)}`);
        });
      }, NOTIFY_POLL_INTERVAL_MS);
      notifyInterval.unref?.();
    },
    stop: async () => {
      if (notifyInterval) {
        clearInterval(notifyInterval);
        notifyInterval = null;
      }
    },
  };
}
