/** Stale-state notice text, coalescing keys, and watcher eligibility. */
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { isSubagentSessionKey, parseAgentSessionKey } from "../routing/session-key.js";

const SESSION_STATE_CONTEXT_PREFIX = "session-state:";

function encodeNoticeTarget(sessionKey: string): string {
  return Buffer.from(sessionKey, "utf8").toString("hex");
}

export function decodeSessionStateNoticeContextKey(contextKey: string): string | undefined {
  if (!contextKey.startsWith(SESSION_STATE_CONTEXT_PREFIX)) {
    return undefined;
  }
  const encoded = contextKey.slice(SESSION_STATE_CONTEXT_PREFIX.length);
  if (!encoded || encoded.length % 2 !== 0 || !/^[0-9a-f]+$/.test(encoded)) {
    return undefined;
  }
  return Buffer.from(encoded, "hex").toString("utf8");
}

// Terse on purpose: this line lands in model prompts, possibly repeatedly across
// turns. Text must stay byte-stable per frozen watermark so queue dedupe holds,
// and the reconciliation call must be self-contained (explicit target sessionKey).
function sessionStateNoticeText(targetSessionKey: string, lastSeenSequence: number): string {
  return `Session "${targetSessionKey}" changed (other actor). Reconcile before acting: session_status sessionKey "${targetSessionKey}" changesSince ${lastSeenSequence}.`;
}

function shouldWakeWatcher(watcherSessionKey: string): boolean {
  return !isSubagentSessionKey(watcherSessionKey);
}

// Bare keys (session.scope="global") are store-local per agent, but cursors, the
// system-event queue, and heartbeat wakes are keyed by session key alone. A notice
// for one agent's child could be drained and acknowledged by another agent's global
// turn — a cross-A2A metadata leak plus a lost notification. Until watcher identity
// is agent-scoped end-to-end, such watchers get durable events and changesSince but
// no notices.
export function isNotifiableWatcherKey(watcherSessionKey: string): boolean {
  return parseAgentSessionKey(watcherSessionKey) != null;
}

export function enqueueSessionStateNotice(params: {
  watcherSessionKey: string;
  targetSessionKey: string;
  lastSeenSequence: number;
  queueOnly?: boolean;
}): void {
  enqueueSystemEvent(sessionStateNoticeText(params.targetSessionKey, params.lastSeenSequence), {
    sessionKey: params.watcherSessionKey,
    contextKey: `${SESSION_STATE_CONTEXT_PREFIX}${encodeNoticeTarget(params.targetSessionKey)}`,
    ...(params.queueOnly ? { replace: true } : {}),
  });
  // Group activity is ambient context. Coalesce it for the next main turn instead
  // of waking the personal agent once per inbound group message.
  if (params.queueOnly) {
    return;
  }
  if (!shouldWakeWatcher(params.watcherSessionKey)) {
    return;
  }
  // intent "immediate": event-intent wakes defer on heartbeat dueness, which would
  // delay stale-state notices by up to the whole heartbeat interval. Task/cron
  // wake-now paths use the same class; the flood guard remains the backstop.
  requestHeartbeat({
    source: "session-state",
    intent: "immediate",
    reason: `session-state:${params.targetSessionKey}`,
    sessionKey: params.watcherSessionKey,
  });
}
