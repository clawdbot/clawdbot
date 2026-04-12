import type { SessionMaintenanceWarning } from "../config/sessions/store-maintenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { deliveryContextFromSession } from "../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import { buildOutboundSessionContext } from "./outbound/session-context.js";
import { enqueueSystemEvent } from "./system-events.js";

type WarningParams = {
  cfg: OpenClawConfig;
  sessionKey: string;
  entry: SessionEntry;
  warning: SessionMaintenanceWarning;
};

const warnedContexts = new Map<string, string>();
const log = createSubsystemLogger("session-maintenance-warning");
let deliverRuntimePromise: Promise<typeof import("./outbound/deliver-runtime.js")> | null = null;

function resetSessionMaintenanceWarningForTests() {
  warnedContexts.clear();
  deliverRuntimePromise = null;
}

export const __testing = {
  resetSessionMaintenanceWarningForTests,
} as const;

function loadDeliverRuntime() {
  deliverRuntimePromise ??= import("./outbound/deliver-runtime.js");
  return deliverRuntimePromise;
}

function shouldSendWarning(): boolean {
  return process.env.NODE_ENV !== "test";
}

function buildWarningContext(params: WarningParams): string {
  const { warning } = params;
  return [
    warning.activeSessionKey,
    warning.pruneAfterMs,
    warning.maxEntries,
    warning.wouldPrune ? "prune" : "",
    warning.wouldCap ? "cap" : "",
  ]
    .filter(Boolean)
    .join("|");
}

function formatDuration(ms: number): string {
  if (ms >= 86_400_000) {
    const days = Math.round(ms / 86_400_000);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (ms >= 3_600_000) {
    const hours = Math.round(ms / 3_600_000);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (ms >= 60_000) {
    const mins = Math.round(ms / 60_000);
    return `${mins} minute${mins === 1 ? "" : "s"}`;
  }
  const secs = Math.round(ms / 1000);
  return `${secs} second${secs === 1 ? "" : "s"}`;
}

function buildWarningText(warning: SessionMaintenanceWarning): string {
  const reasons: string[] = [];
  if (warning.wouldPrune) {
    reasons.push(`older than ${formatDuration(warning.pruneAfterMs)}`);
  }
  if (warning.wouldCap) {
    reasons.push(`not in the most recent ${warning.maxEntries} sessions`);
  }
  const reasonText = reasons.length > 0 ? reasons.join(" and ") : "over maintenance limits";
  return (
    `⚠️ Session maintenance warning: this active session would be evicted (${reasonText}). ` +
    `Maintenance is set to warn-only, so nothing was reset. ` +
    `To enforce cleanup, set \`session.maintenance.mode: "enforce"\` or increase the limits.`
  );
}

function resolveWarningDeliveryTarget(entry: SessionEntry): {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
} {
  const context = deliveryContextFromSession(entry);
  const channel = context?.channel
    ? (normalizeMessageChannel(context.channel) ?? context.channel)
    : undefined;
  return {
    channel: channel && isDeliverableMessageChannel(channel) ? channel : undefined,
    to: context?.to,
    accountId: context?.accountId,
    threadId: context?.threadId,
  };
}

export async function deliverSessionMaintenanceWarning(params: WarningParams): Promise<void> {
  if (!shouldSendWarning()) {
    return;
  }

  const contextKey = buildWarningContext(params);
  if (warnedContexts.get(params.sessionKey) === contextKey) {
    return;
  }
  warnedContexts.set(params.sessionKey, contextKey);

  const text = buildWarningText(params.warning);
  const target = resolveWarningDeliveryTarget(params.entry);

  if (!target.channel || !target.to) {
    enqueueSystemEvent(text, { sessionKey: params.sessionKey });
    return;
  }

  const channel = normalizeMessageChannel(target.channel) ?? target.channel;
  if (!isDeliverableMessageChannel(channel)) {
    enqueueSystemEvent(text, { sessionKey: params.sessionKey });
    return;
  }

  try {
    const { deliverOutboundPayloads } = await loadDeliverRuntime();
    const outboundSession = buildOutboundSessionContext({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
    await deliverOutboundPayloads({
      cfg: params.cfg,
      channel,
      to: target.to,
      accountId: target.accountId,
      threadId: target.threadId,
      payloads: [{ text }],
      session: outboundSession,
    });
  } catch (err) {
    log.warn(`Failed to deliver session maintenance warning: ${String(err)}`);
    enqueueSystemEvent(text, { sessionKey: params.sessionKey });
  }
}
