// "RFC §" references herein cite docs/design/continue-work-signal-v2.md (Agent Self-Elected Turn Continuation / CONTINUE_WORK).
// Lightweight in-memory queue for human-readable system events that should be
// prefixed to the next prompt. We intentionally avoid persistence to keep
// events ephemeral. Events are session-scoped and require an explicit key.

import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { channelRouteDedupeKey } from "../plugin-sdk/channel-route.js";
import { sanitizeInboundSystemTags } from "../security/system-tags.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import {
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { normalizeDiagnosticTraceparent } from "./diagnostic-trace-context.js";

export type SystemEvent = {
  text: string;
  ts: number;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  sessionDeliveryAckId?: string;
  sessionDeliveryAckStateDir?: string;
  /**
   * W3C `traceparent` captured at enqueue-time so the substrate-queue drain can
   * reconstruct the producer trace at announce/deliver time. Per RFC §6.7 the
   * substrate queue is an asynchronous boundary (enqueue turn != drain turn,
   * possibly across a gateway restart), so trace context rides on the payload
   * itself rather than on a runtime ambient. Optional and additive — invalid
   * traceparent values are silently dropped at enqueue-time so producers never
   * fail-the-write on a malformed header.
   */
  traceparent?: string;
};

const MAX_EVENTS = 20;

type SessionQueue = {
  queue: SystemEvent[];
  lastContextKey: string | null;
};

const SYSTEM_EVENT_QUEUES_KEY = Symbol.for("openclaw.systemEvents.queues");

const queues = resolveGlobalMap<string, SessionQueue>(SYSTEM_EVENT_QUEUES_KEY);

type SystemEventOptions = {
  sessionKey: string;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  sessionDeliveryAckId?: string;
  sessionDeliveryAckStateDir?: string;
  /**
   * @deprecated Legacy untrusted-producer downgrade flag, re-exported via the
   * the `plugin-sdk/system-event-runtime` subpath.
   * Accepted-and-ignored for installed third-party channel plugins that still
   * pass it: the anti-spoof sanitizer is now unconditional for untrusted
   * producers (sanitize-by-default), so this flag has no runtime effect. Kept
   * until a named SDK removal window.
   */
  forceSenderIsOwnerFalse?: boolean;
  /**
   * Trusted-internal enrichment marker (continuation/OCR/transcripts). When
   * `true`, the payload is trusted core data that may legitimately contain
   * `System:`/`[System]` examples (subagent returns, post-compaction context,
   * AGENTS.md text), so it bypasses the inbound anti-spoof sanitizer and is
   * preserved verbatim. Untrusted producers (plugin/channel text) omit this
   * flag and are sanitized at the queue boundary.
   */
  trusted?: boolean;
  /**
   * Optional W3C `traceparent` to attach to the queued event for cross-boundary
   * trace correlation. Invalid values are silently dropped (additive contract:
   * a malformed traceparent never prevents an enqueue).
   */
  traceparent?: string;
  /** Replace the pending event for this context and delivery route. Requires contextKey. */
  replace?: boolean;
};

function normalizeTraceparent(traceparent?: string): string | undefined {
  return normalizeDiagnosticTraceparent(traceparent);
}

function requireSessionKey(key?: string | null): string {
  const trimmed = normalizeOptionalString(key) ?? "";
  if (!trimmed) {
    throw new Error("system events require a sessionKey");
  }
  return trimmed;
}

function normalizeContextKey(key?: string | null): string | null {
  return normalizeOptionalLowercaseString(key) ?? null;
}

function getSessionQueue(sessionKey: string): SessionQueue | undefined {
  return queues.get(requireSessionKey(sessionKey));
}

function getOrCreateSessionQueue(sessionKey: string): SessionQueue {
  const key = requireSessionKey(sessionKey);
  const existing = queues.get(key);
  if (existing) {
    return existing;
  }
  const created: SessionQueue = {
    queue: [],
    lastContextKey: null,
  };
  queues.set(key, created);
  return created;
}

function cloneSystemEvent(event: SystemEvent): SystemEvent {
  return {
    ...event,
    ...(event.deliveryContext ? { deliveryContext: { ...event.deliveryContext } } : {}),
  };
}

export function isSystemEventContextChanged(
  sessionKey: string,
  contextKey?: string | null,
): boolean {
  const existing = getSessionQueue(sessionKey);
  const normalized = normalizeContextKey(contextKey);
  return normalized !== (existing?.lastContextKey ?? null);
}

function findDuplicateInQueue(
  queue: readonly SystemEvent[],
  text: string,
  contextKey: string | null,
  deliveryContext: DeliveryContext | undefined,
  sessionDeliveryAckId: string | undefined,
  sessionDeliveryAckStateDir: string | undefined,
): boolean {
  const incoming = {
    text,
    contextKey,
    deliveryContext,
    sessionDeliveryAckId,
    sessionDeliveryAckStateDir,
  };
  if (contextKey === null) {
    const last = queue[queue.length - 1];
    return last ? isDuplicateSystemEvent(last, incoming) : false;
  }
  return queue.some((event) => isDuplicateSystemEvent(event, incoming));
}

function applyContextKeyPolicy(entry: SessionQueue, incomingContextKey: string | null): void {
  if (incomingContextKey !== null) {
    entry.lastContextKey = incomingContextKey;
  }
}

export function enqueueSystemEventEntry(
  text: string,
  options: SystemEventOptions,
): SystemEvent | null {
  if (options.replace) {
    return replaceSystemEventEntry(text, options);
  }
  const key = requireSessionKey(options.sessionKey);
  const entry = getOrCreateSessionQueue(key);
  // Untrusted producers (plugin/channel text) are rendered as `System:` lines, so
  // strip nested system-marker spoofs at the queue boundary before any such text
  // reaches a prompt. Trusted-internal producers (tagged `trusted: true`) carry
  // workspace/subagent data that may legitimately contain those markers and are
  // preserved verbatim.
  const cleaned = (options.trusted === true ? text : sanitizeInboundSystemTags(text)).trim();
  if (!cleaned) {
    return null;
  }
  const normalizedContextKey = normalizeContextKey(options.contextKey);
  const normalizedDeliveryContext = normalizeDeliveryContext(options.deliveryContext);
  if (
    findDuplicateInQueue(
      entry.queue,
      cleaned,
      normalizedContextKey,
      normalizedDeliveryContext,
      options.sessionDeliveryAckId,
      options.sessionDeliveryAckStateDir,
    )
  ) {
    return null;
  } // skip consecutive duplicates
  const normalizedTraceparent = normalizeTraceparent(options?.traceparent);
  applyContextKeyPolicy(entry, normalizedContextKey);
  const event: SystemEvent = {
    text: cleaned,
    ts: Date.now(),
    contextKey: normalizedContextKey,
    deliveryContext: normalizedDeliveryContext,
    ...(options.sessionDeliveryAckId ? { sessionDeliveryAckId: options.sessionDeliveryAckId } : {}),
    ...(options.sessionDeliveryAckStateDir
      ? { sessionDeliveryAckStateDir: options.sessionDeliveryAckStateDir }
      : {}),
    ...(normalizedTraceparent ? { traceparent: normalizedTraceparent } : {}),
  };
  entry.queue.push(event);
  if (entry.queue.length > MAX_EVENTS) {
    entry.queue.shift();
  }
  return cloneSystemEvent(event);
}

export function enqueueSystemEvent(text: string, options: SystemEventOptions) {
  return enqueueSystemEventEntry(text, options) !== null;
}

export function drainSystemEventEntries(sessionKey: string): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = getSessionQueue(key);
  if (!entry || entry.queue.length === 0) {
    return [];
  }
  const out = entry.queue.map(cloneSystemEvent);
  entry.queue.length = 0;
  entry.lastContextKey = null;
  queues.delete(key);
  return out;
}

function areDeliveryContextsEqual(left?: DeliveryContext, right?: DeliveryContext): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return channelRouteDedupeKey(left) === channelRouteDedupeKey(right);
}

function replaceSystemEventEntry(text: string, options: SystemEventOptions): SystemEvent | null {
  const key = requireSessionKey(options.sessionKey);
  const entry = getOrCreateSessionQueue(key);
  const cleaned = (options.trusted === true ? text : sanitizeInboundSystemTags(text)).trim();
  if (!cleaned) {
    return null;
  }
  const normalizedContextKey = normalizeContextKey(options.contextKey);
  if (normalizedContextKey === null) {
    throw new Error("replaced system events require a contextKey");
  }
  const normalizedDeliveryContext = normalizeDeliveryContext(options.deliveryContext);
  const normalizedTraceparent = normalizeTraceparent(options.traceparent);
  const replacement: SystemEvent = {
    text: cleaned,
    ts: Date.now(),
    contextKey: normalizedContextKey,
    deliveryContext: normalizedDeliveryContext,
    ...(options.sessionDeliveryAckId ? { sessionDeliveryAckId: options.sessionDeliveryAckId } : {}),
    ...(options.sessionDeliveryAckStateDir
      ? { sessionDeliveryAckStateDir: options.sessionDeliveryAckStateDir }
      : {}),
    ...(normalizedTraceparent ? { traceparent: normalizedTraceparent } : {}),
  };
  const matching = entry.queue.filter(
    (event) =>
      (event.contextKey ?? null) === normalizedContextKey &&
      areDeliveryContextsEqual(event.deliveryContext, normalizedDeliveryContext),
  );
  if (
    matching.length === 1 &&
    matching[0]?.text === replacement.text &&
    matching[0]?.sessionDeliveryAckId === replacement.sessionDeliveryAckId &&
    matching[0]?.sessionDeliveryAckStateDir === replacement.sessionDeliveryAckStateDir &&
    matching[0]?.traceparent === replacement.traceparent
  ) {
    return null;
  }

  // One keyed source owns one queue slot. Moving a replacement to the end keeps
  // event ordering current without allowing repeated updates to evict other sources.
  entry.queue = entry.queue.filter(
    (event) =>
      (event.contextKey ?? null) !== normalizedContextKey ||
      !areDeliveryContextsEqual(event.deliveryContext, normalizedDeliveryContext),
  );
  entry.queue.push(replacement);
  if (entry.queue.length > MAX_EVENTS) {
    entry.queue.shift();
  }
  entry.lastContextKey = normalizedContextKey;
  return cloneSystemEvent(replacement);
}

function isDuplicateSystemEvent(
  existing: SystemEvent,
  incoming: Pick<
    SystemEvent,
    | "text"
    | "contextKey"
    | "deliveryContext"
    | "sessionDeliveryAckId"
    | "sessionDeliveryAckStateDir"
  >,
): boolean {
  return (
    existing.text === incoming.text &&
    (existing.contextKey ?? null) === (incoming.contextKey ?? null) &&
    existing.sessionDeliveryAckId === incoming.sessionDeliveryAckId &&
    existing.sessionDeliveryAckStateDir === incoming.sessionDeliveryAckStateDir &&
    areDeliveryContextsEqual(existing.deliveryContext, incoming.deliveryContext)
  );
}

function areSystemEventsEqual(left: SystemEvent, right: SystemEvent): boolean {
  return (
    left.text === right.text &&
    left.ts === right.ts &&
    (left.contextKey ?? null) === (right.contextKey ?? null) &&
    left.sessionDeliveryAckId === right.sessionDeliveryAckId &&
    left.sessionDeliveryAckStateDir === right.sessionDeliveryAckStateDir &&
    (left.traceparent ?? undefined) === (right.traceparent ?? undefined) &&
    areDeliveryContextsEqual(left.deliveryContext, right.deliveryContext)
  );
}

function resetQueueState(key: string, entry: SessionQueue) {
  if (entry.queue.length === 0) {
    entry.lastContextKey = null;
    queues.delete(key);
    return;
  }
  for (let index = entry.queue.length - 1; index >= 0; index -= 1) {
    const contextKey = expectDefined(entry.queue[index], "queue entry at index").contextKey ?? null;
    if (contextKey !== null) {
      entry.lastContextKey = contextKey;
      return;
    }
  }
  entry.lastContextKey = null;
}

export function consumeSystemEventEntries(
  sessionKey: string,
  consumedEntries: readonly SystemEvent[],
): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = getSessionQueue(key);
  if (!entry || entry.queue.length === 0 || consumedEntries.length === 0) {
    return [];
  }
  if (
    consumedEntries.length > entry.queue.length ||
    !consumedEntries.every((event, index) =>
      areSystemEventsEqual(expectDefined(entry.queue[index], "queue entry at index"), event),
    )
  ) {
    // A keyed replacement may remove one inspected entry while a prompt is in flight.
    // Consume the unchanged inspected entries so unrelated work is not replayed,
    // while leaving the replacement and all newly queued entries intact.
    return consumeSelectedSystemEventEntries(key, consumedEntries);
  }
  const removed = entry.queue.splice(0, consumedEntries.length).map(cloneSystemEvent);
  resetQueueState(key, entry);
  return removed;
}

export function consumeSelectedSystemEventEntries(
  sessionKey: string,
  consumedEntries: readonly SystemEvent[],
): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = getSessionQueue(key);
  if (!entry || entry.queue.length === 0 || consumedEntries.length === 0) {
    return [];
  }
  const removed: SystemEvent[] = [];
  for (const consumed of consumedEntries) {
    const index = entry.queue.findIndex((event) => areSystemEventsEqual(event, consumed));
    if (index === -1) {
      continue;
    }
    const [event] = entry.queue.splice(index, 1);
    if (event) {
      removed.push(cloneSystemEvent(event));
    }
  }
  resetQueueState(key, entry);
  return removed;
}

export function drainSystemEvents(sessionKey: string): string[] {
  return drainSystemEventEntries(sessionKey).map((event) => event.text);
}

/**
 * Remove system events matching a predicate without draining the entire queue.
 * Returns the removed events; non-matching events stay queued.
 */
export function removeSystemEvents(
  sessionKey: string,
  predicate: (event: SystemEvent) => boolean,
): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = queues.get(key);
  if (!entry || entry.queue.length === 0) {
    return [];
  }
  const removed: SystemEvent[] = [];
  entry.queue = entry.queue.filter((event) => {
    if (predicate(event)) {
      removed.push(event);
      return false;
    }
    return true;
  });
  if (removed.length > 0) {
    // Reset dedup state to reflect actual queue contents. `resetQueueState`
    // deletes the now-empty queue, or restores `lastContextKey` to the last
    // *non-null* contextKey (matching `applyContextKeyPolicy`'s enqueue policy),
    // rather than naively taking the final event's key — which would wipe a
    // still-valid key when the last remaining event has `contextKey: null`.
    resetQueueState(key, entry);
  }
  return removed;
}

export function peekSystemEventEntries(sessionKey: string): SystemEvent[] {
  return getSessionQueue(sessionKey)?.queue.map(cloneSystemEvent) ?? [];
}

export function peekSystemEvents(sessionKey: string): string[] {
  return peekSystemEventEntries(sessionKey).map((event) => event.text);
}

export function hasSystemEvents(sessionKey: string) {
  return (getSessionQueue(sessionKey)?.queue.length ?? 0) > 0;
}

export function resolveSystemEventDeliveryContext(
  events: readonly SystemEvent[],
): DeliveryContext | undefined {
  let resolved: DeliveryContext | undefined;
  for (const event of events) {
    resolved = mergeDeliveryContext(event.deliveryContext, resolved);
  }
  return resolved;
}

export function resetSystemEventsForTest() {
  queues.clear();
}
