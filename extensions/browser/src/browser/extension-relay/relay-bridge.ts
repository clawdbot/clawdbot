/**
 * Extension relay CDP bridge.
 *
 * Presents a CDP browser endpoint (compatible with Playwright connectOverCDP)
 * on one side and the OpenClaw Chrome extension's chrome.debugger transport on
 * the other. The bridge owns all Target.* synthesis so the extension stays a
 * thin forwarder — the old assets/chrome-extension put this logic in an
 * untestable MV3 service worker, which is why it rotted and was removed.
 */
import { once } from "node:events";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveCreateTargetParams } from "./create-target-params.js";
import {
  type ExtensionToRelayMessage,
  parseExtensionMessage,
  type RelayCommandBody,
  type RelayTabInfo,
  type RelayToExtensionMessage,
} from "./relay-protocol.js";

const log = createSubsystemLogger("browser").child("extension-relay");

/** Default timeout for commands forwarded to the extension. */
const EXTENSION_COMMAND_TIMEOUT_MS = 15_000;
/** App-level keepalive interval; message traffic keeps the MV3 worker alive. */
const EXTENSION_PING_INTERVAL_MS = 20_000;

/** Synthetic targetId for the emulated browser target. */
const BROWSER_TARGET_ID = "openclaw-extension-relay";
/** Playwright requires every attached page target to identify its browser context. */
const BROWSER_CONTEXT_ID = "openclaw-extension-context";

/** Minimal socket seam so tests can drive the bridge without real WebSockets. */
type BridgeSocket = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type CdpRequest = {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

type PendingExtensionCommand = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

type TabState = {
  info: RelayTabInfo;
  /** Set while chrome.debugger is attached: real CDP targetId + synthetic root sessionId. */
  attached?: { targetId: string; sessionId: string };
  attaching?: Promise<{ targetId: string; sessionId: string }>;
  /** Extension loss invalidated attachment work that auto-attach clients still expect restored. */
  restoreAttachment: boolean;
};

type CdpClientState = {
  socket: BridgeSocket;
  autoAttach: boolean;
  /** Session ids this client has been told about (root and child sessions). */
  announcedSessions: Set<string>;
};

type AuxiliaryTabSession = {
  tabId: number;
  parentSessionId: string;
  client: CdpClientState;
};

/** Browser identity reported by the paired extension. */
type ExtensionIdentity = {
  userAgent: string;
  browserVersion: string;
  extensionVersion: string;
};

function toErrorPayload(
  id: number | null,
  sessionId: string | undefined,
  message: string,
  code = -32000,
): string {
  return JSON.stringify({ id, ...(sessionId ? { sessionId } : {}), error: { code, message } });
}

/**
 * One relay bridge per extension-driver profile. Accepts at most one extension
 * connection (a newer one replaces the old — MV3 workers restart freely) and
 * any number of CDP clients (pw-session caches one per cdpUrl in practice).
 */
export class ExtensionRelayBridge {
  private extension: { socket: BridgeSocket; identity: ExtensionIdentity } | null = null;
  private readonly extensionCandidates = new Set<BridgeSocket>();
  private readonly clients = new Set<CdpClientState>();
  private readonly tabs = new Map<number, TabState>();
  /** Browser-level sessions created by Playwright for page-scoped CDP access. */
  private readonly browserSessions = new Map<string, CdpClientState>();
  /** Extra root-page sessions multiplexed over one chrome.debugger attachment. */
  private readonly auxiliaryTabSessions = new Map<string, AuxiliaryTabSession>();
  /** Child debugger sessions (iframes/workers) mapped to their owning tab. */
  private readonly childSessions = new Map<string, number>();
  private readonly pendingExtension = new Map<number, PendingExtensionCommand>();
  private nextSeq = 1;
  private nextSessionOrdinal = 1;
  private nextExtensionCandidateOrdinal = 1;
  private latestPromotedCandidateOrdinal = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private missedPongs = 0;
  private readonly onStateChange?: () => void;
  private readonly connectionEvents = new EventTarget();

  constructor(
    opts: {
      onStateChange?: () => void;
    } = {},
  ) {
    this.onStateChange = opts.onStateChange;
  }

  /** True once an extension socket completed its hello handshake. */
  get extensionConnected(): boolean {
    return this.extension !== null;
  }

  /** Wait for an authenticated extension hello without polling its CDP endpoint. */
  async waitForExtensionConnection(signal: AbortSignal, timeoutMs: number): Promise<boolean> {
    if (this.extensionConnected) {
      return true;
    }
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    try {
      await once(this.connectionEvents, "ready", {
        signal: AbortSignal.any([signal, timeout.signal]),
      });
      return this.extensionConnected;
    } catch (error) {
      signal.throwIfAborted();
      if (timeout.signal.aborted) {
        return false;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Identity of the paired browser, when connected. */
  get identity(): ExtensionIdentity | null {
    return this.extension?.identity ?? null;
  }

  /** Tabs currently reported as accessible by the extension. */
  accessibleTabs(): RelayTabInfo[] {
    return [...this.tabs.values()].map((tab) => tab.info);
  }

  /** Capture the exact extension connection and tab instance for one browser operation. */
  captureOperationTarget(targetId: string): (() => string | undefined) | undefined {
    const extension = this.extension;
    const target = this.tabByTargetId(targetId);
    if (!extension || !target) {
      return undefined;
    }
    // Chrome tab ids survive renderer swaps but can be reused by another browser;
    // pin both the authenticated extension owner and the exact granted tab instance.
    return () =>
      this.extension === extension && this.tabs.get(target.tabId) === target.tab
        ? target.tab.attached?.targetId
        : undefined;
  }

  /**
   * DevTools-style descriptors for `/json/list`: RelayTabInfo plus the `id`
   * and `type` fields CDP discovery clients expect. `id` is the live debugger
   * targetId once a tab is attached; before that it is the same `tab-<tabId>`
   * fallback ensureTabAttached mints, so unattached tabs still list stably.
   * No per-target webSocketDebuggerUrl: all CDP traffic multiplexes over the
   * single browser endpoint (`/cdp`).
   */
  devtoolsTargetDescriptors(): Array<RelayTabInfo & { id: string; type: string }> {
    return [...this.tabs.values()].map((tab) => ({
      tabId: tab.info.tabId,
      url: tab.info.url,
      title: tab.info.title,
      active: tab.info.active,
      id: tab.attached?.targetId ?? `tab-${tab.info.tabId}`,
      type: "page",
    }));
  }

  /** Number of connected CDP clients (diagnostics). */
  get cdpClientCount(): number {
    return this.clients.size;
  }

  // ---------------------------------------------------------------------
  // Extension side
  // ---------------------------------------------------------------------

  /** Wire up a newly accepted extension WebSocket. */
  attachExtensionSocket(socket: BridgeSocket): {
    onMessage: (raw: string) => void;
    onClose: () => void;
  } {
    const candidateOrdinal = this.nextExtensionCandidateOrdinal++;
    let candidateState: "awaiting-hello" | "active" | "rejected" = "awaiting-hello";
    this.extensionCandidates.add(socket);
    const rejectCandidate = (code: number, reason: string) => {
      candidateState = "rejected";
      this.extensionCandidates.delete(socket);
      socket.close(code, reason);
    };
    const onMessage = (raw: string) => {
      if (candidateState === "rejected") {
        return;
      }
      const msg = parseExtensionMessage(raw);
      if (candidateState === "awaiting-hello") {
        if (msg?.type !== "hello") {
          rejectCandidate(4001, "expected valid hello");
          return;
        }
        if (candidateOrdinal < this.latestPromotedCandidateOrdinal) {
          rejectCandidate(4000, "superseded by newer extension connection");
          return;
        }
        candidateState = "active";
        this.extensionCandidates.delete(socket);
        this.latestPromotedCandidateOrdinal = candidateOrdinal;
        if (this.extension) {
          // Authentication happens before bridge attachment. Keep the active
          // socket until its replacement also proves it can speak the relay protocol.
          log.info("extension reconnected; replacing previous relay connection");
          const previous = this.extension;
          previous.socket.close(4000, "replaced by newer extension connection");
          if (this.extension === previous) {
            this.handleExtensionGone();
          }
        }
        this.extension = {
          socket,
          identity: {
            userAgent: msg.userAgent,
            browserVersion: msg.browserVersion,
            extensionVersion: msg.extensionVersion,
          },
        };
        this.syncTabs(msg.tabs);
        this.startPing();
        this.connectionEvents.dispatchEvent(new Event("ready"));
        this.onStateChange?.();
        return;
      }
      if (this.extension?.socket !== socket) {
        return;
      }
      if (!msg) {
        log.warn("dropping malformed extension relay frame");
        return;
      }
      this.handleExtensionMessage(msg);
    };
    const onClose = () => {
      candidateState = "rejected";
      this.extensionCandidates.delete(socket);
      if (this.extension?.socket === socket) {
        this.handleExtensionGone();
        this.onStateChange?.();
      }
    };
    return { onMessage, onClose };
  }

  private handleExtensionMessage(msg: ExtensionToRelayMessage): void {
    switch (msg.type) {
      case "result": {
        const pending = this.pendingExtension.get(msg.seq);
        if (pending) {
          this.pendingExtension.delete(msg.seq);
          clearTimeout(pending.timer);
          pending.resolve(msg.result);
        }
        return;
      }
      case "error": {
        const pending = this.pendingExtension.get(msg.seq);
        if (pending) {
          this.pendingExtension.delete(msg.seq);
          clearTimeout(pending.timer);
          pending.reject(new Error(msg.message));
        }
        return;
      }
      case "cdpEvent": {
        this.forwardExtensionEvent(msg.tabId, msg.sessionId, msg.method, msg.params);
        return;
      }
      case "tabs": {
        this.syncTabs(msg.tabs);
        return;
      }
      case "detached": {
        const tab = this.tabs.get(msg.tabId);
        if (tab?.attached) {
          this.emitDetachedFromTarget(msg.tabId, tab.attached.sessionId, tab.attached.targetId);
          tab.attached = undefined;
        }
        break;
      }
      case "pong":
        this.missedPongs = 0;
        break;
      case "hello":
        break;
    }
  }

  private handleExtensionGone(): void {
    this.extension = null;
    this.stopPing();
    for (const pending of this.pendingExtension.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("extension disconnected"));
    }
    this.pendingExtension.clear();
    // Retire attach work synchronously so a replacement snapshot cannot reuse
    // a rejected promise. Keep the tab list so the same ids can be re-exposed.
    for (const [tabId, tab] of this.tabs) {
      tab.restoreAttachment ||= tab.attached !== undefined || tab.attaching !== undefined;
      tab.attaching = undefined;
      if (tab.attached) {
        this.emitDetachedFromTarget(tabId, tab.attached.sessionId, tab.attached.targetId);
        tab.attached = undefined;
      }
    }
    this.childSessions.clear();
  }

  private startPing(): void {
    this.stopPing();
    const owner = this.extension;
    this.pingTimer = setInterval(() => {
      if (!owner || this.extension !== owner) {
        return;
      }
      // An OPEN socket can outlive a dead worker; only its pong proves commands still arrive.
      if (++this.missedPongs > 2) {
        owner.socket.close(4000, "extension heartbeat timeout");
        if (this.extension === owner) {
          this.handleExtensionGone();
          this.onStateChange?.();
        }
        return;
      }
      this.sendToExtension({ type: "ping" });
    }, EXTENSION_PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    this.missedPongs = 0;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private sendToExtension(msg: RelayToExtensionMessage): void {
    if (!this.extension) {
      throw new Error("OpenClaw Chrome extension is not connected to the relay");
    }
    this.extension.socket.send(JSON.stringify(msg));
  }

  private callExtension(
    command: RelayCommandBody,
    timeoutMs = EXTENSION_COMMAND_TIMEOUT_MS,
  ): Promise<unknown> {
    const seq = this.nextSeq++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingExtension.delete(seq);
        reject(new Error(`extension relay command timed out: ${command.type}`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingExtension.set(seq, { resolve, reject, timer });
      try {
        this.sendToExtension({ ...command, seq });
      } catch (err) {
        this.pendingExtension.delete(seq);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private syncTabs(tabs: RelayTabInfo[]): void {
    const nextIds = new Set(tabs.map((tab) => tab.tabId));
    const shouldAutoAttach = [...this.clients].some((client) => client.autoAttach);
    for (const [tabId, tab] of this.tabs) {
      if (!nextIds.has(tabId)) {
        if (tab.attached) {
          this.emitDetachedFromTarget(tabId, tab.attached.sessionId, tab.attached.targetId);
        }
        this.tabs.delete(tabId);
      }
    }
    for (const info of tabs) {
      const existing = this.tabs.get(info.tabId);
      const shouldAttach = !existing || existing.restoreAttachment;
      if (existing) {
        existing.info = info;
      } else {
        this.tabs.set(info.tabId, { info, restoreAttachment: false });
      }
      if (shouldAutoAttach && shouldAttach) {
        void this.ensureTabAttached(info.tabId)
          .then(({ targetId, sessionId }) => {
            this.announceAttachedTab(info.tabId, targetId, sessionId, { onlyAutoAttach: true });
          })
          .catch((err: unknown) => {
            log.warn(`auto-attach of accessible tab ${info.tabId} failed: ${String(err)}`);
          });
      }
    }
  }

  private async ensureTabAttached(tabId: number): Promise<{ targetId: string; sessionId: string }> {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error(`tab ${tabId} is not available to OpenClaw`);
    }
    if (tab.attached) {
      return tab.attached;
    }
    if (tab.attaching) {
      return await tab.attaching;
    }
    const attaching = (async () => {
      const result = (await this.callExtension({ type: "attach", tabId })) as {
        targetId?: unknown;
      } | null;
      const targetId = typeof result?.targetId === "string" ? result.targetId : `tab-${tabId}`;
      const sessionId = `openclaw-tab-${tabId}-${this.nextSessionOrdinal++}`;
      const attached = { targetId, sessionId };
      // Identity check, not just presence: the tab could have lost and regained
      // access under the same tabId while this attach was in flight, replacing
      // the TabState. Writing onto the new TabState would bind stale attach data.
      const current = this.tabs.get(tabId);
      if (current !== tab) {
        // Original tab vanished (or was recreated); best-effort detach the banner.
        void this.callExtension({ type: "detach", tabId }).catch(() => {});
        throw new Error(`tab ${tabId} closed during attach`);
      }
      current.attached = attached;
      current.restoreAttachment = false;
      return attached;
    })();
    tab.attaching = attaching;
    try {
      return await attaching;
    } finally {
      // A replacement extension may already have started a fresh attach for this tab.
      if (tab.attaching === attaching) {
        tab.attaching = undefined;
      }
    }
  }

  private targetInfoForTab(tab: TabState, targetId: string): Record<string, unknown> {
    return {
      targetId,
      type: "page",
      title: tab.info.title,
      url: tab.info.url,
      // connectOverCDP owns this as a persistent default context, but still
      // asserts that attached page events carry a non-empty context id.
      browserContextId: BROWSER_CONTEXT_ID,
      attached: true,
      canAccessOpener: false,
    };
  }

  private enumerateTargetInfos():
    | { status: "available"; targetInfos: Record<string, unknown>[] }
    | {
        status: "unavailable";
        reason: "extension-disconnected" | "target-identity-unresolved";
      } {
    if (!this.extensionConnected) {
      return { status: "unavailable", reason: "extension-disconnected" };
    }
    if ([...this.tabs.values()].some((tab) => !tab.attached)) {
      return { status: "unavailable", reason: "target-identity-unresolved" };
    }
    const targetInfos = [...this.tabs.values()].map((tab) =>
      this.targetInfoForTab(tab, tab.attached?.targetId ?? ""),
    );
    return { status: "available", targetInfos };
  }

  private announceAttachedTab(
    tabId: number,
    targetId: string,
    sessionId: string,
    opts: { onlyAutoAttach: boolean; onlyClient?: CdpClientState },
  ): void {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return;
    }
    const event = {
      method: "Target.attachedToTarget",
      params: {
        sessionId,
        targetInfo: this.targetInfoForTab(tab, targetId),
        waitingForDebugger: false,
      },
    };
    const recipients = opts.onlyClient
      ? [opts.onlyClient]
      : [...this.clients].filter((client) => !opts.onlyAutoAttach || client.autoAttach);
    for (const client of recipients) {
      if (client.announcedSessions.has(sessionId)) {
        continue;
      }
      client.announcedSessions.add(sessionId);
      client.socket.send(JSON.stringify(event));
    }
  }

  private emitDetachedFromTarget(tabId: number, sessionId: string, targetId: string): void {
    const event = JSON.stringify({
      method: "Target.detachedFromTarget",
      params: { sessionId, targetId },
    });
    for (const client of this.clients) {
      if (client.announcedSessions.delete(sessionId)) {
        client.socket.send(event);
      }
    }
    // Playwright's page-scoped CDP sessions listen on their synthetic parent
    // browser session, so detach those aliases there when tab access is revoked.
    for (const [auxiliarySessionId, auxiliary] of this.auxiliaryTabSessions) {
      if (auxiliary.tabId !== tabId) {
        continue;
      }
      auxiliary.client.socket.send(
        JSON.stringify({
          sessionId: auxiliary.parentSessionId,
          method: "Target.detachedFromTarget",
          params: { sessionId: auxiliarySessionId, targetId },
        }),
      );
      this.auxiliaryTabSessions.delete(auxiliarySessionId);
    }
    // Reap this tab's child sessions (iframes/workers) by owner tabId. Callers
    // clear tab.attached before/around this, so matching on the root sessionId
    // would miss every child and leak the childSessions map. Deleting the
    // current key during Map iteration is safe.
    for (const [childSessionId, ownerTabId] of this.childSessions) {
      if (ownerTabId !== tabId) {
        continue;
      }
      this.childSessions.delete(childSessionId);
      for (const client of this.clients) {
        client.announcedSessions.delete(childSessionId);
      }
    }
  }

  private forwardExtensionEvent(
    tabId: number,
    childSessionId: string | undefined,
    method: string,
    params: unknown,
  ): void {
    const tab = this.tabs.get(tabId);
    const rootSessionId = tab?.attached?.sessionId;
    if (!rootSessionId) {
      return;
    }
    const sessionId = childSessionId ?? rootSessionId;
    if (childSessionId) {
      this.childSessions.set(childSessionId, tabId);
    }
    // Child sessions announced through a parent's Target.attachedToTarget event
    // must stay routable for clients that saw the parent announcement.
    if (method === "Target.attachedToTarget") {
      const announced = (params as { sessionId?: unknown } | null)?.sessionId;
      if (typeof announced === "string") {
        this.childSessions.set(announced, tabId);
        for (const client of this.clients) {
          if (client.announcedSessions.has(sessionId)) {
            client.announcedSessions.add(announced);
          }
        }
      }
    }
    const frame = JSON.stringify({ sessionId, method, params });
    for (const client of this.clients) {
      if (client.announcedSessions.has(sessionId)) {
        client.socket.send(frame);
      }
    }
    if (!childSessionId) {
      // Page-scoped CDP sessions multiplex the same chrome.debugger root.
      // Mirror root events so Runtime/Page/Network listeners observe the
      // domains they enabled through their own synthetic session.
      for (const [auxiliarySessionId, auxiliary] of this.auxiliaryTabSessions) {
        if (auxiliary.tabId === tabId) {
          auxiliary.client.socket.send(
            JSON.stringify({ sessionId: auxiliarySessionId, method, params }),
          );
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // CDP client side (Playwright connectOverCDP)
  // ---------------------------------------------------------------------

  /** Wire up a newly accepted CDP client WebSocket. */
  attachCdpClientSocket(socket: BridgeSocket): {
    onMessage: (raw: string) => void;
    onClose: () => void;
  } {
    const client: CdpClientState = { socket, autoAttach: false, announcedSessions: new Set() };
    this.clients.add(client);
    const onMessage = (raw: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        client.socket.send(toErrorPayload(null, undefined, "Parse error", -32700));
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        client.socket.send(toErrorPayload(null, undefined, "Invalid request", -32600));
        return;
      }
      const request = parsed as Record<string, unknown>;
      if (typeof request.id !== "number" || typeof request.method !== "string") {
        const id = typeof request.id === "number" ? request.id : null;
        const sessionId = typeof request.sessionId === "string" ? request.sessionId : undefined;
        // Flat CDP routes responses by sessionId before matching the request id.
        client.socket.send(toErrorPayload(id, sessionId, "Invalid request", -32600));
        return;
      }
      void this.handleCdpRequest(client, request as CdpRequest);
    };
    const onClose = () => {
      this.clients.delete(client);
      for (const [sessionId, owner] of this.browserSessions) {
        if (owner === client) {
          this.browserSessions.delete(sessionId);
        }
      }
      for (const [sessionId, auxiliary] of this.auxiliaryTabSessions) {
        if (auxiliary.client === client) {
          this.auxiliaryTabSessions.delete(sessionId);
        }
      }
      this.detachAllWhenIdle();
    };
    return { onMessage, onClose };
  }

  /**
   * Drop chrome.debugger sessions once no CDP client is connected so the
   * "OpenClaw is debugging this browser" infobar only spans active automation.
   */
  private detachAllWhenIdle(): void {
    if (this.clients.size > 0 || !this.extension) {
      return;
    }
    for (const [tabId, tab] of this.tabs) {
      if (tab.attached) {
        const { sessionId, targetId } = tab.attached;
        tab.attached = undefined;
        this.emitDetachedFromTarget(tabId, sessionId, targetId);
        void this.callExtension({ type: "detach", tabId }).catch(() => {});
      }
    }
  }

  private respond(client: CdpClientState, request: CdpRequest, result: unknown): void {
    client.socket.send(
      JSON.stringify({
        id: request.id,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        result: result ?? {},
      }),
    );
  }

  private respondError(
    client: CdpClientState,
    request: CdpRequest,
    message: string,
    code = -32000,
  ): void {
    client.socket.send(toErrorPayload(request.id, request.sessionId, message, code));
  }

  private tabBySessionId(sessionId: string): { tabId: number; child: boolean } | null {
    for (const [tabId, tab] of this.tabs) {
      if (tab.attached?.sessionId === sessionId) {
        return { tabId, child: false };
      }
    }
    const auxiliary = this.auxiliaryTabSessions.get(sessionId);
    if (auxiliary) {
      return { tabId: auxiliary.tabId, child: false };
    }
    const childOwner = this.childSessions.get(sessionId);
    if (childOwner !== undefined) {
      return { tabId: childOwner, child: true };
    }
    return null;
  }

  private tabByTargetId(targetId: string): { tabId: number; tab: TabState } | null {
    for (const [tabId, tab] of this.tabs) {
      if (tab.attached?.targetId === targetId) {
        return { tabId, tab };
      }
    }
    return null;
  }

  private async handleCdpRequest(client: CdpClientState, request: CdpRequest): Promise<void> {
    try {
      if (request.sessionId) {
        if (this.browserSessions.get(request.sessionId) === client) {
          await this.handleBrowserScopedRequest(client, request);
          return;
        }
        await this.handleSessionScopedRequest(client, request);
        return;
      }
      await this.handleBrowserScopedRequest(client, request);
    } catch (err) {
      this.respondError(client, request, err instanceof Error ? err.message : String(err));
    }
  }

  private async handleSessionScopedRequest(
    client: CdpClientState,
    request: CdpRequest,
  ): Promise<void> {
    const sessionId = request.sessionId as string;
    const auxiliary = this.auxiliaryTabSessions.get(sessionId);
    if (auxiliary && auxiliary.client !== client) {
      this.respondError(client, request, `Session not found: ${sessionId}`, -32001);
      return;
    }
    const route = this.tabBySessionId(sessionId);
    if (!route) {
      this.respondError(client, request, `Session not found: ${sessionId}`, -32001);
      return;
    }
    const result = await this.callExtension({
      type: "cdp",
      tabId: route.tabId,
      ...(route.child ? { sessionId } : {}),
      method: request.method,
      params: request.params,
    });
    this.respond(client, request, result);
  }

  private async handleBrowserScopedRequest(
    client: CdpClientState,
    request: CdpRequest,
  ): Promise<void> {
    switch (request.method) {
      case "Browser.getVersion": {
        const identity = this.extension?.identity;
        this.respond(client, request, {
          protocolVersion: "1.3",
          product: identity?.browserVersion ?? "Chrome/unknown",
          revision: "openclaw-extension-relay",
          userAgent: identity?.userAgent ?? "unknown",
          jsVersion: "",
        });
        return;
      }
      case "Browser.close": {
        // Never close the user's real browser; end this automation client only.
        this.respond(client, request, {});
        client.socket.close(1000, "Browser.close");
        return;
      }
      // Browser-level knobs chrome.debugger cannot reach; acknowledging keeps
      // Playwright's default-context bootstrap happy with browser defaults.
      case "Browser.setDownloadBehavior":
      case "Target.setDiscoverTargets": {
        this.respond(client, request, {});
        return;
      }
      case "Target.getTargetInfo": {
        const targetId = request.params?.targetId as string | undefined;
        if (!targetId || targetId === BROWSER_TARGET_ID) {
          this.respond(client, request, {
            targetInfo: {
              targetId: BROWSER_TARGET_ID,
              type: "browser",
              title: "OpenClaw Extension Relay",
              url: "",
              attached: true,
              canAccessOpener: false,
            },
          });
          return;
        }
        const found = this.tabByTargetId(targetId);
        if (!found) {
          this.respondError(client, request, `No target with given id found: ${targetId}`, -32602);
          return;
        }
        this.respond(client, request, {
          targetInfo: this.targetInfoForTab(found.tab, targetId),
        });
        return;
      }
      case "Target.getTargets": {
        const enumeration = this.enumerateTargetInfos();
        if (enumeration.status === "unavailable") {
          const message =
            enumeration.reason === "extension-disconnected"
              ? "Extension is disconnected"
              : "Target identities are unavailable";
          this.respondError(client, request, message, -32002);
          return;
        }
        this.respond(client, request, { targetInfos: enumeration.targetInfos });
        return;
      }
      case "Target.attachToBrowserTarget": {
        const sessionId = `openclaw-browser-${this.nextSessionOrdinal++}`;
        this.browserSessions.set(sessionId, client);
        this.respond(client, request, { sessionId });
        return;
      }
      case "Target.setAutoAttach": {
        const autoAttach = request.params?.autoAttach !== false;
        client.autoAttach = autoAttach;
        if (autoAttach) {
          const attachResults = await Promise.allSettled(
            [...this.tabs.keys()].map(async (tabId) => {
              const { targetId, sessionId } = await this.ensureTabAttached(tabId);
              return { tabId, targetId, sessionId };
            }),
          );
          for (const settled of attachResults) {
            if (settled.status === "fulfilled") {
              this.announceAttachedTab(
                settled.value.tabId,
                settled.value.targetId,
                settled.value.sessionId,
                {
                  onlyAutoAttach: false,
                  onlyClient: client,
                },
              );
            } else {
              log.warn(`setAutoAttach attach failed: ${String(settled.reason)}`);
            }
          }
        }
        this.respond(client, request, {});
        return;
      }
      case "Target.attachToTarget": {
        const targetId = request.params?.targetId as string | undefined;
        const found = targetId ? this.tabByTargetId(targetId) : null;
        // Also allow attach by tab that is accessible but not yet debugger-attached.
        if (!found && targetId) {
          this.respondError(client, request, `No target with given id found: ${targetId}`, -32602);
          return;
        }
        if (!found) {
          this.respondError(client, request, "targetId is required", -32602);
          return;
        }
        const attached = await this.ensureTabAttached(found.tabId);
        if (request.sessionId && this.browserSessions.get(request.sessionId) === client) {
          // Playwright creates a fresh page-scoped session for helpers such as
          // Target.getTargetInfo and DOM refs. Multiplex it onto the one real
          // chrome.debugger attachment instead of reusing the auto-attach id.
          const sessionId = `openclaw-tab-${found.tabId}-${this.nextSessionOrdinal++}`;
          this.auxiliaryTabSessions.set(sessionId, {
            tabId: found.tabId,
            parentSessionId: request.sessionId,
            client,
          });
          this.respond(client, request, { sessionId });
          return;
        }
        this.announceAttachedTab(found.tabId, attached.targetId, attached.sessionId, {
          onlyAutoAttach: false,
          onlyClient: client,
        });
        this.respond(client, request, { sessionId: attached.sessionId });
        return;
      }
      case "Target.detachFromTarget": {
        const sessionId = request.params?.sessionId as string | undefined;
        if (sessionId && this.browserSessions.get(sessionId) === client) {
          this.browserSessions.delete(sessionId);
          for (const [auxiliarySessionId, auxiliary] of this.auxiliaryTabSessions) {
            if (auxiliary.parentSessionId === sessionId && auxiliary.client === client) {
              this.auxiliaryTabSessions.delete(auxiliarySessionId);
            }
          }
          this.respond(client, request, {});
          return;
        }
        const auxiliary = sessionId ? this.auxiliaryTabSessions.get(sessionId) : undefined;
        if (auxiliary?.client === client) {
          this.auxiliaryTabSessions.delete(sessionId as string);
          this.respond(client, request, {});
          return;
        }
        if (auxiliary) {
          this.respondError(client, request, `Session not found: ${String(sessionId)}`, -32001);
          return;
        }
        const route = sessionId ? this.tabBySessionId(sessionId) : null;
        if (route && !route.child) {
          const tab = this.tabs.get(route.tabId);
          if (tab?.attached) {
            const { sessionId: rootSession, targetId } = tab.attached;
            tab.attached = undefined;
            this.emitDetachedFromTarget(route.tabId, rootSession, targetId);
            await this.callExtension({ type: "detach", tabId: route.tabId }).catch(() => {});
          }
        }
        this.respond(client, request, {});
        return;
      }
      case "Target.createTarget": {
        const url = typeof request.params?.url === "string" ? request.params.url : "about:blank";
        const createParams = resolveCreateTargetParams(request.params);
        const command = { type: "createTab", url, ...createParams } as const;
        const created = (await this.callExtension(command)) as { tabId?: unknown } | null;
        if (typeof created?.tabId !== "number") {
          this.respondError(client, request, "extension did not return a tabId for createTab");
          return;
        }
        const tabId = created.tabId;
        if (!this.tabs.has(tabId)) {
          this.tabs.set(tabId, {
            info: { tabId, url, title: "", active: false },
            restoreAttachment: false,
          });
        }
        const attached = await this.ensureTabAttached(tabId);
        // Announce before responding, mirroring Chrome's event-then-result order.
        this.announceAttachedTab(tabId, attached.targetId, attached.sessionId, {
          onlyAutoAttach: true,
        });
        this.announceAttachedTab(tabId, attached.targetId, attached.sessionId, {
          onlyAutoAttach: false,
          onlyClient: client,
        });
        this.respond(client, request, { targetId: attached.targetId });
        return;
      }
      case "Target.closeTarget": {
        const targetId = request.params?.targetId as string | undefined;
        const found = targetId ? this.tabByTargetId(targetId) : null;
        if (!found) {
          this.respondError(
            client,
            request,
            `No target with given id found: ${String(targetId)}`,
            -32602,
          );
          return;
        }
        await this.callExtension({ type: "closeTab", tabId: found.tabId });
        this.respond(client, request, { success: true });
        return;
      }
      case "Target.activateTarget": {
        const targetId = request.params?.targetId as string | undefined;
        const found = targetId ? this.tabByTargetId(targetId) : null;
        if (!found) {
          this.respondError(
            client,
            request,
            `No target with given id found: ${String(targetId)}`,
            -32602,
          );
          return;
        }
        await this.callExtension({ type: "activateTab", tabId: found.tabId });
        this.respond(client, request, {});
        return;
      }
      case "Target.getBrowserContexts": {
        // Real Chrome reports only contexts made via Target.createBrowserContext
        // here — never the default one — so the relay's answer is always empty.
        // Puppeteer's connect bootstrap (chrome-devtools-mcp) requires this.
        this.respond(client, request, { browserContextIds: [] });
        return;
      }
      case "Target.createBrowserContext": {
        this.respondError(
          client,
          request,
          "The OpenClaw extension relay drives the user's real browser profile; isolated browser contexts are not supported.",
        );
        return;
      }
      default: {
        this.respondError(client, request, `'${request.method}' wasn't found`, -32601);
      }
    }
  }

  /** Close all sockets and reject pending work (relay shutdown). */
  dispose(): void {
    this.stopPing();
    for (const pending of this.pendingExtension.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("extension relay stopped"));
    }
    this.pendingExtension.clear();
    for (const candidate of this.extensionCandidates) {
      candidate.close(1001, "relay stopped");
    }
    this.extensionCandidates.clear();
    this.extension?.socket.close(1001, "relay stopped");
    this.extension = null;
    this.connectionEvents.dispatchEvent(new Event("ready"));
    for (const client of this.clients) {
      client.socket.close(1001, "relay stopped");
    }
    this.clients.clear();
    this.browserSessions.clear();
    this.auxiliaryTabSessions.clear();
    this.tabs.clear();
    this.childSessions.clear();
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
