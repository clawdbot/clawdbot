/**
 * Extension relay CDP bridge.
 *
 * Presents a CDP browser endpoint (compatible with Playwright connectOverCDP)
 * on one side and the OpenClaw Chrome extension's chrome.debugger transport on
 * the other. The bridge owns all Target.* synthesis so the extension stays a
 * thin forwarder — the old assets/chrome-extension put this logic in an
 * untestable MV3 service worker, which is why it rotted and was removed.
 */
import { addAbortListener, once } from "node:events";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveCreateTargetParams } from "./create-target-params.js";
import {
  type ExtensionToRelayMessage,
  parseExtensionMessage,
  type RelayCommandBody,
  type RelayTabInfo,
  type RelayToExtensionMessage,
} from "./relay-protocol.js";
import { RelaySessionOwner, type RelaySessionClient } from "./relay-session-owner.js";

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
  claimants: Set<{ client: CdpClientState }>;
  /** Target identity lasts until access/extension loss; only the session ends on detach. */
  target?: { id: string; sessionId?: string };
  attaching?: Promise<{ targetId: string; sessionId: string }>;
  retiring?: Promise<void>;
  /** Extension loss invalidated attachment work that auto-attach clients still expect restored. */
  restoreAttachment: boolean;
};

type CdpClientState = RelaySessionClient & {
  socket: BridgeSocket;
  autoAttach: boolean;
  creating: Set<Promise<void>>;
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
  extensionGeneration = 0;
  private readonly extensionCandidates = new Set<BridgeSocket>();
  private readonly clients = new Set<CdpClientState>();
  private readonly tabs = new Map<number, TabState>();
  /** Browser-level sessions created by Playwright for page-scoped CDP access. */
  private readonly browserSessions = new Map<string, CdpClientState>();
  private readonly sessions = new RelaySessionOwner(
    this.clients,
    (root) => this.retireAttachment(root),
    (error) => log.warn(`Debugger cleanup incomplete: ${String(error)}`),
    (tabId) => (this.tabs.get(tabId)?.claimants.size ?? 0) > 0,
  );
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
  captureOperationTarget(
    targetId: string,
  ): ((() => string | undefined) & { isCurrent: () => boolean }) | undefined {
    const extension = this.extension;
    const target = this.tabByTargetId(targetId);
    if (!extension || !target) {
      return undefined;
    }
    // Chrome tab ids survive renderer swaps but can be reused by another browser;
    // pin both the authenticated extension owner and the exact granted tab instance.
    const isCurrent = () =>
      this.extension === extension && this.tabs.get(target.tabId) === target.tab;
    return Object.assign(
      () => (isCurrent() && target.tab.target?.sessionId ? target.tab.target.id : undefined),
      { isCurrent },
    );
  }

  /**
   * DevTools-style descriptors for `/json/list`: RelayTabInfo plus the `id`
   * and `type` fields CDP discovery clients expect. `id` is the live debugger
   * targetId once a tab is attached; before that it is the same `tab-<tabId>`
   * discovery-only placeholder; native attachment never fabricates an identity.
   * No per-target webSocketDebuggerUrl: all CDP traffic multiplexes over the
   * single browser endpoint (`/cdp`).
   */
  devtoolsTargetDescriptors(): Array<RelayTabInfo & { id: string; type: string }> {
    return [...this.tabs.values()].map((tab) => ({
      tabId: tab.info.tabId,
      url: tab.info.url,
      title: tab.info.title,
      active: tab.info.active,
      id: tab.target?.id ?? `tab-${tab.info.tabId}`,
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
        this.extensionGeneration += 1;
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
        const root = this.tabs.get(msg.tabId)?.target?.sessionId;
        if (root) {
          this.sessions.forward(root, msg.sessionId, msg.method, msg.params);
        }
        return;
      }
      case "tabs": {
        this.syncTabs(msg.tabs);
        return;
      }
      case "detached": {
        const tab = this.tabs.get(msg.tabId);
        if (tab) {
          tab.attaching = undefined;
        }
        this.sessions.retireTab(msg.tabId);
        if (tab?.target) {
          tab.target.sessionId = undefined;
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
    this.sessions.dispose();
    // Retire attach work synchronously so a replacement snapshot cannot reuse
    // a rejected promise. Keep the tab list so the same ids can be re-exposed.
    for (const tab of this.tabs.values()) {
      tab.restoreAttachment ||= tab.target?.sessionId !== undefined || tab.attaching !== undefined;
      tab.attaching = undefined;
      tab.retiring = undefined;
      tab.target = undefined;
    }
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
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const seq = this.nextSeq++;
    let abortListener: Disposable | undefined;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingExtension.delete(seq);
        reject(new Error(`extension relay command timed out: ${command.type}`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingExtension.set(seq, { resolve, reject, timer });
      if (signal) {
        abortListener = addAbortListener(signal, () => {
          this.pendingExtension.delete(seq);
          clearTimeout(timer);
          reject(new Error("Physical session detached"));
        });
      }
      try {
        this.sendToExtension({ ...command, seq });
      } catch (err) {
        this.pendingExtension.delete(seq);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    return result.finally(() => abortListener?.[Symbol.dispose]());
  }

  private syncTabs(tabs: RelayTabInfo[]): void {
    const nextIds = new Set(tabs.map((tab) => tab.tabId));
    const shouldAutoAttach = [...this.clients].some((client) => client.autoAttach);
    for (const tabId of this.tabs.keys()) {
      if (!nextIds.has(tabId)) {
        this.sessions.retireTab(tabId);
        this.tabs.delete(tabId);
      }
    }
    for (const info of tabs) {
      const existing = this.tabs.get(info.tabId);
      const shouldAttach = !existing || existing.restoreAttachment;
      if (existing) {
        existing.info = info;
      } else {
        this.tabs.set(info.tabId, { info, claimants: new Set(), restoreAttachment: false });
      }
      if (shouldAutoAttach && shouldAttach) {
        for (const client of this.clients) {
          if (!client.autoAttach) {
            continue;
          }
          void this.withAttachedTab(client, info.tabId, (attached) => {
            if (client.autoAttach) {
              this.announceAttachedTab(info.tabId, attached, [client]);
            }
          }).catch((err: unknown) =>
            log.warn(`auto-attach of accessible tab ${info.tabId} failed: ${String(err)}`),
          );
        }
      }
    }
  }

  private async withAttachedTab<T>(
    client: CdpClientState,
    tabId: number,
    use: (attached: { targetId: string; sessionId: string }) => T,
    createdTargetId?: string,
  ): Promise<T> {
    const tab = this.tabs.get(tabId);
    const extension = this.extension;
    if (!tab) {
      throw new Error(`tab ${tabId} is not available to OpenClaw`);
    }
    // A pending claimant keeps the physical acquisition alive through announcement.
    // Use a distinct token even for concurrent acquisitions by the same client.
    const claimant = { client };
    tab.claimants.add(claimant);
    try {
      const attached = await this.ensureTabAttached(tabId, createdTargetId);
      if (
        !this.clients.has(client) ||
        this.tabs.get(tabId) !== tab ||
        this.extension !== extension
      ) {
        throw new Error("Target claimant retired");
      }
      return use(attached);
    } finally {
      tab.claimants.delete(claimant);
      void this.detachUnusedAttachments();
    }
  }

  private async ensureTabAttached(
    tabId: number,
    createdTargetId?: string,
  ): Promise<{ targetId: string; sessionId: string }> {
    const extension = this.extension;
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error(`tab ${tabId} is not available to OpenClaw`);
    }
    if (tab.retiring) {
      await tab.retiring;
      if (this.tabs.get(tabId) !== tab || this.extension !== extension) {
        throw new Error(`tab ${tabId} closed during retirement`);
      }
    }
    if (tab.target?.sessionId) {
      return { targetId: tab.target.id, sessionId: tab.target.sessionId };
    }
    if (tab.attaching) {
      return await tab.attaching;
    }
    // Even atomic creation completes in a continuation: the pending identity
    // must be installed before a detach or extension replacement can retire it.
    const attachment =
      createdTargetId !== undefined
        ? Promise.resolve({ targetId: createdTargetId })
        : this.callExtension({ type: "attach", tabId });
    const attaching = attachment.then(async (response) => {
      const result = asOptionalRecord(response);
      const targetId = result?.targetId;
      if (typeof targetId !== "string" || !targetId) {
        if (
          this.extension === extension &&
          this.tabs.get(tabId) === tab &&
          tab.attaching === attaching
        ) {
          await this.callExtension({ type: "detach", tabId });
        }
        throw new Error("Extension did not return a native target identity");
      }
      const sessionId = `openclaw-tab-${tabId}-${this.nextSessionOrdinal++}`;
      const attached = { targetId, sessionId };
      // Identity check, not just presence: the tab could have lost and regained
      // access under the same tabId while this attach was in flight, replacing
      // the TabState. Writing onto the new TabState would bind stale attach data.
      const current = this.tabs.get(tabId);
      if (current !== tab || this.extension !== extension || tab.attaching !== attaching) {
        throw new Error(`tab ${tabId} closed during attach`);
      }
      current.target = { id: targetId, sessionId };
      this.sessions.registerRoot(
        tabId,
        targetId,
        sessionId,
        async (childSessionId, method, params, signal) => {
          const assertCurrent = () => {
            signal.throwIfAborted();
            if (this.extension !== extension || this.tabs.get(tabId) !== tab) {
              throw new Error("Extension or tab generation retired");
            }
          };
          assertCurrent();
          const commandResult = await this.callExtension(
            {
              type: "cdp",
              tabId,
              ...(childSessionId ? { sessionId: childSessionId } : {}),
              method,
              params,
            },
            EXTENSION_COMMAND_TIMEOUT_MS,
            signal,
          );
          assertCurrent();
          return commandResult;
        },
      );
      current.restoreAttachment = false;
      return attached;
    });
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
      attached: Boolean(tab.target?.sessionId),
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
    if ([...this.tabs.values()].some((tab) => !tab.target)) {
      return { status: "unavailable", reason: "target-identity-unresolved" };
    }
    const targetInfos = [...this.tabs.values()].map((tab) =>
      this.targetInfoForTab(tab, tab.target?.id ?? ""),
    );
    return { status: "available", targetInfos };
  }

  private announceAttachedTab(
    tabId: number,
    attached: { targetId: string; sessionId: string },
    recipients: readonly CdpClientState[],
  ): void {
    const tab = this.tabs.get(tabId);
    const { targetId, sessionId } = attached;
    if (tab?.target?.sessionId !== sessionId) {
      return;
    }
    const params = {
      sessionId,
      targetInfo: this.targetInfoForTab(tab, targetId),
      waitingForDebugger: false,
    };
    for (const client of recipients) {
      this.sessions.announce(client, sessionId, sessionId, params);
    }
  }

  // ---------------------------------------------------------------------
  // CDP client side (Playwright connectOverCDP)
  // ---------------------------------------------------------------------

  /** Wire up a newly accepted CDP client WebSocket. */
  attachCdpClientSocket(socket: BridgeSocket): {
    onMessage: (raw: string) => void;
    onClose: () => Promise<void>;
  } {
    const client: CdpClientState = {
      socket,
      autoAttach: false,
      sessions: new Map(),
      creating: new Set(),
    };
    this.clients.add(client);
    const onMessage = (raw: string) => {
      if (!this.clients.has(client)) {
        return;
      }
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
    const onClose = async () => {
      this.clients.delete(client);
      const acquisitions: Promise<unknown>[] = [...client.creating];
      for (const tab of this.tabs.values()) {
        for (const claim of tab.claimants) {
          if (claim.client === client) {
            tab.claimants.delete(claim);
            if (tab.attaching) {
              acquisitions.push(tab.attaching.then(() => this.detachUnusedAttachments()));
            }
          }
        }
      }
      const cleanup = this.sessions.close(client);
      for (const [sessionId, owner] of this.browserSessions) {
        if (owner === client) {
          this.browserSessions.delete(sessionId);
        }
      }
      // A socket can close before an earlier acquisition returns its native identity.
      // Its acknowledgement includes the eventual detach, not only today's sessions.
      await Promise.all([cleanup, ...acquisitions, this.detachUnusedAttachments()]);
    };
    return { onMessage, onClose };
  }

  /**
   * Release a tab only after its last pending or delivered logical claimant leaves.
   */
  private detachUnusedAttachments(): Promise<void> {
    if (!this.extension) {
      return Promise.resolve();
    }
    const retirements: Promise<void>[] = [];
    for (const tab of this.tabs.values()) {
      if (tab.retiring) {
        retirements.push(tab.retiring);
      } else if (
        tab.target?.sessionId &&
        tab.claimants.size === 0 &&
        !this.sessions.hasRootSessions(tab.target.sessionId)
      ) {
        retirements.push(this.retireAttachment(tab.target.sessionId));
      }
    }
    const cleanup = Promise.all(retirements).then(() => {});
    void cleanup.catch((error: unknown) =>
      log.warn(`Debugger retirement failed: ${String(error)}`),
    );
    return cleanup;
  }

  private retireAttachment(rootSessionId: string): Promise<void> {
    const entry = [...this.tabs].find(([, tab]) => tab.target?.sessionId === rootSessionId);
    if (!entry) {
      return Promise.resolve();
    }
    const [tabId, tab] = entry;
    const extension = this.extension;
    const target = tab.target;
    if (!target) {
      return Promise.resolve();
    }
    target.sessionId = undefined;
    const retiring = this.sessions.retire(rootSessionId, async () => {
      if (this.extension === extension && this.tabs.get(tabId) === tab) {
        await this.callExtension({ type: "detach", tabId });
      }
    });
    // This promise orders the current attempt, not native authority. After it
    // settles, a fresh worker acquire must discharge exact native cleanup debt.
    tab.retiring = retiring;
    void retiring
      .finally(() => {
        if (tab.retiring === retiring) {
          tab.retiring = undefined;
        }
      })
      .catch(() => {});
    return retiring;
  }

  private respond(client: CdpClientState, request: CdpRequest, result: unknown): void {
    if (!this.clients.has(client)) {
      return;
    }
    const logical = request.sessionId ? client.sessions.get(request.sessionId) : undefined;
    if (logical) {
      this.sessions.emit(logical, { id: request.id, result: result ?? {} });
      return;
    }
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
    if (this.clients.has(client)) {
      const logical = request.sessionId ? client.sessions.get(request.sessionId) : undefined;
      if (logical) {
        this.sessions.emit(logical, { id: request.id, error: { code, message } });
      } else {
        client.socket.send(toErrorPayload(request.id, request.sessionId, message, code));
      }
    }
  }

  private tabByTargetId(targetId: string): { tabId: number; tab: TabState } | null {
    for (const [tabId, tab] of this.tabs) {
      if (tab.target?.id === targetId) {
        return { tabId, tab };
      }
    }
    return null;
  }

  private async createTarget(client: CdpClientState, request: CdpRequest): Promise<void> {
    const extension = this.extension;
    const url =
      typeof request.params?.url === "string" && request.params.url
        ? request.params.url
        : "about:blank";
    const createParams = resolveCreateTargetParams(request.params);
    const command = { type: "createTab", url, ...createParams } as const;
    const created = (await this.callExtension(command)) as {
      tabId?: unknown;
      targetId?: unknown;
    } | null;
    if (this.extension !== extension) {
      return;
    }
    if (typeof created?.tabId !== "number") {
      this.respondError(client, request, "extension did not return a tabId for createTab");
      return;
    }
    const tabId = created.tabId;
    if (!this.clients.has(client) && !this.tabs.has(tabId)) {
      // An abandoned creator never publishes an invented inventory entry.
      // No tab record means no pending/delivered peer can own this handoff.
      if (typeof created.targetId === "string") {
        await this.callExtension({ type: "detach", tabId });
      }
      return;
    }
    if (!this.tabs.has(tabId)) {
      this.tabs.set(tabId, {
        info: { tabId, url, title: "", active: false },
        claimants: new Set(),
        restoreAttachment: false,
      });
    }
    // Store 2.2.0 returns only tabId and still needs the separate attach.
    // New workers own create/group/attach/rollback and return the attachment.
    await this.withAttachedTab(
      client,
      tabId,
      (attached) => {
        const recipients = [...this.clients].filter((recipient) => recipient.autoAttach);
        this.announceAttachedTab(tabId, attached, recipients);
        this.announceAttachedTab(tabId, attached, [client]);
        this.respond(client, request, { targetId: attached.targetId });
      },
      typeof created.targetId === "string" ? created.targetId : undefined,
    );
  }

  private handleCdpRequest(client: CdpClientState, request: CdpRequest): Promise<void> {
    const session = request.sessionId ? client.sessions.get(request.sessionId) : undefined;
    const dispatch =
      request.sessionId && this.browserSessions.get(request.sessionId) !== client
        ? this.handleSessionScopedRequest(client, request)
        : this.handleBrowserScopedRequest(client, request);
    const completed = dispatch.catch((err: unknown) => {
      this.respondError(client, request, err instanceof Error ? err.message : String(err));
    });
    if (session && request.method === "Page.getFrameTree") {
      // Playwright's CRPage installs Runtime listeners after this reply. Worker access
      // rechecks can delay it past native events; order only this session's Runtime enable.
      const ready = Promise.all([session.frameTreeRead, completed]).then(() => {});
      session.frameTreeRead = ready;
      void ready.then(() => {
        if (session.frameTreeRead === ready) {
          session.frameTreeRead = undefined;
        }
      });
    }
    return completed;
  }

  private async handleSessionScopedRequest(
    client: CdpClientState,
    request: CdpRequest,
  ): Promise<void> {
    const sessionId = request.sessionId as string;
    const session = client.sessions.get(sessionId);
    if (!session) {
      this.respondError(client, request, `Session not found: ${sessionId}`, -32001);
      return;
    }
    if (request.method === "Target.detachFromTarget") {
      const child = this.sessions.child(session, request.params);
      await this.sessions.detach(client, child.id);
      this.respond(client, request, {});
      return;
    }
    if (request.method === "Target.sendMessageToTarget") {
      const child = this.sessions.child(session, request.params);
      if (child.flat || typeof request.params?.message !== "string") {
        throw new Error("Non-flat Target child session not found");
      }
      const nested = asOptionalRecord(JSON.parse(request.params.message));
      if (!nested || typeof nested.id !== "number" || typeof nested.method !== "string") {
        throw new Error("Invalid Target message");
      }
      const target =
        nested.sessionId === undefined
          ? child
          : typeof nested.sessionId === "string"
            ? client.sessions.get(nested.sessionId)
            : undefined;
      let ancestor = target;
      while (ancestor && ancestor !== child && ancestor.flat) {
        ancestor = ancestor.parent;
      }
      if (!target || ancestor !== child) {
        throw new Error("Nested Target session not found");
      }
      void this.handleCdpRequest(client, {
        id: nested.id,
        method: nested.method,
        params: asOptionalRecord(nested.params),
        sessionId: target.id,
      });
      this.respond(client, request, {});
      return;
    }
    if (request.method === "Target.setAutoAttach") {
      const result = await session.physical.target.command(session, request.params, () => {
        if (client.sessions.get(sessionId) !== session || !this.clients.has(client)) {
          throw new Error("Target parent detached");
        }
      });
      this.respond(client, request, result);
      return;
    }
    const { runtime, fetch } = session.physical;
    const emit = (method: string, params: unknown) =>
      this.sessions.emit(session, { method, params });
    const fetchResult = fetch.command(session, emit, request.method, request.params);
    if (fetchResult) {
      const result = await fetchResult;
      if (client.sessions.get(sessionId) !== session) {
        throw new Error(`Session detached: ${sessionId}`);
      }
      this.respond(client, request, result);
      return;
    }
    if (request.method === "Runtime.disable") {
      session.runtimeGeneration++;
      runtime.disable(session);
      this.respond(client, request, {});
      return;
    }
    if (request.method === "Runtime.enable" && session.frameTreeRead) {
      // Disable can retire this pending enable while a peer keeps the physical Runtime alive.
      const generation = session.runtimeGeneration;
      await session.frameTreeRead;
      if (
        !this.clients.has(client) ||
        client.sessions.get(sessionId) !== session ||
        session.runtimeGeneration !== generation
      ) {
        throw new Error("Runtime session detached or disabled");
      }
    }
    const send = () =>
      this.sessions.send(
        session.physical,
        request.method,
        request.params,
        request.method === "Runtime.runIfWaitingForDebugger" ? "target" : undefined,
      );
    const result =
      request.method === "Runtime.enable"
        ? await runtime.enable(session, emit, send)
        : request.method === "Runtime.addBinding" || request.method === "Runtime.removeBinding"
          ? await runtime.binding(session, emit, request.method, request.params)
          : await send();
    if (client.sessions.get(sessionId) !== session) {
      throw new Error(`Session detached: ${sessionId}`);
    }
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
            [...this.tabs.keys()].map((tabId) =>
              this.withAttachedTab(client, tabId, (attached) => {
                if (client.autoAttach) {
                  this.announceAttachedTab(tabId, attached, [client]);
                }
              }),
            ),
          );
          for (const settled of attachResults) {
            if (settled.status === "rejected") {
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
        await this.withAttachedTab(client, found.tabId, (attached) => {
          if (attached.targetId !== targetId) {
            throw new Error("Requested native target changed during attachment");
          }
          if (
            found.tab.target?.sessionId !== attached.sessionId ||
            (request.sessionId && this.browserSessions.get(request.sessionId) !== client)
          ) {
            throw new Error("Target attachment retired");
          }
          const sessionId = `openclaw-tab-${found.tabId}-${this.nextSessionOrdinal++}`;
          this.sessions.announce(
            client,
            sessionId,
            attached.sessionId,
            {
              sessionId,
              targetInfo: this.targetInfoForTab(found.tab, attached.targetId),
              waitingForDebugger: false,
            },
            request.sessionId,
          );
          this.respond(client, request, { sessionId });
        });
        return;
      }
      case "Target.detachFromTarget": {
        const sessionId = request.params?.sessionId as string | undefined;
        if (sessionId && this.browserSessions.get(sessionId) === client) {
          this.browserSessions.delete(sessionId);
          await this.sessions.detachChildren(client, sessionId);
        } else {
          const session = sessionId ? client.sessions.get(sessionId) : undefined;
          if (!sessionId || !session) {
            this.respondError(client, request, `Session not found: ${String(sessionId)}`, -32001);
            return;
          }
          await this.sessions.detach(client, sessionId);
        }
        this.respond(client, request, {});
        return;
      }
      case "Target.createTarget": {
        const creating = this.createTarget(client, request);
        client.creating.add(creating);
        try {
          await creating;
        } finally {
          client.creating.delete(creating);
        }
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
    this.sessions.dispose();
    for (const client of this.clients) {
      client.socket.close(1001, "relay stopped");
    }
    this.clients.clear();
    this.browserSessions.clear();
    this.tabs.clear();
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
