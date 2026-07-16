// Imessage plugin module implements persisted echo cache behavior.
import { createHash } from "node:crypto";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getIMessageRuntime } from "../runtime.js";
import { stripLeadingEchoTextCorruptionMarkers } from "./echo-text-corruption.js";

type PersistedEchoEntry = {
  scope: string;
  text?: string;
  messageId?: string;
  timestamp: number;
  expiresAt?: number;
  pending?: true;
};

// 12h comfortably outlives the inbound replay guard window
// (IMESSAGE_INBOUND_DEDUPE_TTL_MS) so an own-outbound row that imsg re-emits
// after a bridge reconnect is still recognized as the agent's own echo rather
// than re-ingested as an external send. A shorter window would let own rows
// fall out of the dedupe set before a reconnect burst replays the messages
// around them.
export const IMESSAGE_SENT_ECHOES_TTL_MS = 12 * 60 * 60 * 1000;
export const IMESSAGE_SENT_ECHOES_NAMESPACE = "imessage.sent-echoes";
export const IMESSAGE_SENT_ECHOES_MAX_ENTRIES = 256;

type PersistedEchoStore = PluginStateSyncKeyedStore<PersistedEchoEntry>;

function normalizeText(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  // Match the in-memory echo-cache key so a reflected echo with a leading attributedBody
  // corruption marker still matches the clean stored send (the persisted sibling of #93511).
  const normalized = stripLeadingEchoTextCorruptionMarkers(
    text.replace(/\r\n?/g, "\n").trim(),
  ).trim();
  return normalized || undefined;
}

function normalizeMessageId(messageId: string | undefined): string | undefined {
  const normalized = messageId?.trim();
  if (!normalized || normalized === "ok" || normalized === "unknown") {
    return undefined;
  }
  return normalized;
}

let mirror: PersistedEchoEntry[] | null = null;
let persistenceFailureLogged = false;
function reportFailure(scope: string, err: unknown): void {
  if (persistenceFailureLogged) {
    return;
  }
  persistenceFailureLogged = true;
  logVerbose(`imessage echo-cache: ${scope} disabled after first failure: ${String(err)}`);
}

export function resolveIMessageSentEchoEntryKey(entry: PersistedEchoEntry): string {
  return createHash("sha256")
    .update(JSON.stringify([entry.scope, entry.text ?? "", entry.messageId ?? "", entry.timestamp]))
    .digest("hex")
    .slice(0, 32);
}

function openPersistedEchoStore(): PersistedEchoStore {
  return getIMessageRuntime().state.openSyncKeyedStore<PersistedEchoEntry>({
    namespace: IMESSAGE_SENT_ECHOES_NAMESPACE,
    maxEntries: IMESSAGE_SENT_ECHOES_MAX_ENTRIES,
  });
}

function remainingTtlMs(timestamp: number): number | undefined {
  const remaining = IMESSAGE_SENT_ECHOES_TTL_MS - Math.max(0, Date.now() - timestamp);
  return remaining > 0 ? remaining : undefined;
}

function resolveEntryTtlMs(entry: PersistedEchoEntry, ttlMs?: number): number | undefined {
  if (typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0) {
    return ttlMs;
  }
  return remainingTtlMs(entry.timestamp);
}

function isLiveEntry(entry: PersistedEchoEntry, now = Date.now()): boolean {
  const cutoff = now - IMESSAGE_SENT_ECHOES_TTL_MS;
  return entry.timestamp >= cutoff && (entry.expiresAt == null || entry.expiresAt > now);
}

function loadMirrorFromStore(): void {
  try {
    mirror = openPersistedEchoStore()
      .entries()
      .map(({ value }) => value)
      .filter((entry) => isLiveEntry(entry))
      .toSorted((a, b) => a.timestamp - b.timestamp)
      .slice(-IMESSAGE_SENT_ECHOES_MAX_ENTRIES);
  } catch (err) {
    reportFailure("read", err);
    mirror = [];
  }
}

function readRecentEntries(): PersistedEchoEntry[] {
  loadMirrorFromStore();
  return mirror ?? [];
}

function persistEntry(entry: PersistedEchoEntry, ttlMs?: number): string | undefined {
  const effectiveTtlMs = resolveEntryTtlMs(entry, ttlMs);
  if (!effectiveTtlMs) {
    return undefined;
  }
  const key = resolveIMessageSentEchoEntryKey(entry);
  try {
    openPersistedEchoStore().register(key, entry, {
      ttlMs: effectiveTtlMs,
    });
  } catch (err) {
    reportFailure("write", err);
    return undefined;
  }
  return key;
}

export function rememberPersistedIMessageEcho(params: {
  scope: string;
  text?: string;
  messageId?: string;
  ttlMs?: number;
  pending?: boolean;
}): string | undefined {
  const text = normalizeText(params.text);
  const messageId = normalizeMessageId(params.messageId);
  const entry: PersistedEchoEntry = {
    scope: params.scope,
    timestamp: Date.now(),
    ...(text ? { text } : {}),
    ...(messageId ? { messageId } : {}),
    ...(params.pending ? { pending: true } : {}),
  };
  if (typeof params.ttlMs === "number" && Number.isFinite(params.ttlMs) && params.ttlMs > 0) {
    entry.expiresAt = entry.timestamp + params.ttlMs;
  }
  if (!entry.text && !entry.messageId) {
    return undefined;
  }
  loadMirrorFromStore();
  const key = persistEntry(entry, params.ttlMs);
  mirror = [...(mirror ?? []), entry]
    .filter((candidate) => isLiveEntry(candidate))
    .slice(-IMESSAGE_SENT_ECHOES_MAX_ENTRIES);
  return key;
}

export function forgetPersistedIMessageEchoKey(key: string | undefined): void {
  if (!key) {
    return;
  }
  try {
    openPersistedEchoStore().delete(key);
  } catch (err) {
    reportFailure("delete", err);
  }
  mirror = (mirror ?? []).filter((entry) => resolveIMessageSentEchoEntryKey(entry) !== key);
}

export function hasPersistedIMessageEcho(params: {
  scope: string;
  text?: string;
  messageId?: string;
  includePendingText?: boolean;
}): boolean {
  const text = normalizeText(params.text);
  const messageId = normalizeMessageId(params.messageId);
  if (!text && !messageId) {
    return false;
  }
  for (const entry of readRecentEntries()) {
    if (entry.scope !== params.scope) {
      continue;
    }
    if (messageId && entry.messageId === messageId) {
      return true;
    }
    if (text && entry.text === text && (!entry.pending || params.includePendingText)) {
      return true;
    }
  }
  return false;
}
