/**
 * AI-generated purpose titles for complex tool calls.
 *
 * The store is process-global and keyed by a digest of tool name + args, so a
 * title generated once (or served from the gateway cache) applies to every
 * render of the same call. Fetching is debounced and best-effort: when no
 * utility model or Luna default is usable, rows keep their deterministic
 * labels.
 */

import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { resolveToolCallKind, unwrapShellWrapperCommand } from "../../lib/chat/tool-call-view.ts";

const MAX_TITLE_INPUT_CHARS = 2_000;
const MAX_ITEMS_PER_REQUEST = 24;
const REQUEST_DEBOUNCE_MS = 250;
const MIN_COMMAND_CHARS_FOR_TITLE = 12;
const MIN_GENERIC_INPUT_CHARS_FOR_TITLE = 120;

const titlesByKey = new Map<string, string>();
const pendingKeys = new Set<string>();
const failedKeys = new Set<string>();
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
let activeClient: GatewayBrowserClient | null = null;
let activeSessionKey: string | null = null;
let activeAgentId: string | null = null;
let notifyUpdate: (() => void) | null = null;

/** FNV-1a over name + serialized args; stable across renders of one call. */
function digest(name: string, input: string): string {
  const source = `${name}\u0000${input}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `t${(hash >>> 0).toString(36)}${source.length.toString(36)}`;
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
export function resolveToolTitleRequest(
  name: string,
  args: unknown,
): { key: string; input: string } | null {
  const kind = resolveToolCallKind(name, args);
  if (kind === "command") {
    const record =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : null;
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
  if (params.client !== activeClient) {
    titlesDisabledByGateway = false;
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
    failedKeys.has(request.key) ||
    queue.has(request.key)
  ) {
    return;
  }
  queue.set(request.key, {
    key: request.key,
    name,
    input: request.input,
    sessionKey: activeSessionKey,
    agentId: activeAgentId,
    client: activeClient,
    notify: notifyUpdate,
  });
  flushTimer ??= setTimeout(() => {
    flushTimer = null;
    void flushTitleQueue();
  }, REQUEST_DEBOUNCE_MS);
}

async function flushTitleQueue(): Promise<void> {
  // One request per scheduling pane (client + session + agent); other panes'
  // items stay queued for the follow-up flush.
  const head = queue.values().next().value;
  if (!head) {
    queue = new Map();
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
    pendingKeys.add(item.key);
  }
  const hasBacklog = queue.size > 0;
  try {
    const result = await head.client.request<ToolTitlesResult>("chat.toolTitles", {
      sessionKey: head.sessionKey,
      ...(head.agentId ? { agentId: head.agentId } : {}),
      items: batch.map((item) => ({ id: item.key, name: item.name, input: item.input })),
    });
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
        titlesByKey.set(item.key, title);
        changed = true;
      } else {
        failedKeys.add(item.key);
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
    for (const item of batch) {
      failedKeys.add(item.key);
    }
  } finally {
    for (const item of batch) {
      pendingKeys.delete(item.key);
    }
    if (hasBacklog && !flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushTitleQueue();
      }, REQUEST_DEBOUNCE_MS);
    }
  }
}

export function resetToolTitlesForTest(): void {
  titlesDisabledByGateway = false;
  titlesByKey.clear();
  pendingKeys.clear();
  failedKeys.clear();
  queue = new Map();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

export function setToolTitleForTest(key: string, title: string): void {
  titlesByKey.set(key, title);
}
