import { asNullableRecord as catalogRawRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RouteId } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { BoardProvider } from "../../lib/board/provider.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import type { BoardSnapshot } from "../../lib/board/types.ts";
import type { ChatAttachment, ChatGoalDraftMode, HumanMention } from "../../lib/chat/chat-types.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

export type ChatPageContext = ApplicationContext;
export type PaneSessionChangeOptions = { replace?: boolean };
export type PaneSessionHandoff = {
  goalMode?: ChatGoalDraftMode;
  attachments: ChatAttachment[];
  composerFallbacks?: ChatPageHost["chatComposerFallbackByScope"];
  draft: string;
  mentions?: readonly HumanMention[];
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
  ApplicationContext<RouteId>,
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

function removePaneSessionHandoffs(
  pending: PendingPaneSessionHandoff[] | undefined,
  matches: (handoff: PendingPaneSessionHandoff) => boolean,
): void {
  for (let index = (pending?.length ?? 0) - 1; index >= 0; index -= 1) {
    if (matches(pending![index]!)) {
      discardPaneSessionHandoff(pending!.splice(index, 1)[0]!);
    }
  }
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
    removePaneSessionHandoffs(pending, (handoff) => handoff.expiresAt <= now);
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
  removePaneSessionHandoffs(pending, (candidate) =>
    areUiSessionKeysEquivalent(candidate.sessionKey, sessionKey),
  );
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
  removePaneSessionHandoffs(paneHandoffs(context, paneId, false), (handoff) =>
    areUiSessionKeysEquivalent(handoff.sessionKey, sessionKey),
  );
}

export function retireSessionPaneHandoffs(
  context: ApplicationContext<RouteId>,
  targets: readonly { key: string; retireBeforeRevision: number }[],
): void {
  for (const pending of paneSessionHandoffs.get(context)?.values() ?? []) {
    removePaneSessionHandoffs(pending, (handoff) =>
      targets.some(
        ({ key, retireBeforeRevision }) =>
          areUiSessionKeysEquivalent(handoff.sessionKey, key) &&
          handoff.expiresAt - PANE_SESSION_HANDOFF_TTL_MS < retireBeforeRevision,
      ),
    );
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
};

export const CATALOG_TOOL_RESULT_PREVIEW_MAX_CHARS = 500;
// One distance owns both halves of early history loading: upward intent within
// this range arms the sentinel observer, and the observer's rootMargin fires
// the same distance out. Splitting them re-creates the wall at the smaller value.
export const CHAT_HISTORY_PREFETCH_EDGE_PX = 1200;
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
    return text || null;
  } catch {
    return null;
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
  ".chat-controls__inline-select[open], .context-usage details[open], .agent-chat__attach-menu[open], .chat-pr__checks[open]";
export const CHAT_COMPOSER_TEXTAREA_SELECTOR = ".agent-chat__composer-combobox > textarea";
// Menus without typeahead own activation/navigation, not printable input.
// Keeping those key classes separate prevents an open menu from silently dropping a letter.
const CHAT_PRINTABLE_KEY_TARGET_SELECTOR =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='combobox'], [role='textbox'], [data-chat-autotype-exempt]";
const CHAT_SPACE_ACTIVATION_SELECTOR =
  "a[href], button, summary, [role='button'], [role='checkbox'], [role='link'], [role='listbox'], [role='menu'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [role='option'], [role='radio'], [role='switch']";
const CHAT_DROPDOWN_KEYS = new Set([
  " ",
  "Enter",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Escape",
]);

// Shortcut menus own only advertised, enabled keys; every other printable key
// can still transfer to the composer through the normal browser input pipeline.
function keyboardShortcutTargetOwnsKey(target: HTMLElement, key: string): boolean {
  return (
    /^[a-z0-9]$/iu.test(key) &&
    target.matches("wa-dropdown, [data-chat-autotype-shortcuts][open]") &&
    target.querySelector(`[data-shortcut="${key.toLowerCase()}"]:not([disabled])`) !== null
  );
}

export const NEW_SESSION_ACTIVE_RUN_MESSAGE =
  "Start a new session after the active run or queued messages finish.";
export const NEW_SESSION_LIST_LOADING_MESSAGE =
  "Session list is still refreshing. Try New Chat again in a moment.";
export const NEW_SESSION_CREATE_FAILED_MESSAGE =
  "New Chat could not create a new thread. Try again in a moment.";

function keyboardEventPathHasInteractiveTarget(event: KeyboardEvent): boolean {
  return event
    .composedPath()
    .some(
      (target) =>
        target instanceof HTMLElement &&
        (target.matches(CHAT_PRINTABLE_KEY_TARGET_SELECTOR) ||
          keyboardShortcutTargetOwnsKey(target, event.key) ||
          (event.key === " " && target.matches(CHAT_SPACE_ACTIVATION_SELECTOR))),
    );
}

function openDropdownOwnsKey(root: ParentNode, key: string): boolean {
  const surface = root instanceof Element ? (root.closest("openclaw-app") ?? root) : root;
  return [...surface.querySelectorAll<HTMLElement & { open?: boolean }>("wa-dropdown")].some(
    (dropdown) =>
      dropdown.open === true &&
      !dropdown.closest("[inert]") &&
      (CHAT_DROPDOWN_KEYS.has(key) || keyboardShortcutTargetOwnsKey(dropdown, key)),
  );
}

export function focusChatComposerFromPrintableKeydown(
  root: ParentNode,
  event: KeyboardEvent,
): void {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    openDropdownOwnsKey(root, event.key) ||
    event.key.length !== 1 ||
    keyboardEventPathHasInteractiveTarget(event) ||
    document.openClawModalLayers?.size ||
    document.querySelector("dialog[open], [aria-modal='true']")
  ) {
    return;
  }
  const composer = root.querySelector<HTMLTextAreaElement>(CHAT_COMPOSER_TEXTAREA_SELECTOR);
  if (!composer || composer.disabled || composer.readOnly) {
    return;
  }
  // Focus transfers ownership; block old-target dropdown typeahead from cancelling input.
  composer.focus({ preventScroll: true });
  event.stopImmediatePropagation();
}
