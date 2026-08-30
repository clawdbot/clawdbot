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
const MAX_RETAINED_TITLES = 128;
const MAX_RETAINED_FAILURES = 128;
const FAILURE_RETRY_MS = 5 * 60_000;
const MAX_WORK_ITEMS_PER_SESSION = 48;
const MAX_WORK_ITEMS_TOTAL = 96;
const MAX_SATURATED_SESSIONS = MAX_WORK_ITEMS_TOTAL;
const SATURATED_SESSION_RETRY_MS = 5 * 60_000;
const REQUEST_DEBOUNCE_MS = 250;
const MIN_COMMAND_CHARS_FOR_TITLE = 12;
const MIN_GENERIC_INPUT_CHARS_FOR_TITLE = 120;

const TOOL_TITLES_CHANGED_EVENT = "openclaw:tool-titles-changed";
const DEFAULT_RENDER_SOURCE = {};

export function subscribeToolTitleChanges(listener: () => void): () => void {
  globalThis.addEventListener(TOOL_TITLES_CHANGED_EVENT, listener);
  return () => globalThis.removeEventListener(TOOL_TITLES_CHANGED_EVENT, listener);
}

export function releaseToolTitleRenderSource(renderSource: object): void {
  renderEpochs.delete(renderSource);
  if (activeRenderSource === renderSource) {
    activeRenderSource = DEFAULT_RENDER_SOURCE;
    activeRenderEpoch = renderEpochs.get(DEFAULT_RENDER_SOURCE) ?? 0;
  }
  for (const saturation of saturatedSessions.values()) {
    if (saturation.searchRenderSource === renderSource) {
      saturation.searchRenderSource = null;
      saturation.searchRenderEpoch = null;
    }
  }
}

const titlesByKey = new Map<string, string>();
const pendingKeys = new Map<string, PendingItem>();
const failedKeys = new Map<string, number>();
const saturatedSessions = new Map<string, SaturatedSession>();
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
  ownerKey: string;
  name: string;
  input: string;
  sessionKey: string;
  agentId: string | null;
  client: GatewayBrowserClient;
};
type SaturatedSession = {
  expiresAt: number;
  resumeAfterKey: string | null;
  searchRenderSource: object | null;
  searchRenderEpoch: number | null;
};
type ToolTitlesResult = { titles?: Record<string, string>; disabled?: boolean };

// Set when the gateway reports the opt-in is off; cleared on a new client
// (a different gateway may have titles enabled).
let titlesDisabledByGateway = false;
const queue = new Map<string, PendingItem>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let activeClient: GatewayBrowserClient | null = null;
let activeSessionKey: string | null = null;
let activeAgentId: string | null = null;
let activeRenderSource = DEFAULT_RENDER_SOURCE;
let activeRenderEpoch = 0;
const renderEpochs = new WeakMap<object, number>();
let fetcherGeneration = 0;
let activeFlush: object | null = null;

/** FNV-1a over name + serialized args; stable across renders of one call. */
function digest(name: string, input: string): string {
  const source = `${name}\u0000${input}`;
  return `t${fnv1aUtf16(source).toString(36)}${source.length.toString(36)}`;
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

function readLru<T>(entries: Map<string, T>, key: string): T | undefined {
  if (!entries.has(key)) {
    return undefined;
  }
  const value = entries.get(key);
  if (value === undefined) {
    return undefined;
  }
  entries.delete(key);
  entries.set(key, value);
  return value;
}

function storeLru<T>(entries: Map<string, T>, key: string, value: T, limit: number): void {
  entries.delete(key);
  entries.set(key, value);
  while (entries.size > limit) {
    entries.delete(entries.keys().next().value!);
  }
}

function hasUnexpired(entries: Map<string, number>, key: string): boolean {
  const expiresAt = readLru(entries, key);
  if (expiresAt === undefined) {
    return false;
  }
  if (expiresAt <= Date.now()) {
    entries.delete(key);
    return false;
  }
  return true;
}

function storeFailure(key: string): void {
  storeLru(failedKeys, key, Date.now() + FAILURE_RETRY_MS, MAX_RETAINED_FAILURES);
}

function notifyTitlesChanged(): void {
  titlesVersion += 1;
  if (typeof globalThis.dispatchEvent === "function") {
    globalThis.dispatchEvent(new Event(TOOL_TITLES_CHANGED_EVENT));
  }
}

function clearRetainedTitleState(): void {
  const hadTitles = titlesByKey.size > 0;
  titlesByKey.clear();
  failedKeys.clear();
  if (hadTitles) {
    notifyTitlesChanged();
  }
}

function queueOwnerKey(sessionKey: string, agentId: string | null): string {
  return `${sessionKey}\u0000${agentId ?? ""}`;
}

function saturateSession(ownerKey: string, resumeAfterKey: string | null): void {
  storeLru(
    saturatedSessions,
    ownerKey,
    {
      expiresAt: Date.now() + SATURATED_SESSION_RETRY_MS,
      resumeAfterKey,
      searchRenderSource: null,
      searchRenderEpoch: null,
    },
    MAX_SATURATED_SESSIONS,
  );
}

function shouldSuppressSaturatedSession(ownerKey: string, requestKey: string): boolean {
  const saturation = readLru(saturatedSessions, ownerKey);
  if (!saturation) {
    return false;
  }
  if (saturation.expiresAt > Date.now()) {
    return true;
  }
  if (saturation.resumeAfterKey === null) {
    saturatedSessions.delete(ownerKey);
    return false;
  }
  if (requestKey === saturation.resumeAfterKey) {
    // Resume after the last admitted row. Re-admitting LRU-evicted rows before
    // this cursor would spend every later bounded window without making progress.
    saturatedSessions.delete(ownerKey);
    return true;
  }
  if (saturation.searchRenderEpoch === null) {
    saturation.searchRenderSource = activeRenderSource;
    saturation.searchRenderEpoch = activeRenderEpoch;
    return true;
  }
  if (
    saturation.searchRenderSource !== activeRenderSource ||
    saturation.searchRenderEpoch === activeRenderEpoch
  ) {
    return true;
  }
  // The prior complete render did not contain the cursor, so retention or
  // compaction removed it. Resume from this render's first remaining row.
  saturatedSessions.delete(ownerKey);
  return false;
}

function discardQueuedOwner(ownerKey: string): void {
  let discarded = false;
  for (const [key, item] of queue) {
    if (item.ownerKey === ownerKey) {
      queue.delete(key);
      discarded = true;
    }
  }
  if (!discarded) {
    return;
  }
  // Cool down only the failed owner. Other sessions can resolve through a
  // different utility model and must retain their independently queued work.
  saturateSession(ownerKey, null);
}

function countSessionWork(ownerKey: string): number {
  let count = 0;
  for (const item of queue.values()) {
    if (item.ownerKey === ownerKey) {
      count += 1;
    }
  }
  for (const item of pendingKeys.values()) {
    if (item.ownerKey === ownerKey) {
      count += 1;
    }
  }
  return count;
}

function clearFlushTimer(): void {
  if (!flushTimer) {
    return;
  }
  clearTimeout(flushTimer);
  flushTimer = null;
}

function retireTransientState(): void {
  fetcherGeneration += 1;
  activeFlush = null;
  queue.clear();
  pendingKeys.clear();
  saturatedSessions.clear();
  clearFlushTimer();
}

function scheduleFlush(): void {
  if (flushTimer || activeFlush !== null || queue.size === 0 || titlesDisabledByGateway) {
    return;
  }
  const generation = fetcherGeneration;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (generation !== fetcherGeneration) {
      scheduleFlush();
      return;
    }
    void flushTitleQueue(generation);
  }, REQUEST_DEBOUNCE_MS);
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
  const admissionSuppressed =
    activeSessionKey !== null &&
    shouldSuppressSaturatedSession(queueOwnerKey(activeSessionKey, activeAgentId), request.key);
  const cached = readLru(titlesByKey, request.key);
  if (cached) {
    return cached;
  }
  if (!admissionSuppressed) {
    scheduleTitleRequest(name, request);
  }
  return undefined;
}

export function configureToolTitleFetcher(params: {
  client: GatewayBrowserClient | null;
  sessionKey: string | null;
  /** Selected agent; required for global-session keys where the gateway would otherwise resolve the default agent. */
  agentId?: string | null;
  /** Stable identity of the pane performing this render. */
  renderSource?: object;
}): void {
  if (params.client !== activeClient) {
    retireTransientState();
    titlesDisabledByGateway = false;
    clearRetainedTitleState();
  }
  activeClient = params.client;
  activeSessionKey = params.sessionKey;
  activeAgentId = params.agentId ?? null;
  activeRenderSource = params.renderSource ?? DEFAULT_RENDER_SOURCE;
  activeRenderEpoch = (renderEpochs.get(activeRenderSource) ?? 0) + 1;
  renderEpochs.set(activeRenderSource, activeRenderEpoch);
}

function scheduleTitleRequest(name: string, request: { key: string; input: string }): void {
  if (
    titlesDisabledByGateway ||
    !activeClient ||
    !activeSessionKey ||
    titlesByKey.has(request.key) ||
    hasUnexpired(failedKeys, request.key)
  ) {
    return;
  }
  const existing = pendingKeys.get(request.key) ?? queue.get(request.key);
  if (existing) {
    return;
  }
  const ownerKey = queueOwnerKey(activeSessionKey, activeAgentId);
  const sessionWork = countSessionWork(ownerKey);
  if (
    sessionWork >= MAX_WORK_ITEMS_PER_SESSION ||
    pendingKeys.size + queue.size >= MAX_WORK_ITEMS_TOTAL
  ) {
    saturateSession(ownerKey, null);
    return;
  }
  queue.set(request.key, {
    key: request.key,
    ownerKey,
    name,
    input: request.input,
    sessionKey: activeSessionKey,
    agentId: activeAgentId,
    client: activeClient,
  });
  if (
    sessionWork + 1 >= MAX_WORK_ITEMS_PER_SESSION ||
    pendingKeys.size + queue.size >= MAX_WORK_ITEMS_TOTAL
  ) {
    saturateSession(ownerKey, request.key);
  }
  scheduleFlush();
}

async function flushTitleQueue(generation: number): Promise<void> {
  if (generation !== fetcherGeneration || activeFlush !== null) {
    return;
  }
  // One request per scheduling pane (client + session + agent); other panes'
  // items stay queued for the follow-up flush.
  const head = queue.values().next().value;
  if (!head) {
    return;
  }
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
    pendingKeys.set(item.key, item);
  }
  const flush = {};
  activeFlush = flush;
  try {
    const result = await head.client.request<ToolTitlesResult>("chat.toolTitles", {
      sessionKey: head.sessionKey,
      ...(head.agentId ? { agentId: head.agentId } : {}),
      items: batch.map((item) => ({ id: item.key, name: item.name, input: item.input })),
    });
    if (generation !== fetcherGeneration) {
      return;
    }
    if (result?.disabled === true) {
      titlesDisabledByGateway = true;
      queue.clear();
      clearFlushTimer();
      return;
    }
    const titles = asNullableRecord(result?.titles);
    let changed = false;
    for (const item of batch) {
      const rawTitle = titles?.[item.key];
      const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
      if (title) {
        failedKeys.delete(item.key);
        storeLru(titlesByKey, item.key, title, MAX_RETAINED_TITLES);
        changed = true;
      } else {
        storeFailure(item.key);
      }
    }
    if (!changed) {
      discardQueuedOwner(head.ownerKey);
      return;
    }
    notifyTitlesChanged();
  } catch {
    if (generation !== fetcherGeneration) {
      return;
    }
    // Gateway without the method, no usable cheap model, transient errors:
    // titles are decorative, so fail closed and keep deterministic labels.
    for (const item of batch) {
      storeFailure(item.key);
    }
    discardQueuedOwner(head.ownerKey);
  } finally {
    for (const item of batch) {
      if (pendingKeys.get(item.key) === item) {
        pendingKeys.delete(item.key);
      }
    }
    if (activeFlush === flush) {
      activeFlush = null;
    }
    scheduleFlush();
  }
}
