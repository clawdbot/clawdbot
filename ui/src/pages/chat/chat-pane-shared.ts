import {
  catalogRawRecord,
  clampText,
  createDockPanelLayout,
  type BoardFace,
  type BoardProvider,
  type BoardTab,
  type BoardViewSnapshot,
  type ChatPageHost,
  type ControlUiSessionPullRequest,
  type GatewayBrowserClient,
  type SessionCatalogPullRequestSummary,
  type ApplicationContext,
} from "./chat-pane-deps.ts";

export type ChatPageContext = ApplicationContext;
export type PaneSessionChangeOptions = { replace?: boolean };
export type VisibleBoardDock = Exclude<BoardTab["chatDock"], "hidden">;
export type ResolvedBoardView = {
  provider: BoardProvider;
  snapshot: BoardViewSnapshot;
  hasBoard: boolean;
  face: BoardFace;
  activeTabId: string;
  activeTabReadOnly: boolean;
  dock: BoardTab["chatDock"];
  reopenDock: VisibleBoardDock;
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
  sessions: ChatPageContext["sessions"];
};
export const CHAT_OPEN_DETAILS_SELECTOR =
  ".chat-controls__inline-select[open], .context-usage details[open], .agent-chat__attach-menu[open], .chat-pr__checks[open], details.msg-meta[open]:not([data-preview])";
export const CHAT_COMPOSER_TEXTAREA_SELECTOR = ".agent-chat__composer-combobox > textarea";
export const CHAT_TEXT_ENTRY_SELECTOR =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='combobox'], [role='listbox'], [role='textbox']";
export const CHAT_SPACE_ACTIVATION_SELECTOR =
  "a[href], button, summary, [role='button'], [role='checkbox'], [role='link'], [role='radio'], [role='switch']";
export const CHAT_MODAL_SELECTOR = "dialog[open], [aria-modal='true']";
// One automatic page can fill a short initial tail without serially walking a
// collapsed or sparse transcript to exhaustion.
export const CHAT_HISTORY_BOOTSTRAP_PAGE_LIMIT = 1;

/* Pane-width thresholds (CSS px). Split panes and compact windows can be far
 * narrower than the viewport, so side-by-side layouts key off the pane's own
 * measured width, never viewport media queries. */
// Side rail (230-280px) plus a readable thread; below this the rail docks bottom.
export const WORKSPACE_RAIL_SIDE_MIN_PANE_WIDTH = 800;
// Widest the rail's grid column gets; a side-docked rail takes this from the
// width available to the chat + detail-panel split.
export const WORKSPACE_RAIL_MAX_WIDTH = 280;
// .chat-main min-width (312) + divider + .chat-sidebar min-width (300) + slack;
// below this the detail panel stacks under the thread.
export const DETAIL_SIDEBAR_SIDE_MIN_WIDTH = 680;

export const NEW_SESSION_ACTIVE_RUN_MESSAGE =
  "Start a new thread after the active run or queued messages finish.";
export const NEW_SESSION_LIST_LOADING_MESSAGE =
  "Thread list is still refreshing. Try New Chat again in a moment.";
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
