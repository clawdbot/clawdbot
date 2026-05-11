import { promises as fs } from "node:fs";
import path from "node:path";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/core";
import { listDevicePairing } from "openclaw/plugin-sdk/device-bootstrap";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const NOTIFY_STATE_FILE = "device-pair-notify.json";
const NOTIFY_POLL_INTERVAL_MS = 10_000;
const NOTIFY_MAX_SEEN_AGE_MS = 24 * 60 * 60 * 1000;

type NotifySubscription = {
  to: string;
  accountId?: string;
  messageThreadId?: string | number;
  mode: "persistent" | "once";
  addedAtMs: number;
};

type NotifyStateFile = {
  subscribers: NotifySubscription[];
  notifiedRequestIds: Record<string, number>;
};

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

function resolveNotifyStatePath(stateDir: string): string {
  return path.join(stateDir, NOTIFY_STATE_FILE);
}

function normalizeNotifyState(raw: unknown): NotifyStateFile {
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

async function readNotifyState(filePath: string): Promise<NotifyStateFile> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return normalizeNotifyState(JSON.parse(content));
  } catch {
    return { subscribers: [], notifiedRequestIds: {} };
  }
}

async function writeNotifyState(filePath: string, state: NotifyStateFile): Promise<void> {
  const content = JSON.stringify(state, null, 2);
  await replaceFileAtomic({
    filePath,
    content: `${content}\n`,
    tempPrefix: ".device-pair-notify",
  });
}

function notifySubscriberKey(subscriber: {
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

function normalizeNotifyThreadKey(messageThreadId?: string | number): string {
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

function upsertNotifySubscriber(
  subscribers: NotifySubscription[],
  target: NotifyTarget,
  mode: NotifySubscription["mode"],
): boolean {
  const key = notifySubscriberKey(target);
  const index = subscribers.findIndex((entry) => notifySubscriberKey(entry) === key);
  const next: NotifySubscription = {
    ...target,
    mode,
    addedAtMs: Date.now(),
  };
  if (index === -1) {
    subscribers.push(next);
    return true;
  }
  const existing = subscribers[index];
  if (existing?.mode === mode) {
    return false;
  }
  subscribers[index] = next;
  return true;
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

async function notifyPendingPairingRequests(params: {
  api: OpenClawPluginApi;
  statePath: string;
}): Promise<void> {
  const state = await readNotifyState(params.statePath);
  const pairing = await listDevicePairing();
  const pending = pairing.pending as PendingPairingRequest[];
  const now = Date.now();
  const pendingIds = new Set(pending.map((entry) => entry.requestId));
  let changed = false;

  for (const [requestId, ts] of Object.entries(state.notifiedRequestIds)) {
    if (!pendingIds.has(requestId) || now - ts > NOTIFY_MAX_SEEN_AGE_MS) {
      delete state.notifiedRequestIds[requestId];
      changed = true;
    }
  }

  if (state.subscribers.length > 0) {
    const oneShotDelivered = new Set<string>();
    for (const request of pending) {
      if (state.notifiedRequestIds[request.requestId]) {
        continue;
      }

      const text = buildPairingRequestNotificationText(request);
      let delivered = false;
      for (const subscriber of state.subscribers) {
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
          oneShotDelivered.add(notifySubscriberKey(subscriber));
        }
      }

      if (delivered) {
        state.notifiedRequestIds[request.requestId] = now;
        changed = true;
      }
    }
    if (oneShotDelivered.size > 0) {
      const initialCount = state.subscribers.length;
      state.subscribers = state.subscribers.filter(
        (subscriber) => !oneShotDelivered.has(notifySubscriberKey(subscriber)),
      );
      if (state.subscribers.length !== initialCount) {
        changed = true;
      }
    }
  }

  if (changed) {
    await writeNotifyState(params.statePath, state);
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

  const stateDir = params.api.runtime.state.resolveStateDir();
  const statePath = resolveNotifyStatePath(stateDir);
  const state = await readNotifyState(statePath);
  let changed = false;

  if (upsertNotifySubscriber(state.subscribers, target, "once")) {
    changed = true;
  }

  if (changed) {
    await writeNotifyState(statePath, state);
  }
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

  const stateDir = params.api.runtime.state.resolveStateDir();
  const statePath = resolveNotifyStatePath(stateDir);
  const state = await readNotifyState(statePath);
  const targetKey = notifySubscriberKey(target);
  const current = state.subscribers.find((entry) => notifySubscriberKey(entry) === targetKey);

  if (params.action === "on" || params.action === "enable") {
    if (upsertNotifySubscriber(state.subscribers, target, "persistent")) {
      await writeNotifyState(statePath, state);
    }
    return {
      text:
        "✅ Pair request notifications enabled for this Telegram chat.\n" +
        "I will ping here when a new device pairing request arrives.",
    };
  }

  if (params.action === "off" || params.action === "disable") {
    const currentIndex = state.subscribers.findIndex(
      (entry) => notifySubscriberKey(entry) === targetKey,
    );
    if (currentIndex !== -1) {
      state.subscribers.splice(currentIndex, 1);
      await writeNotifyState(statePath, state);
    }
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
    const pending = await listDevicePairing();
    const enabled = Boolean(current);
    const mode = current?.mode ?? "off";
    return {
      text: [
        `Pair request notifications: ${enabled ? "enabled" : "disabled"} for this chat.`,
        `Mode: ${mode}`,
        `Subscribers: ${state.subscribers.length}`,
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
    start: async (ctx) => {
      const statePath = resolveNotifyStatePath(ctx.stateDir);
      const tick = async () => {
        await notifyPendingPairingRequests({ api, statePath });
      };

      await tick().catch((err) => {
        api.logger.warn(`device-pair: initial notify poll failed: ${formatErrorMessage(err)}`);
      });
      notifyInterval = setInterval(() => {
        tick().catch((err) => {
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

export function registerPairingNotifierService(api: OpenClawPluginApi): void {
  api.registerService(createPairingNotifierService(api));
}
