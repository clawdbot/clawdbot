/**
 * AI-generated purpose titles for complex tool calls.
 *
 * The store is process-global and keyed by a digest of tool name + args, so a
 * title generated once (or served from the gateway cache) applies to every
 * render of the same call. Fetching is debounced and best-effort: when no
 * utility model or Luna default is usable, rows keep their deterministic
 * labels.
 */

import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { resolveToolCallKind, unwrapShellWrapperCommand } from "../../lib/chat/tool-call-view.ts";
import { fnv1aUtf16 } from "../../lib/fnv1a.ts";

const MAX_TITLE_INPUT_CHARS = 2_000;
const MAX_ITEMS_PER_REQUEST = 24;
// Titles/failures retain only small digests and strings. Queue caps additionally
// bound raw tool input to below 400k UTF-16 code units across split panes.
const MAX_CACHED_TITLES = 500;
const MAX_FAILED_TITLES = 500;
const MAX_QUEUED_ITEMS_PER_OWNER = 96;
const MAX_QUEUED_ITEMS = 192;
const FAILURE_RETRY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_DEBOUNCE_MS = 250;
const MIN_COMMAND_CHARS_FOR_TITLE = 12;
const MIN_GENERIC_INPUT_CHARS_FOR_TITLE = 120;

const titlesByKey = new Map<string, string>();
const pendingKeys = new Set<string>();
const failedAtByKey = new Map<string, number>();
// Bumped whenever titles land; chat threads include it in their lit guard()
// dependencies so cached row subtrees repaint with the new titles.
let titlesVersion = 0;

export function getToolTitlesVersion(): number {
  return titlesVersion;
}

// Everything a flush needs is captured at schedule time: split panes
// reconfigure the module globals on every render, so flush-time globals can
// belong to a different pane than the one that queued the item.
type PendingItem = {
  key: string;
  name: string;
  input: string;
  sessionKey: string;
  agentId: string | null;
  client: GatewayBrowserClient;
  notify: (() => void) | null;
};
type ToolTitlesResult = { titles?: Record<string, string>; disabled?: boolean };

// Set when the gateway reports the opt-in is off; cleared on a new client
// (a different gateway may have titles enabled).
let titlesDisabledByGateway = false;
let queue = new Map<string, PendingItem>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let activeFlush: object | null = null;
let generation = 0;
let activeClient: GatewayBrowserClient | null = null;
let activeSessionKey: string | null = null;
let activeAgentId: string | null = null;
let notifyUpdate: (() => void) | null = null;

/** FNV-1a over name + serialized args; stable across renders of one call. */
function digest(name: string, input: string): string {
  const source = `${name}\u0000${input}`;
  return `t${fnv1aUtf16(source).toString(36)}${source.length.toString(36)}`;
}

function deleteOldest<K, V>(map: Map<K, V>): void {
  const oldest = map.keys().next();
  if (!oldest.done) {
    map.delete(oldest.value);
  }
}

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > maxEntries) {
    deleteOldest(map);
  }
}

function hasRecentFailure(key: string): boolean {
  const failedAt = failedAtByKey.get(key);
  if (failedAt === undefined) {
    return false;
  }
  if (Date.now() - failedAt < FAILURE_RETRY_MS) {
    return true;
  }
  failedAtByKey.delete(key);
  return false;
}

function recordFailure(key: string): void {
  setBoundedMap(failedAtByKey, key, Date.now(), MAX_FAILED_TITLES);
}

function sameOwner(left: PendingItem, right: PendingItem): boolean {
  return (
    left.client === right.client &&
    left.sessionKey === right.sessionKey &&
    left.agentId === right.agentId
  );
}

function trimQueue(newest: PendingItem): void {
  let ownerCount = 0;
  let oldestOwnerKey: string | null = null;
  for (const [key, item] of queue) {
    if (sameOwner(item, newest)) {
      ownerCount += 1;
      oldestOwnerKey ??= key;
    }
  }
  if (ownerCount > MAX_QUEUED_ITEMS_PER_OWNER && oldestOwnerKey) {
    queue.delete(oldestOwnerKey);
  }
  if (queue.size > MAX_QUEUED_ITEMS) {
    deleteOldest(queue);
  }
}

function resetToolTitleState(): void {
  titlesDisabledByGateway = false;
  generation += 1;
  titlesByKey.clear();
  pendingKeys.clear();
  failedAtByKey.clear();
  queue = new Map();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function serializeArgs(args: unknown): string | null {
  if (args === undefined || args === null) {
    return null;
  }
  if (typeof args === "string") {
    return truncateUtf16Safe(args, MAX_TITLE_INPUT_CHARS);
  }
  try {
    const encoded = JSON.stringify(args);
    return typeof encoded === "string" ? truncateUtf16Safe(encoded, MAX_TITLE_INPUT_CHARS) : null;
  } catch {
    return null;
  }
}
/**
 * Only calls where a purpose summary beats the deterministic label qualify:
 * shell commands and arg-heavy generic/MCP tools. File reads/edits/writes
 * already render precise labels.
 */
function resolveToolTitleRequest(
  name: string,
  args: unknown,
): { key: string; input: string } | null {
  const kind = resolveToolCallKind(name, args);
  if (kind === "command") {
    const record = asNullableRecord(args);
    const rawCommand = typeof record?.command === "string" ? record.command.trim() : "";
    const command = unwrapShellWrapperCommand(rawCommand).trim();
    if (command.length < MIN_COMMAND_CHARS_FOR_TITLE) {
      return null;
    }
    const input = truncateUtf16Safe(command, MAX_TITLE_INPUT_CHARS);
    return { key: digest("command", input), input };
  }
  if (kind !== "generic") {
    return null;
  }
  const input = serializeArgs(args);
  if (!input || input.length < MIN_GENERIC_INPUT_CHARS_FOR_TITLE) {
    return null;
  }
  return { key: digest(name.trim().toLowerCase(), input), input };
}

export function getToolCallTitle(name: string, args: unknown): string | undefined {
  const request = resolveToolTitleRequest(name, args);
  if (!request) {
    return undefined;
  }
  const cached = titlesByKey.get(request.key);
  if (cached) {
    // Map insertion order is the LRU order; frequently visible rows survive
    // transcript churn while old decorative titles fall back safely.
    titlesByKey.delete(request.key);
    titlesByKey.set(request.key, cached);
    return cached;
  }
  scheduleTitleRequest(name, request);
  return undefined;
}

export function configureToolTitleFetcher(params: {
  client: GatewayBrowserClient | null;
  sessionKey: string | null;
  /** Selected agent; required for global-session keys where the gateway would otherwise resolve the default agent. */
  agentId?: string | null;
  onTitlesChanged: (() => void) | null;
}): void {
  if (!params.client || params.client !== activeClient) {
    resetToolTitleState();
  }
  activeClient = params.client;
  activeSessionKey = params.sessionKey;
  activeAgentId = params.agentId ?? null;
  notifyUpdate = params.onTitlesChanged;
}

function scheduleTitleRequest(name: string, request: { key: string; input: string }): void {
  if (
    titlesDisabledByGateway ||
    !activeClient ||
    !activeSessionKey ||
    titlesByKey.has(request.key) ||
    pendingKeys.has(request.key) ||
    hasRecentFailure(request.key) ||
    queue.has(request.key)
  ) {
    return;
  }
  const item: PendingItem = {
    key: request.key,
    name,
    input: request.input,
    sessionKey: activeSessionKey,
    agentId: activeAgentId,
    client: activeClient,
    notify: notifyUpdate,
  };
  queue.set(request.key, item);
  // Prefer newly rendered rows and bound retained callbacks/tool input per
  // owner as well as across split panes.
  trimQueue(item);
  if (activeFlush) {
    return;
  }
  flushTimer ??= setTimeout(() => {
    flushTimer = null;
    void flushTitleQueue();
  }, REQUEST_DEBOUNCE_MS);
}

async function flushTitleQueue(): Promise<void> {
  if (activeFlush) {
    return;
  }
  // One request per scheduling pane (client + session + agent); other panes'
  // items stay queued for the follow-up flush.
  const head = queue.values().next().value;
  if (!head) {
    queue = new Map();
    return;
  }
  const flushToken = {};
  const flushGeneration = generation;
  activeFlush = flushToken;
  const batch: PendingItem[] = [];
  for (const item of queue.values()) {
    if (
      item.client === head.client &&
      item.sessionKey === head.sessionKey &&
      item.agentId === head.agentId &&
      batch.length < MAX_ITEMS_PER_REQUEST
    ) {
      batch.push(item);
    }
  }
  for (const item of batch) {
    queue.delete(item.key);
    pendingKeys.add(item.key);
  }
  try {
    const result = await head.client.request<ToolTitlesResult>(
      "chat.toolTitles",
      {
        sessionKey: head.sessionKey,
        ...(head.agentId ? { agentId: head.agentId } : {}),
        items: batch.map((item) => ({ id: item.key, name: item.name, input: item.input })),
      },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    if (flushGeneration !== generation) {
      return;
    }
    if (result?.disabled === true) {
      titlesDisabledByGateway = true;
      queue = new Map();
      return;
    }
    const titles = result?.titles ?? {};
    let changed = false;
    for (const item of batch) {
      const rawTitle = titles[item.key];
      const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
      if (title) {
        setBoundedMap(titlesByKey, item.key, title, MAX_CACHED_TITLES);
        changed = true;
      } else {
        recordFailure(item.key);
      }
    }
    if (changed) {
      titlesVersion += 1;
      // Split panes can contribute rows for the same session to one batch;
      // every contributing pane must repaint, not just the head's.
      const notified = new Set<() => void>();
      for (const item of batch) {
        if (item.notify && !notified.has(item.notify)) {
          notified.add(item.notify);
          item.notify();
        }
      }
    }
  } catch {
    // Gateway without the method, no usable cheap model, transient errors:
    // titles are decorative, so fail closed and keep deterministic labels.
    if (flushGeneration === generation) {
      for (const item of batch) {
        recordFailure(item.key);
      }
    }
  } finally {
    if (flushGeneration === generation) {
      for (const item of batch) {
        pendingKeys.delete(item.key);
      }
    }
    if (activeFlush === flushToken) {
      activeFlush = null;
      // The debounce coalesces a new burst once. Existing backlog drains
      // serially without adding 250 ms between already queued batches.
      if (queue.size > 0) {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        void flushTitleQueue();
      }
    }
  }
}
