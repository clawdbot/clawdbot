import type {
  Browser,
  BrowserContext,
  CDPSession,
  Dialog,
  Frame,
  Page,
  Request,
} from "playwright-core";
import type { BrowserDownloadCandidate, BrowserDownloadResult } from "./download-types.js";
import type { PlaywrightDownload } from "./pw-download-capture.js";

export type BrowserConsoleMessage = {
  type: string;
  text: string;
  timestamp: string;
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
};

/** Page error captured from a Playwright page. */
export type BrowserPageError = {
  message: string;
  name?: string;
  stack?: string;
  timestamp: string;
};

/** Network request record captured from a Playwright page. */
export type BrowserNetworkRequest = {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  ok?: boolean;
  failureText?: string;
};

/** Observed browser dialog record tracked for agent-visible state. */
export type BrowserObservedDialogRecord = {
  id: string;
  type: string;
  message: string;
  defaultValue?: string;
  openedAt: string;
  closedAt?: string;
  closedBy?: "agent" | "armed" | "auto" | "timeout" | "remote";
};

/** Pending and recent dialog state for a page. */
type BrowserObservedDialogState = {
  pending: BrowserObservedDialogRecord[];
  recent: BrowserObservedDialogRecord[];
};

/** Browser state currently observable by agent responses. */
export type BrowserObservedState = {
  dialogs: BrowserObservedDialogState;
};

/** Raised when an action is blocked by an observed modal dialog. */
export class BrowserObservedDialogBlockedError extends Error {
  readonly browserState: BrowserObservedState;

  constructor(browserState: BrowserObservedState) {
    super("Browser action blocked by a modal dialog.");
    this.name = "BrowserObservedDialogBlockedError";
    this.browserState = browserState;
  }
}

/** Type guard for observed-dialog blocked errors. */
export function isBrowserObservedDialogBlockedError(
  err: unknown,
): err is BrowserObservedDialogBlockedError {
  return err instanceof BrowserObservedDialogBlockedError;
}

export type PendingObservedDialog = BrowserObservedDialogRecord & {
  dialog: Dialog;
};

export type ArmedDialogResponse = {
  accept: boolean;
  promptText?: string;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
};

export type ConnectedBrowser = {
  browser: Browser;
  cdpUrl: string;
  onDisconnected?: () => void;
};

export type DownloadPayload = PlaywrightDownload & {
  path?: () => Promise<string>;
};

export type ActionDownloadCapture = {
  beforeSave?: (download: BrowserDownloadCandidate) => Promise<void> | void;
  lastEventAtMs?: number;
  pending: Array<Promise<BrowserDownloadResult>>;
  validations: Array<Promise<void>>;
  waiters: Array<() => void>;
};

export type PageState = {
  console: BrowserConsoleMessage[];
  errors: BrowserPageError[];
  requests: Map<string, BrowserNetworkRequest>;
  // Strong Request keys would retain disposed Playwright page/context graphs.
  requestIds: WeakMap<Request, string>;
  nextRequestId: number;
  armIdUpload: number;
  armIdDownload: number;
  downloadWaiterDepth: number;
  actionDownloadCapture?: ActionDownloadCapture;
  nextObservedDialogId: number;
  pendingDialogs: PendingObservedDialog[];
  recentDialogs: BrowserObservedDialogRecord[];
  armedDialogResponse?: ArmedDialogResponse;
  dialogAbortControllers: Set<AbortController>;
  /** Persistent session and queue for page-scoped emulation overrides. */
  emulation?: {
    session?: Promise<CDPSession>;
    transitionTail?: Promise<void>;
    transitionAbort?: AbortController;
    metricsOwner?: { session: CDPSession; viewport: { width: number; height: number } };
    touch?: { session: CDPSession; enabled: boolean };
  };
  /**
   * Role-based refs from the last role snapshot (e.g. e1/e2).
   * Mode "role" refs are generated from ariaSnapshot and resolved via getByRole.
   * Mode "aria" refs are Playwright aria-ref ids and resolved via `aria-ref=...`.
   */
  roleRefs?: Record<string, { role: string; name?: string; nth?: number; domMarker?: boolean }>;
  roleRefsMode?: "role" | "aria";
  roleRefsFrameSelector?: string;
  roleRefsFrame?: Frame;
  /** Target-cache entry owned by the current role refs. */
  roleRefsTargetKey?: string;
  /** Cache generation restored or stored by this Page. */
  roleRefsTargetGeneration?: number;
  /** Main-frame navigation observed before this Page could be bound to its target. */
  roleRefsInvalidBeforeGeneration?: number;
  /** Any frame changed before target binding; invalidates only page-wide aria refs. */
  roleRefsAriaInvalidBeforeGeneration?: number;
};

export type RoleRefs = NonNullable<PageState["roleRefs"]>;
export type RoleRefsCacheEntry = {
  refs: RoleRefs;
  mode?: NonNullable<PageState["roleRefsMode"]>;
  generation: number;
};

export type ContextState = {
  traceActive: boolean;
};

export const pageStates = new WeakMap<Page, PageState>();
export const contextStates = new WeakMap<BrowserContext, ContextState>();
export const observedContexts = new WeakSet<BrowserContext>();
export const observedPages = new WeakSet<Page>();

export const MAX_CONSOLE_MESSAGES = 500;
export const MAX_PAGE_ERRORS = 200;
export const MAX_NETWORK_REQUESTS = 500;
export const MAX_RECENT_DIALOGS = 20;
export const OBSERVED_DIALOG_TIMEOUT_MS = 120_000;

export type PendingBrowserConnection = {
  attempt: { cancelled: boolean; retired?: ConnectedBrowser };
  promise: Promise<ConnectedBrowser>;
};

export type PlaywrightConnectionRetirement = {
  readonly retired: boolean;
  /** Capture handles created by already-admitted work before cleanup begins. */
  refresh?: () => boolean;
  close: () => Promise<void>;
};

export const cachedByCdpUrl = new Map<string, ConnectedBrowser>();
export const connectingByCdpUrl = new Map<string, PendingBrowserConnection>();
export const retainedClosingByCdpUrl = new Map<string, Set<ConnectedBrowser>>();
export const closeConnectionPromises = new WeakMap<ConnectedBrowser, Promise<void>>();
export const closedConnections = new WeakSet<ConnectedBrowser>();
export const PLAYWRIGHT_CONNECTION_CLOSE_TIMEOUT_MS = 2_000;
export const blockedTargetsByCdpUrl = new Set<string>();
export const blockedPageRefsByCdpUrl = new Map<string, WeakSet<Page>>();
