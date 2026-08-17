import { asNullableRecord as catalogRawRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionCatalogPullRequestSummary } from "../../../../packages/gateway-protocol/src/index.js";
import type { ControlUiSessionPullRequest } from "../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createDockPanelLayout } from "../../components/dock-panel-layout.ts";
import type { BoardProvider } from "../../lib/board/provider.ts";
import type { BoardFace, BoardVisibleChatDock } from "../../lib/board/settings.ts";
import type { BoardSnapshot, BoardTab } from "../../lib/board/types.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { clampText } from "../../lib/format.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

export type ChatPageContext = ApplicationContext;
export type PaneSessionChangeOptions = { replace?: boolean };
export type PaneSessionHandoff = {
  attachments: ChatAttachment[];
  composerFallbacks?: ChatPageHost["chatComposerFallbackByScope"];
  draft: string;
  restore?: boolean;
  send?: boolean;
  storageFailed?: boolean;
};
type PendingPaneSessionHandoff = PaneSessionHandoff & { expiresAt: number; sessionKey: string };
// A retained pane owns one session for life, so creation/fork adoption crosses
// component instances. The application context scopes that one-shot transfer.
const PANE_SESSION_HANDOFF_TTL_MS = 30_000;
const PANE_SESSION_HANDOFF_LIMIT = 4;
const paneSessionHandoffs = new WeakMap<
  ApplicationContext,
  Map<string, PendingPaneSessionHandoff[]>
>();

function discardPaneSessionHandoff(handoff: PendingPaneSessionHandoff): void {
  if (!handoff.restore) {
    return;
  }
  releaseChatAttachmentPayloads([
    ...handoff.attachments,
    ...Object.values(handoff.composerFallbacks ?? {}).flatMap((fallback) => fallback.attachments),
  ]);
}

function paneHandoffs(
  context: ApplicationContext,
  paneId: string,
  create: boolean,
): PendingPaneSessionHandoff[] | undefined {
  let byPane = paneSessionHandoffs.get(context);
  if (!byPane && create) {
    byPane = new Map();
    paneSessionHandoffs.set(context, byPane);
  }
  let pending = byPane?.get(paneId);
  if (!pending && create) {
    pending = [];
    byPane?.set(paneId, pending);
  }
  if (pending) {
    const now = Date.now();
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index]!.expiresAt <= now) {
        discardPaneSessionHandoff(pending[index]!);
        pending.splice(index, 1);
      }
    }
  }
  return pending;
}

export function preparePaneSessionHandoff(
  context: ApplicationContext,
  paneId: string,
  sessionKey: string,
  handoff: PaneSessionHandoff,
): void {
  const pending = paneHandoffs(context, paneId, true)!;
  const existing = pending.findIndex((candidate) =>
    areUiSessionKeysEquivalent(candidate.sessionKey, sessionKey),
  );
  if (existing >= 0) {
    discardPaneSessionHandoff(pending[existing]!);
    pending.splice(existing, 1);
  }
  const stored = {
    sessionKey,
    ...handoff,
    expiresAt: Date.now() + PANE_SESSION_HANDOFF_TTL_MS,
  };
  pending.push(stored);
  globalThis.setTimeout(() => {
    paneHandoffs(context, paneId, false);
  }, PANE_SESSION_HANDOFF_TTL_MS);
  while (pending.length > PANE_SESSION_HANDOFF_LIMIT) {
    discardPaneSessionHandoff(pending.shift()!);
  }
}

export function consumePaneSessionHandoff(
  context: ApplicationContext,
  paneId: string,
  sessionKey: string,
): PaneSessionHandoff | null {
  const pending = paneHandoffs(context, paneId, false);
  const index = pending?.findIndex((candidate) =>
    areUiSessionKeysEquivalent(candidate.sessionKey, sessionKey),
  );
  if (!pending || index === undefined || index < 0) {
    return null;
  }
  const handoff = pending.splice(index, 1)[0]!;
  const { expiresAt: _expiresAt, sessionKey: _sessionKey, ...value } = handoff;
  return value;
}

export function clearPaneSessionHandoff(
  context: ApplicationContext,
  paneId: string,
  sessionKey: string,
): void {
  const pending = paneHandoffs(context, paneId, false);
  for (let index = (pending?.length ?? 0) - 1; index >= 0; index -= 1) {
    if (areUiSessionKeysEquivalent(pending![index]!.sessionKey, sessionKey)) {
      discardPaneSessionHandoff(pending![index]!);
      pending?.splice(index, 1);
    }
  }
}

export function clearPaneSessionHandoffs(context: ApplicationContext, paneId: string): void {
  const byPane = paneSessionHandoffs.get(context);
  if (!byPane) {
    return;
  }
  const pending = byPane.get(paneId);
  if (!pending) {
    return;
  }
  for (const handoff of pending) {
    discardPaneSessionHandoff(handoff);
  }
  byPane.delete(paneId);
  if (byPane.size === 0) {
    paneSessionHandoffs.delete(context);
  }
}

export type ResolvedBoardView = {
  provider: BoardProvider;
  snapshot: BoardSnapshot;
  hasBoard: boolean;
  face: BoardFace;
  activeTabId: string;
  dock: BoardTab["chatDock"];
  reopenDock: BoardVisibleChatDock;
};

export const boardChatDockLayout = createDockPanelLayout({
  storageKey: "openclaw.control.board-chat-dock.v1",
  minHeight: 180,
  minWidth: 320,
  defaultDock: "right",
  supportedDocks: ["bottom", "left", "right"],
  defaultHeight: 320,
  defaultWidth: 420,
});

export const CATALOG_TOOL_RESULT_PREVIEW_MAX_CHARS = 500;
export const CHAT_HISTORY_INTENT_EDGE_PX = 300;
export const CHAT_HISTORY_INTENT_IDLE_MS = 200;
export const CHAT_HISTORY_TOUCH_INTENT_PX = 8;
export const CHAT_HISTORY_UPWARD_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);
export const headerPlatformByClient = new WeakMap<GatewayBrowserClient, Promise<string | null>>();

export function catalogRawString(raw: unknown, keys: readonly string[]): string | null {
  const record = catalogRawRecord(raw);
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
export function catalogRawResult(raw: unknown): string | null {
  const result = catalogRawRecord(raw)?.result;
  if (result === undefined) {
    return null;
  }
  try {
    const text = JSON.stringify(result);
    return text ? clampText(text, CATALOG_TOOL_RESULT_PREVIEW_MAX_CHARS) : null;
  } catch {
    return null;
  }
}
export function nativeHistoryMessageIdentity(message: unknown): string | null {
  const record = catalogRawRecord(message);
  const metadata = catalogRawRecord(record?.["__openclaw"]);
  const seq = metadata?.seq;
  const id = metadata?.id ?? record?.messageId;
  const sourceIdentity =
    typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0
      ? `seq:${seq}`
      : typeof id === "string" && id.trim()
        ? `id:${id}`
        : null;
  if (!sourceIdentity) {
    return null;
  }
  try {
    // One transcript record can project to multiple visible siblings. Include
    // the projection bytes so partial page overlap removes the matching sibling.
    return `${sourceIdentity}:${JSON.stringify(message)}`;
  } catch {
    return sourceIdentity;
  }
}

export type ChatPaneConnectionScope = {
  context: ChatPageContext;
  state: ChatPageHost;
  client: GatewayBrowserClient;
  generation: number;
  headerOutcomeOwner: string;
  sessions: ChatPageContext["sessions"];
};
export const CHAT_OPEN_DETAILS_SELECTOR =
  ".chat-controls__inline-select[open], .context-usage details[open], .agent-chat__attach-menu[open], .chat-pr__checks[open], details.msg-meta[open]:not([data-preview])";
export const CHAT_COMPOSER_TEXTAREA_SELECTOR = ".agent-chat__composer-combobox > textarea";
export const CHAT_AUTOTYPE_EXEMPT_SELECTOR =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='combobox'], [role='listbox'], [role='textbox'], [data-chat-autotype-exempt]";
export const CHAT_SPACE_ACTIVATION_SELECTOR =
  "a[href], button, summary, [role='button'], [role='checkbox'], [role='link'], [role='radio'], [role='switch']";
export const CHAT_MODAL_SELECTOR = "dialog[open], [aria-modal='true']";

export const NEW_SESSION_ACTIVE_RUN_MESSAGE =
  "Start a new session after the active run or queued messages finish.";
export const NEW_SESSION_LIST_LOADING_MESSAGE =
  "Session list is still refreshing. Try New Chat again in a moment.";
export const NEW_SESSION_CREATE_FAILED_MESSAGE =
  "New Chat could not create a new thread. Try again in a moment.";

export function summarizeSessionPullRequests(
  pullRequests: readonly ControlUiSessionPullRequest[],
): SessionCatalogPullRequestSummary | undefined {
  const current = pullRequests[0];
  if (!current) {
    return undefined;
  }
  return {
    numbers: [...new Set(pullRequests.map((pullRequest) => pullRequest.number))]
      .slice(0, 20)
      .toSorted((left, right) => left - right),
    state: current.state,
  };
}

export function keyboardEventPathMatches(event: KeyboardEvent, selector: string): boolean {
  return event
    .composedPath()
    .some((target) => target instanceof Element && target.matches(selector));
}
