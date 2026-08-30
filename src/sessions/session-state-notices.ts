/** Stale-state notice text, coalescing keys, and watcher eligibility. */
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { isSubagentSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import type { SessionStateWatchTarget } from "./session-watch-target.js";

const SESSION_STATE_CONTEXT_PREFIX = "session-state:";
const SESSION_STATE_WAKE_COALESCE_MS = 20_000;

function encodeNoticeTarget(sessionKey: string): string {
  return Buffer.from(sessionKey, "utf8").toString("hex");
}

function encodeNoticeTargetWithAgent(target: SessionStateWatchTarget): string {
  return Buffer.from(JSON.stringify([target.agentId, target.sessionKey]), "utf8").toString("hex");
}

export function decodeSessionStateNoticeTarget(
  contextKey: string,
): SessionStateWatchTarget | undefined {
  const sessionKey = decodeSessionStateNoticeContextKey(contextKey);
  if (sessionKey !== undefined) {
    const agentId = parseAgentSessionKey(sessionKey)?.agentId;
    if (agentId) {
      return { agentId, sessionKey };
    }
  }
  if (!contextKey.startsWith(SESSION_STATE_CONTEXT_PREFIX)) {
    return undefined;
  }
  const encoded = contextKey.slice(SESSION_STATE_CONTEXT_PREFIX.length);
  try {
    const decoded: unknown = JSON.parse(Buffer.from(encoded, "hex").toString("utf8"));
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== "string" ||
      typeof decoded[1] !== "string" ||
      !decoded[0] ||
      !decoded[1]
    ) {
      return undefined;
    }
    return { agentId: decoded[0], sessionKey: decoded[1] };
  } catch {
    return undefined;
  }
}

export function decodeSessionStateNoticeContextKey(contextKey: string): string | undefined {
  if (!contextKey.startsWith(SESSION_STATE_CONTEXT_PREFIX)) {
    return undefined;
  }
  const encoded = contextKey.slice(SESSION_STATE_CONTEXT_PREFIX.length);
  if (!encoded || encoded.length % 2 !== 0 || !/^[0-9a-f]+$/.test(encoded)) {
    return undefined;
  }
  // encodeNoticeTarget always writes the hex of a valid UTF-8 session key, so a
  // payload that fails strict UTF-8 decoding is corrupt: fail closed instead of
  // letting U+FFFD collisions acknowledge an unrelated watcher cursor.
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.from(encoded, "hex"),
    );
  } catch {
    return undefined;
  }
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
  targetAgentId?: string;
  lastSeenSequence: number;
  queueOnly?: boolean;
}): void {
  enqueueSystemEvent(sessionStateNoticeText(params.targetSessionKey, params.lastSeenSequence), {
    sessionKey: params.watcherSessionKey,
    contextKey: `${SESSION_STATE_CONTEXT_PREFIX}${
      !params.targetAgentId ||
      parseAgentSessionKey(params.targetSessionKey)?.agentId === params.targetAgentId
        ? encodeNoticeTarget(params.targetSessionKey)
        : encodeNoticeTargetWithAgent({
            agentId: params.targetAgentId,
            sessionKey: params.targetSessionKey,
          })
    }`,
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
  // Collapse bursts of watched-session changes into one main-session wake. Notices
  // are already queued and deduped, so none are lost; 20 seconds bounds added latency.
  requestHeartbeat({
    source: "session-state",
    intent: "immediate",
    reason: `session-state:${params.targetSessionKey}`,
    sessionKey: params.watcherSessionKey,
    coalesceMs: SESSION_STATE_WAKE_COALESCE_MS,
  });
}
