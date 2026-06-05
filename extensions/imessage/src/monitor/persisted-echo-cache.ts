// Imessage plugin module implements persisted echo cache behavior.
import { createHash } from "node:crypto";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getIMessageRuntime } from "../runtime.js";

type PersistedEchoEntry = {
  scope: string;
  text?: string;
  messageId?: string;
  timestamp: number;
};

// 12h covers the maximum `channels.imessage.catchup.maxAgeMinutes` clamp (720
// minutes). Without this, the live path's previous 2-minute window was
// shorter than any realistic catchup window — own outbound rows from before
// a gateway gap would fall out of the dedupe set before catchup could replay
// the inbound rows around them, and the agent's own messages would land back
// in the inbound pipeline as if they were external sends.
export const IMESSAGE_SENT_ECHOES_TTL_MS = 12 * 60 * 60 * 1000;
export const IMESSAGE_SENT_ECHOES_NAMESPACE = "imessage.sent-echoes";
export const IMESSAGE_SENT_ECHOES_MAX_ENTRIES = 256;

type PersistedEchoStore = PluginStateSyncKeyedStore<PersistedEchoEntry>;

function normalizeText(text: string | undefined): string | undefined {
  const normalized = text?.replace(/\r\n?/g, "\n").trim();
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

function loadMirrorFromStore(): void {
  try {
    const cutoff = Date.now() - IMESSAGE_SENT_ECHOES_TTL_MS;
    mirror = openPersistedEchoStore()
      .entries()
      .map(({ value }) => value)
      .filter((entry) => entry.timestamp >= cutoff)
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

function persistEntry(entry: PersistedEchoEntry): void {
  const ttlMs = remainingTtlMs(entry.timestamp);
  if (!ttlMs) {
    return;
  }
  try {
    openPersistedEchoStore().register(resolveIMessageSentEchoEntryKey(entry), entry, { ttlMs });
  } catch (err) {
    reportFailure("write", err);
  }
}

export function rememberPersistedIMessageEcho(params: {
  scope: string;
  text?: string;
  messageId?: string;
}): void {
  const text = normalizeText(params.text);
  const messageId = normalizeMessageId(params.messageId);
  const entry: PersistedEchoEntry = {
    scope: params.scope,
    timestamp: Date.now(),
    ...(text ? { text } : {}),
    ...(messageId ? { messageId } : {}),
  };
  if (!entry.text && !entry.messageId) {
    return;
  }
  loadMirrorFromStore();
  persistEntry(entry);
  const cutoff = Date.now() - IMESSAGE_SENT_ECHOES_TTL_MS;
  mirror = [...(mirror ?? []), entry]
    .filter((candidate) => candidate.timestamp >= cutoff)
    .slice(-IMESSAGE_SENT_ECHOES_MAX_ENTRIES);
}

export function hasPersistedIMessageEcho(params: {
  scope: string;
  text?: string;
  messageId?: string;
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
    if (text && entry.text === text) {
      return true;
    }
  }
  return false;
}

export function resetPersistedIMessageEchoCacheForTest(
  options: { clearPersistent?: boolean } = {},
): void {
  mirror = null;
  persistenceFailureLogged = false;
  if (options.clearPersistent === false) {
    return;
  }
  try {
    openPersistedEchoStore().clear();
  } catch {
    // best-effort
  }
}
