// Sends session maintenance warnings before warn-only cleanup.
import type { SessionMaintenanceWarning } from "../config/sessions/store-maintenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createLazyPromiseLoader } from "../shared/lazy-runtime.js";
import { deliveryContextFromSession } from "../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import { pruneMapToMaxSize } from "./map-size.js";
import { buildOutboundSessionContext } from "./outbound/session-context.js";
import { enqueueSystemEvent } from "./system-events.js";

// Session maintenance warnings notify an active session before warn-only
// cleanup would prune it, with per-session dedupe and system-event fallback.
type WarningParams = {
  cfg: OpenClawConfig;
  sessionKey: string;
  entry: SessionEntry;
  warning: SessionMaintenanceWarning;
};

// Bound process-lifetime dedupe while keeping several agents' default 500-session
// windows resident. Eviction can re-emit one warning for an old session.
const MAX_WARNED_CONTEXTS = 4096;
const warnedContexts = new Map<string, string>();

function shouldSuppressWarning(sessionKey: string, contextKey: string): boolean {
  const duplicate = warnedContexts.get(sessionKey) === contextKey;
  // Refresh insertion order even for suppressed duplicates; otherwise active sessions
  // become eviction candidates and can receive repeated warnings under key churn.
  warnedContexts.delete(sessionKey);
  warnedContexts.set(sessionKey, contextKey);
  pruneMapToMaxSize(warnedContexts, MAX_WARNED_CONTEXTS);
  return duplicate;
}

const log = createSubsystemLogger("session-maintenance-warning");
const messageRuntimeLoader = createLazyPromiseLoader(
  () => import("../channels/message/runtime.js"),
  { cacheRejections: true },
);

function resetSessionMaintenanceWarningForTests() {
  warnedContexts.clear();
  messageRuntimeLoader.clear();
}

export const testing = {
  resetSessionMaintenanceWarningForTests,
} as const;

const loadDeliverRuntime = messageRuntimeLoader.load;

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
  const secs = Math.round(ms / 1000);
  if (secs < 60) {
    return `${secs} second${secs === 1 ? "" : "s"}`;
  }
  const mins = Math.round(ms / 60_000);
  if (mins < 60) {
    return `${mins} minute${mins === 1 ? "" : "s"}`;
  }
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(ms / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"}`;
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

/** Deliver or enqueue a warn-only session maintenance notification. */
export async function deliverSessionMaintenanceWarning(params: WarningParams): Promise<void> {
  if (!shouldSendWarning()) {
    return;
  }

  const contextKey = buildWarningContext(params);
  // Dedupe by effective warning context so repeated maintenance scans do not
  // spam the same session, but changed limits still produce a fresh warning.
  if (shouldSuppressWarning(params.sessionKey, contextKey)) {
    return;
  }

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
    const { sendDurableMessageBatch } = await loadDeliverRuntime();
    const outboundSession = buildOutboundSessionContext({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
    const send = await sendDurableMessageBatch({
      cfg: params.cfg,
      channel,
      to: target.to,
      accountId: target.accountId,
      threadId: target.threadId,
      payloads: [{ text }],
      session: outboundSession,
    });
    if (send.status === "failed" || send.status === "partial_failed") {
      throw send.error;
    }
  } catch (err) {
    log.warn(`Failed to deliver session maintenance warning: ${String(err)}`);
    enqueueSystemEvent(text, { sessionKey: params.sessionKey });
  }
}
export { testing as __testing };
