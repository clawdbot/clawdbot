import type {
  BoardChangedEvent,
  BoardCommand,
  BoardCommandEvent,
  BoardOp,
  BoardSnapshot,
  BoardWidgetAppViewResult,
} from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import {
  buildAgentMainSessionKey,
  normalizeSessionKeyForUiComparison,
} from "../sessions/session-key.ts";
import { BoardMcpAppViewCache } from "./mcp-app-view-cache.ts";
import { applyMockBoardOp, normalizeMockBoardSnapshot } from "./mock-ops.ts";
import type { BoardWidgetAppViewState } from "./view-types.ts";
export type { BoardCommandEvent };
export type { BoardViewCallbacks, BoardWidgetAppViewState } from "./view-types.ts";

type BoardGatewayClient = Pick<GatewayBrowserClient, "request" | "addEventListener">;

type BoardPinPlacement = {
  title?: string;
  name?: string;
  tabId?: string;
  size?: "sm" | "md" | "lg" | "xl" | "full";
  after?: string;
};

type BoardPinWidgetInput = BoardPinPlacement & { docId: string };
type BoardPinMcpAppInput = BoardPinPlacement & { viewId: string };

type BoardSnapshotSignal = {
  readonly value: BoardSnapshot;
  subscribe(listener: () => void): () => void;
};

type BoardEventStream = {
  subscribe(listener: (event: BoardCommandEvent) => void): () => void;
};

export type BoardProvider = {
  readonly sessionKey: string;
  readonly canPinWidgets: boolean;
  readonly canPinMcpApps: boolean;
  readonly snapshot$: BoardSnapshotSignal;
  applyOps(ops: BoardOp[]): Promise<void>;
  grant(name: string, decision: "granted" | "rejected"): Promise<void>;
  pinWidget(input: BoardPinWidgetInput): Promise<void>;
  pinMcpApp(input: BoardPinMcpAppInput): Promise<void>;
  widgetFrameUrl(name: string, revision: number): string;
  refreshWidgetFrame(name: string): Promise<void>;
  widgetAppView(name: string, revision: number): Promise<BoardWidgetAppViewState>;
  refreshWidgetAppView(name: string, revision: number): Promise<BoardWidgetAppViewState>;
  readonly events: BoardEventStream;
};

function hashWidgetIdentity(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function canvasWidgetNameForDocument(docId: string): string {
  const name = `canvas-${docId.toLowerCase().replace(/[^a-z0-9._-]/gu, "-")}`;
  if (name === `canvas-${docId}` && name.length <= 64) {
    return name;
  }
  const prefix = name.slice(0, 47).replace(/[._-]+$/gu, "") || "canvas-widget";
  return `${prefix}-${hashWidgetIdentity(docId)}`;
}

export function mcpAppWidgetNameForViewId(viewId: string): string {
  return `mcp-app-${hashWidgetIdentity(viewId)}`;
}

class ValueSignal<T> {
  private readonly listeners = new Set<() => void>();

  constructor(public value: T) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(value: T): void {
    this.value = value;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

class EventStream<T> {
  private readonly listeners = new Set<(event: T) => void>();

  subscribe(listener: (event: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: T): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function emptySnapshot(sessionKey: string): BoardSnapshot {
  return { sessionKey, revision: 0, tabs: [], widgets: [] };
}

function boardWidgetTitle(title: string | undefined): string | undefined {
  const normalized = title?.trim() ?? "";
  return normalized ? Array.from(normalized).slice(0, 80).join("") : undefined;
}

function mockSnapshot(sessionKey: string): BoardSnapshot {
  return {
    sessionKey,
    revision: 1,
    tabs: [
      { tabId: "main", title: t("chat.board.mockOverview"), position: 0, chatDock: "right" },
      {
        tabId: "research",
        title: t("chat.board.mockResearch"),
        position: 1,
        chatDock: "bottom",
      },
    ],
    widgets: [
      {
        name: "session-status",
        tabId: "main",
        title: t("chat.board.mockSessionStatus"),
        contentKind: "html",
        sizeW: 4,
        sizeH: 3,
        position: 0,
        grantState: "granted",
        revision: 1,
      },
      {
        name: "recent-findings",
        tabId: "main",
        title: t("chat.board.mockRecentFindings"),
        contentKind: "mcp-app",
        sizeW: 8,
        sizeH: 6,
        position: 1,
        grantState: "pending",
        revision: 1,
      },
      {
        name: "source-map",
        tabId: "research",
        title: t("chat.board.mockSourceMap"),
        contentKind: "html",
        sizeW: 12,
        sizeH: 8,
        position: 0,
        grantState: "none",
        revision: 1,
      },
    ],
  };
}

export function boardExists(snapshot: BoardSnapshot): boolean {
  return snapshot.tabs.length > 0 || snapshot.widgets.length > 0;
}

class NullProvider implements BoardProvider {
  readonly canPinWidgets = false;
  readonly canPinMcpApps = false;
  readonly snapshot$: BoardSnapshotSignal;
  readonly events: BoardEventStream = new EventStream<BoardCommandEvent>();

  constructor(readonly sessionKey = "") {
    this.snapshot$ = new ValueSignal(emptySnapshot(sessionKey));
  }

  async applyOps(_ops: BoardOp[]): Promise<void> {}

  async grant(_name: string, _decision: "granted" | "rejected"): Promise<void> {}

  async pinWidget(_input: BoardPinWidgetInput): Promise<void> {
    throw new Error("Session dashboard unavailable");
  }

  async pinMcpApp(_input: BoardPinMcpAppInput): Promise<void> {
    throw new Error("Session dashboard unavailable");
  }

  widgetFrameUrl(_name: string, _revision: number): string {
    return "";
  }

  async refreshWidgetFrame(_name: string): Promise<void> {}

  async widgetAppView(_name: string, _revision: number): Promise<BoardWidgetAppViewState> {
    return { status: "stale", error: "Session dashboard unavailable" };
  }

  async refreshWidgetAppView(_name: string, _revision: number): Promise<BoardWidgetAppViewState> {
    return { status: "stale", error: "Session dashboard unavailable" };
  }
}

class MockBoardProvider implements BoardProvider {
  readonly canPinWidgets = true;
  readonly canPinMcpApps = true;
  readonly snapshot$: BoardSnapshotSignal;
  readonly events: BoardEventStream;
  private readonly snapshotSignal: ValueSignal<BoardSnapshot>;
  private readonly eventStream = new EventStream<BoardCommandEvent>();

  constructor(readonly sessionKey: string) {
    this.snapshotSignal = new ValueSignal(mockSnapshot(sessionKey));
    this.snapshot$ = this.snapshotSignal;
    this.events = this.eventStream;
  }

  async applyOps(ops: BoardOp[]): Promise<void> {
    let snapshot = this.snapshotSignal.value;
    for (const op of ops) {
      snapshot = normalizeMockBoardSnapshot(applyMockBoardOp(snapshot, op));
    }
    this.snapshotSignal.set({ ...snapshot, revision: snapshot.revision + 1 });
  }

  async grant(name: string, decision: "granted" | "rejected"): Promise<void> {
    const snapshot = this.snapshotSignal.value;
    const widgets = snapshot.widgets.slice();
    const widgetIndex = widgets.findIndex((widget) => widget.name === name);
    const widget = widgets[widgetIndex];
    if (widget) {
      widgets[widgetIndex] = { ...widget, grantState: decision };
    }
    this.snapshotSignal.set({
      ...snapshot,
      revision: snapshot.revision + 1,
      widgets,
    });
  }

  async pinWidget(input: BoardPinWidgetInput): Promise<void> {
    const snapshot = this.snapshotSignal.value;
    const name = input.name ?? canvasWidgetNameForDocument(input.docId);
    const title = boardWidgetTitle(input.title);
    const tabId = input.tabId ?? snapshot.tabs[0]?.tabId ?? "main";
    const tabs = snapshot.tabs.length
      ? snapshot.tabs
      : [
          {
            tabId: "main",
            title: t("chat.board.defaultTab"),
            position: 0,
            chatDock: "right" as const,
          },
        ];
    const existing = snapshot.widgets.find((widget) => widget.name === name);
    const widgets = snapshot.widgets.filter((widget) => widget.name !== name);
    widgets.push({
      name,
      tabId,
      ...(title ? { title } : {}),
      contentKind: "html",
      sizeW: existing?.sizeW ?? 6,
      sizeH: existing?.sizeH ?? 4,
      position: existing?.position ?? widgets.filter((widget) => widget.tabId === tabId).length,
      grantState: "none",
      revision: (existing?.revision ?? 0) + 1,
      frameUrl: `about:blank#board-widget=${encodeURIComponent(name)}`,
    });
    this.snapshotSignal.set(
      normalizeMockBoardSnapshot({ ...snapshot, revision: snapshot.revision + 1, tabs, widgets }),
    );
  }

  async pinMcpApp(input: BoardPinMcpAppInput): Promise<void> {
    const snapshot = this.snapshotSignal.value;
    const name = input.name ?? mcpAppWidgetNameForViewId(input.viewId);
    const title = boardWidgetTitle(input.title);
    const tabId = input.tabId ?? snapshot.tabs[0]?.tabId ?? "main";
    const tabs = snapshot.tabs.length
      ? snapshot.tabs
      : [
          {
            tabId: "main",
            title: t("chat.board.defaultTab"),
            position: 0,
            chatDock: "right" as const,
          },
        ];
    const existing = snapshot.widgets.find((widget) => widget.name === name);
    const widgets = snapshot.widgets.filter((widget) => widget.name !== name);
    widgets.push({
      name,
      tabId,
      ...(title ? { title } : {}),
      contentKind: "mcp-app",
      sizeW: existing?.sizeW ?? 6,
      sizeH: existing?.sizeH ?? 4,
      position: existing?.position ?? widgets.filter((widget) => widget.tabId === tabId).length,
      grantState: "none",
      revision: (existing?.revision ?? 0) + 1,
    });
    this.snapshotSignal.set(
      normalizeMockBoardSnapshot({
        ...snapshot,
        revision: snapshot.revision + 1,
        tabs,
        widgets,
      }),
    );
  }

  widgetFrameUrl(name: string, revision: number): string {
    return (
      this.snapshotSignal.value.widgets.find(
        (widget) => widget.name === name && widget.revision === revision,
      )?.frameUrl ?? `about:blank#board-widget=${encodeURIComponent(name)}&revision=${revision}`
    );
  }

  async refreshWidgetFrame(_name: string): Promise<void> {}

  async widgetAppView(_name: string, _revision: number): Promise<BoardWidgetAppViewState> {
    return { status: "stale", error: "MCP App mock view unavailable" };
  }

  async refreshWidgetAppView(name: string, revision: number): Promise<BoardWidgetAppViewState> {
    return await this.widgetAppView(name, revision);
  }

  emitCommand(command: BoardCommand): void {
    this.eventStream.emit({ sessionKey: this.sessionKey, command });
  }
}

export class GatewayBoardProvider implements BoardProvider {
  readonly snapshot$: BoardSnapshotSignal;
  readonly events: BoardEventStream;
  private readonly snapshotSignal: ValueSignal<BoardSnapshot>;
  private readonly eventStream = new EventStream<BoardCommandEvent>();
  private client: BoardGatewayClient;
  private clientGeneration = 0;
  private unsubscribe: (() => void) | undefined;
  private refreshLoop: Promise<void> | undefined;
  private refreshRequested = false;
  private readonly changedWidgets = new Set<string>();
  private stateGeneration = 0;
  private connected = false;
  private wakeRetryDelay: (() => void) | undefined;
  private readonly appViews = new BoardMcpAppViewCache();

  constructor(
    readonly sessionKey: string,
    client: BoardGatewayClient,
    connected = true,
    public canPinWidgets = true,
    public canPinMcpApps = false,
  ) {
    this.snapshotSignal = new ValueSignal(emptySnapshot(sessionKey));
    this.snapshot$ = this.snapshotSignal;
    this.events = this.eventStream;
    this.client = client;
    this.connected = connected;
    this.subscribe(client);
    if (connected) {
      void this.activate();
    }
  }

  attachClient(
    client: BoardGatewayClient,
    connected = true,
    canPinWidgets = true,
    canPinMcpApps = false,
  ): void {
    const connectionActivated = connected && !this.connected;
    this.connected = connected;
    this.canPinWidgets = canPinWidgets;
    this.canPinMcpApps = canPinMcpApps;
    if (client === this.client) {
      if (connectionActivated) {
        void this.activate();
      }
      return;
    }
    this.unsubscribe?.();
    this.client = client;
    this.clientGeneration += 1;
    this.stateGeneration += 1;
    this.changedWidgets.clear();
    this.appViews.clear();
    this.snapshotSignal.set(emptySnapshot(this.sessionKey));
    this.subscribe(client);
    if (connected) {
      void this.activate();
    }
  }

  activate(): Promise<void> {
    return this.requestRefresh();
  }

  async applyOps(ops: BoardOp[]): Promise<void> {
    await this.mutate("board.update", {
      sessionKey: this.sessionKey,
      ops,
    });
  }

  async grant(name: string, decision: "granted" | "rejected"): Promise<void> {
    const widget = this.snapshotSignal.value.widgets.find((candidate) => candidate.name === name);
    if (!widget) {
      void this.requestRefresh();
      throw new Error(`Dashboard widget not found: ${name}`);
    }
    await this.mutate("board.widget.grant", {
      sessionKey: this.sessionKey,
      name,
      decision,
      revision: widget.revision,
      ...(widget.instanceId ? { instanceId: widget.instanceId } : {}),
    });
  }

  async pinWidget(input: BoardPinWidgetInput): Promise<void> {
    const name = input.name ?? canvasWidgetNameForDocument(input.docId);
    const title = boardWidgetTitle(input.title);
    await this.mutate(
      "board.widget.put",
      {
        sessionKey: this.sessionKey,
        name,
        ...(title ? { title } : {}),
        content: { kind: "canvas-doc", docId: input.docId },
        ...(input.tabId || input.size || input.after
          ? {
              placement: {
                ...(input.tabId ? { tabId: input.tabId } : {}),
                ...(input.size ? { size: input.size } : {}),
                ...(input.after ? { after: input.after } : {}),
              },
            }
          : {}),
      },
      name,
    );
  }

  async pinMcpApp(input: BoardPinMcpAppInput): Promise<void> {
    const name = input.name ?? mcpAppWidgetNameForViewId(input.viewId);
    const title = boardWidgetTitle(input.title);
    await this.mutate(
      "board.widget.put",
      {
        sessionKey: this.sessionKey,
        name,
        ...(title ? { title } : {}),
        content: { kind: "mcp-app", viewId: input.viewId },
        ...(input.tabId || input.size || input.after
          ? {
              placement: {
                ...(input.tabId ? { tabId: input.tabId } : {}),
                ...(input.size ? { size: input.size } : {}),
                ...(input.after ? { after: input.after } : {}),
              },
            }
          : {}),
      },
      name,
    );
  }

  widgetFrameUrl(name: string, revision: number): string {
    return (
      this.snapshotSignal.value.widgets.find(
        (widget) => widget.name === name && widget.revision === revision,
      )?.frameUrl ?? ""
    );
  }

  refreshWidgetFrame(name: string): Promise<void> {
    return this.requestRefresh(name);
  }

  async widgetAppView(name: string, revision: number): Promise<BoardWidgetAppViewState> {
    return await this.resolveWidgetAppView(name, revision, false);
  }

  async refreshWidgetAppView(name: string, revision: number): Promise<BoardWidgetAppViewState> {
    return await this.resolveWidgetAppView(name, revision, true);
  }

  private async resolveWidgetAppView(
    name: string,
    revision: number,
    force: boolean,
  ): Promise<BoardWidgetAppViewState> {
    const widget = this.snapshotSignal.value.widgets.find(
      (candidate) =>
        candidate.name === name &&
        candidate.revision === revision &&
        candidate.contentKind === "mcp-app",
    );
    if (!widget) {
      return { status: "stale", error: "Dashboard MCP App widget unavailable" };
    }
    const client = this.client;
    return await this.appViews.resolve(
      widget,
      async () =>
        await client.request<BoardWidgetAppViewResult>("board.widget.appView", {
          sessionKey: this.sessionKey,
          name,
          revision,
          ...(widget.instanceId ? { instanceId: widget.instanceId } : {}),
        }),
      force,
    );
  }

  private subscribe(client: BoardGatewayClient): void {
    this.unsubscribe = client.addEventListener((event) => {
      if (event.event === "board.changed") {
        const payload = event.payload as Partial<BoardChangedEvent> | undefined;
        if (payload && this.matchesSession(payload.sessionKey)) {
          this.stateGeneration += 1;
          void this.requestRefresh(payload.widget);
        }
        return;
      }
      if (event.event === "board.command") {
        const payload = event.payload as Partial<BoardCommandEvent> | undefined;
        if (payload?.command && this.matchesSession(payload.sessionKey)) {
          this.eventStream.emit({ sessionKey: this.sessionKey, command: payload.command });
        }
      }
    });
  }

  private matchesSession(sessionKey: string | undefined): boolean {
    return (
      typeof sessionKey === "string" &&
      normalizeSessionKeyForUiComparison(sessionKey) ===
        normalizeSessionKeyForUiComparison(this.sessionKey)
    );
  }

  private requestRefresh(changedWidget?: string): Promise<void> {
    this.refreshRequested = true;
    if (changedWidget) {
      this.changedWidgets.add(changedWidget);
    }
    this.wakeRetryDelay?.();
    this.refreshLoop ??= this.runRefreshLoop().finally(() => {
      this.refreshLoop = undefined;
      if (this.refreshRequested) {
        void this.requestRefresh();
      }
    });
    return this.refreshLoop;
  }

  private async runRefreshLoop(): Promise<void> {
    const retry = { delayMs: 1_000 };
    while (this.refreshRequested) {
      this.refreshRequested = false;
      const changedWidgets = new Set(this.changedWidgets);
      this.changedWidgets.clear();
      const client = this.client;
      const stateGeneration = this.stateGeneration;
      try {
        const snapshot = await client.request<BoardSnapshot>("board.get", {
          sessionKey: this.sessionKey,
        });
        if (client !== this.client) {
          this.refreshRequested = true;
          continue;
        }
        if (stateGeneration !== this.stateGeneration) {
          this.refreshRequested = true;
          for (const name of changedWidgets) {
            this.changedWidgets.add(name);
          }
          continue;
        }
        this.setSnapshot(snapshot, changedWidgets);
        retry.delayMs = 1_000;
      } catch {
        this.refreshRequested = true;
        if (client !== this.client) {
          continue;
        }
        for (const name of changedWidgets) {
          this.changedWidgets.add(name);
        }
        const delayMs = retry.delayMs;
        // Carry backoff across failed loop iterations; successful refreshes reset it above.
        retry.delayMs = Math.min(delayMs * 2, 30_000);
        await this.waitForRetry(delayMs);
        continue;
      }
    }
  }

  private waitForRetry(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (!timer) {
          return;
        }
        clearTimeout(timer);
        timer = undefined;
        if (this.wakeRetryDelay === finish) {
          this.wakeRetryDelay = undefined;
        }
        resolve();
      };
      timer = setTimeout(finish, delayMs);
      this.wakeRetryDelay = finish;
    });
  }

  private async mutate(
    method: "board.update" | "board.widget.grant" | "board.widget.put",
    params: Record<string, unknown>,
    changedWidget?: string,
  ): Promise<void> {
    const client = this.client;
    const clientGeneration = this.clientGeneration;
    const stateGeneration = ++this.stateGeneration;
    try {
      const snapshot = await client.request<BoardSnapshot>(method, params);
      if (
        client === this.client &&
        clientGeneration === this.clientGeneration &&
        stateGeneration === this.stateGeneration
      ) {
        this.stateGeneration += 1;
        this.setSnapshot(snapshot, changedWidget ? new Set([changedWidget]) : new Set());
      }
    } catch (error) {
      if (
        client === this.client &&
        clientGeneration === this.clientGeneration &&
        stateGeneration === this.stateGeneration
      ) {
        void this.requestRefresh();
      }
      throw error;
    }
  }

  private setSnapshot(snapshot: BoardSnapshot, changedWidgets = new Set<string>()): void {
    const previousWidgets = new Map(
      this.snapshotSignal.value.widgets.map((widget) => [widget.name, widget]),
    );
    const widgets = snapshot.widgets.map((widget) => {
      const previous = previousWidgets.get(widget.name);
      if (
        previous &&
        !changedWidgets.has(widget.name) &&
        previous.revision === widget.revision &&
        previous.instanceId === widget.instanceId &&
        previous.frameUrl
      ) {
        return { ...widget, frameUrl: previous.frameUrl };
      }
      return widget;
    });
    this.appViews.prune(widgets);
    this.snapshotSignal.set({ ...snapshot, widgets });
  }
}

const nullProviders = new Map<string, NullProvider>();
const mockProviders = new Map<string, MockBoardProvider>();
const gatewayProviders = new Map<string, GatewayBoardProvider>();
let mockProviderScope: object | null = null;

function resolveMockBoardScope(): object | null {
  const location = globalThis.location;
  if (new URLSearchParams(location?.search ?? "").get("mockBoard") === "1") {
    return location;
  }
  return null;
}

export function isMockBoardEnabled(): boolean {
  return resolveMockBoardScope() !== null;
}

function isMockBoardSession(sessionKey: string): boolean {
  return /^agent:[^:]+:[^:]+$/u.test(sessionKey);
}

function boardProviderCacheKey(sessionKey: string): string {
  const normalized = normalizeSessionKeyForUiComparison(sessionKey);
  return normalized === "main" ? buildAgentMainSessionKey({ agentId: "main" }) : normalized;
}

export function boardProviderForSession(
  sessionKey: string,
  client?: BoardGatewayClient | null,
  available = true,
  connected = true,
  canPinWidgets = available,
  canPinMcpApps = false,
): BoardProvider {
  const key = boardProviderCacheKey(sessionKey);
  const mockScope = resolveMockBoardScope();
  if (mockScope && isMockBoardSession(key)) {
    if (mockScope !== mockProviderScope) {
      mockProviders.clear();
      mockProviderScope = mockScope;
    }
    let provider = mockProviders.get(key);
    if (!provider) {
      provider = new MockBoardProvider(key);
      mockProviders.set(key, provider);
    }
    return provider;
  }
  if (!available) {
    let provider = nullProviders.get(key);
    if (!provider) {
      provider = new NullProvider(key);
      nullProviders.set(key, provider);
    }
    return provider;
  }
  if (client) {
    let provider = gatewayProviders.get(key);
    if (!provider) {
      provider = new GatewayBoardProvider(key, client, connected, canPinWidgets, canPinMcpApps);
      gatewayProviders.set(key, provider);
    } else {
      provider.attachClient(client, connected, canPinWidgets, canPinMcpApps);
    }
    return provider;
  }
  const gatewayProvider = gatewayProviders.get(key);
  if (gatewayProvider) {
    return gatewayProvider;
  }
  let provider = nullProviders.get(key);
  if (!provider) {
    provider = new NullProvider(key);
    nullProviders.set(key, provider);
  }
  return provider;
}

export function sessionHasBoard(sessionKey: string): boolean {
  return boardExists(boardProviderForSession(sessionKey).snapshot$.value);
}
