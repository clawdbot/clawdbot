import fs from "node:fs";
import path from "node:path";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

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
const PERSISTED_ECHO_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_PERSISTED_ECHO_ENTRIES = 256;

// sent-echoes.jsonl carries scope keys + outbound message text + messageIds.
// A hostile same-UID process could otherwise (a) read the file to enumerate
// active conversations and outbound content, or (b) inject lines so a future
// inbound dedupe call wrongly suppresses a legitimate inbound message. Owner-
// only mode on both the directory and file closes that vector — defaults are
// 0755/0644 which are world-readable on a multi-user Mac.
const PERSISTED_ECHO_DIR_MODE = 0o700;
const PERSISTED_ECHO_FILE_MODE = 0o600;

function resolvePersistedEchoPath(): string {
  return path.join(resolveStateDir(), "imessage", "sent-echoes.jsonl");
}

function clampPersistedEchoModes(filePath: string): void {
  // mkdirSync's mode is masked by umask and only applies on creation. If the
  // dir or file already exists from an older gateway version, clamp now.
  try {
    fs.chmodSync(path.dirname(filePath), PERSISTED_ECHO_DIR_MODE);
    fs.chmodSync(filePath, PERSISTED_ECHO_FILE_MODE);
  } catch {
    // best-effort — fs may not support chmod on every platform
  }
}

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

function parseEntry(line: string): PersistedEchoEntry | null {
  try {
    const parsed = JSON.parse(line) as Partial<PersistedEchoEntry>;
    if (typeof parsed.scope !== "string" || typeof parsed.timestamp !== "number") {
      return null;
    }
    return {
      scope: parsed.scope,
      text: typeof parsed.text === "string" ? parsed.text : undefined,
      messageId: typeof parsed.messageId === "string" ? parsed.messageId : undefined,
      timestamp: parsed.timestamp,
    };
  } catch {
    return null;
  }
}

// In-memory mirror of the persisted file. The echo cache is consulted on
// every inbound message; without a cache, group-chat bursts trigger a
// readFileSync + JSON.parse for every member's reply. The mirror is
// invalidated by file mtime so concurrent gateway processes (rare) and
// post-restart hydrate still see fresh data.
let mirror: { entries: PersistedEchoEntry[]; mtimeMs: number } | null = null;
let persistenceFailureLogged = false;
function reportFailure(scope: string, err: unknown): void {
  if (persistenceFailureLogged) {
    return;
  }
  persistenceFailureLogged = true;
  logVerbose(`imessage echo-cache: ${scope} disabled after first failure: ${String(err)}`);
}

function loadMirrorIfStale(): void {
  const filePath = resolvePersistedEchoPath();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      reportFailure("stat", err);
    }
    mirror = { entries: [], mtimeMs: 0 };
    return;
  }
  if (mirror && mirror.mtimeMs === mtimeMs) {
    return;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    reportFailure("read", err);
    mirror = { entries: [], mtimeMs };
    return;
  }
  const cutoff = Date.now() - PERSISTED_ECHO_TTL_MS;
  const entries = raw
    .split(/\n+/)
    .map(parseEntry)
    .filter((entry): entry is PersistedEchoEntry => Boolean(entry && entry.timestamp >= cutoff))
    .slice(-MAX_PERSISTED_ECHO_ENTRIES);
  mirror = { entries, mtimeMs };
}

function readRecentEntries(): PersistedEchoEntry[] {
  loadMirrorIfStale();
  return mirror?.entries ?? [];
}

// Trigger compaction once the on-disk file grows past 2x the cap or holds
// stale entries beyond the TTL window. Until then, every remember is an
// O(1) append rather than a full rewrite — group-chat bursts that send 5+
// outbound messages back-to-back used to write the entire file 5+ times.
const COMPACT_AT_ENTRY_COUNT = MAX_PERSISTED_ECHO_ENTRIES * 2;

function compactRecentEntries(entries: PersistedEchoEntry[]): void {
  const filePath = resolvePersistedEchoPath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: PERSISTED_ECHO_DIR_MODE });
    fs.writeFileSync(
      filePath,
      entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""),
      { encoding: "utf8", mode: PERSISTED_ECHO_FILE_MODE },
    );
    clampPersistedEchoModes(filePath);
  } catch (err) {
    reportFailure("compact", err);
    // Persistence failed; don't update the in-memory mirror so the next
    // read still reflects what's actually on disk.
    return;
  }
  // Update mirror to reflect what we just wrote, so the next has() call
  // doesn't re-read the file we just authored.
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    // ignore — stale mirror will refresh on next access
  }
  mirror = { entries: [...entries], mtimeMs };
}

function appendEntry(entry: PersistedEchoEntry): void {
  const filePath = resolvePersistedEchoPath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: PERSISTED_ECHO_DIR_MODE });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      mode: PERSISTED_ECHO_FILE_MODE,
    });
    // Always clamp — appendFileSync's `mode` only applies on creation, and
    // an older gateway version may have left an existing 0644 file behind.
    // chmod is microseconds; doing it every append keeps the security
    // guarantee monotonic instead of conditional on creation order.
    clampPersistedEchoModes(filePath);
  } catch (err) {
    reportFailure("append", err);
    return;
  }
  // Mirror stays in sync without re-reading the file: append our entry to
  // the in-memory copy and bump the mtime to whatever the FS reports now.
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    // ignore
  }
  if (mirror) {
    mirror = { entries: [...mirror.entries, entry], mtimeMs };
  } else {
    mirror = { entries: [entry], mtimeMs };
  }
}

export function rememberPersistedIMessageEcho(params: {
  scope: string;
  text?: string;
  messageId?: string;
}): void {
  const entry: PersistedEchoEntry = {
    scope: params.scope,
    text: normalizeText(params.text),
    messageId: normalizeMessageId(params.messageId),
    timestamp: Date.now(),
  };
  if (!entry.text && !entry.messageId) {
    return;
  }
  // Make sure the mirror reflects whatever's on disk before we decide
  // whether a compaction is due.
  loadMirrorIfStale();
  appendEntry(entry);
  const total = mirror?.entries.length ?? 0;
  const cutoff = Date.now() - PERSISTED_ECHO_TTL_MS;
  const oldestStale = mirror?.entries[0] && mirror.entries[0].timestamp < cutoff;
  if (total > COMPACT_AT_ENTRY_COUNT || oldestStale) {
    const fresh = (mirror?.entries ?? []).filter((e) => e.timestamp >= cutoff);
    compactRecentEntries(fresh.slice(-MAX_PERSISTED_ECHO_ENTRIES));
  }
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
