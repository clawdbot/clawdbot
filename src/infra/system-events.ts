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

export type SystemEvent = {
  text: string;
  ts: number;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
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
  /** Replace the pending event for this context and delivery route. Requires contextKey. */
  replace?: boolean;
};

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
): boolean {
  const incoming = { text, contextKey, deliveryContext };
  if (contextKey === null) {
    const last = queue[queue.length - 1];
    return last ? isDuplicateSystemEvent(last, incoming) : false;
  }
  return queue.some((event) => isDuplicateSystemEvent(event, incoming));
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
  // These entries are rendered as `System:` lines, so strip nested system-marker
  // spoofs at the queue boundary before any plugin/channel text reaches a prompt.
  const cleaned = sanitizeInboundSystemTags(text).trim();
  if (!cleaned) {
    return null;
  }
  const normalizedContextKey = normalizeContextKey(options.contextKey);
  const normalizedDeliveryContext = normalizeDeliveryContext(options.deliveryContext);
  if (findDuplicateInQueue(entry.queue, cleaned, normalizedContextKey, normalizedDeliveryContext)) {
    return null;
  }
  if (normalizedContextKey !== null) {
    entry.lastContextKey = normalizedContextKey;
  }
  const event: SystemEvent = {
    text: cleaned,
    ts: Date.now(),
    contextKey: normalizedContextKey,
    deliveryContext: normalizedDeliveryContext,
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
  const cleaned = sanitizeInboundSystemTags(text).trim();
  if (!cleaned) {
    return null;
  }
  const normalizedContextKey = normalizeContextKey(options.contextKey);
  if (normalizedContextKey === null) {
    throw new Error("replaced system events require a contextKey");
  }
  const normalizedDeliveryContext = normalizeDeliveryContext(options.deliveryContext);
  const matching = entry.queue.filter(
    (event) =>
      (event.contextKey ?? null) === normalizedContextKey &&
      areDeliveryContextsEqual(event.deliveryContext, normalizedDeliveryContext),
  );
  if (matching.length === 1 && matching[0]?.text === cleaned) {
    return null;
  }

  // One keyed source owns one queue slot. Moving a replacement to the end keeps
  // event ordering current without allowing repeated updates to evict other sources.
  entry.queue = entry.queue.filter(
    (event) =>
      (event.contextKey ?? null) !== normalizedContextKey ||
      !areDeliveryContextsEqual(event.deliveryContext, normalizedDeliveryContext),
  );
  const event: SystemEvent = {
    text: cleaned,
    ts: Date.now(),
    contextKey: normalizedContextKey,
    deliveryContext: normalizedDeliveryContext,
  };
  entry.queue.push(event);
  if (entry.queue.length > MAX_EVENTS) {
    entry.queue.shift();
  }
  entry.lastContextKey = normalizedContextKey;
  return cloneSystemEvent(event);
}

function isDuplicateSystemEvent(
  existing: SystemEvent,
  incoming: Pick<SystemEvent, "text" | "contextKey" | "deliveryContext">,
): boolean {
  return (
    existing.text === incoming.text &&
    (existing.contextKey ?? null) === (incoming.contextKey ?? null) &&
    areDeliveryContextsEqual(existing.deliveryContext, incoming.deliveryContext)
  );
}

function areSystemEventsEqual(left: SystemEvent, right: SystemEvent): boolean {
  return (
    left.text === right.text &&
    left.ts === right.ts &&
    (left.contextKey ?? null) === (right.contextKey ?? null) &&
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
