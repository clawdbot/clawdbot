import type {
  BoardChangedEvent,
  BoardCommandEvent,
  BoardOp,
  BoardSnapshot,
  BoardWidget,
  BoardWidgetAppViewResult,
} from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { normalizeSessionKeyForUiComparison } from "../sessions/session-key.ts";
import { BoardMcpAppViewCache } from "./mcp-app-view-cache.ts";
import {
  EventStream,
  ValueSignal,
  type BoardEventStream,
  type BoardSnapshotSignal,
} from "./provider-signals.ts";
import type { BoardProvider } from "./provider-types.ts";
import type { BoardWidgetAppViewState } from "./view-types.ts";
import { canvasWidgetNameForDocument, mcpAppWidgetNameForViewId } from "./widget-names.ts";
import {
  copyBoardWidgetTicketReceipt,
  recordBoardWidgetTicketReceipt,
} from "./widget-ticket-lifetime.ts";

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

function emptySnapshot(sessionKey: string): BoardSnapshot {
  return { sessionKey, revision: 0, tabs: [], widgets: [] };
}

function boardWidgetTitle(title: string | undefined): string | undefined {
  const normalized = title?.trim() ?? "";
  return normalized ? Array.from(normalized).slice(0, 80).join("") : undefined;
}

export class GatewayBoardProvider implements BoardProvider {
  readonly snapshot$: BoardSnapshotSignal<BoardSnapshot>;
  readonly events: BoardEventStream<BoardCommandEvent>;
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
  private disposed = false;
  private snapshotLoaded = false;

  constructor(
    readonly sessionKey: string,
    client: BoardGatewayClient,
    connected = true,
    public canPinWidgets = true,
    public canPinMcpApps = false,
    public canMutate = true,
    public canGrant = true,
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
    canMutate = true,
    canGrant = true,
  ): void {
    if (this.disposed) {
      return;
    }
    const connectionActivated = connected && !this.connected;
    this.connected = connected;
    this.canPinWidgets = canPinWidgets;
    this.canPinMcpApps = canPinMcpApps;
    this.canMutate = canMutate;
    this.canGrant = canGrant;
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
    this.snapshotLoaded = false;
    this.snapshotSignal.set(emptySnapshot(this.sessionKey));
    this.subscribe(client);
    if (connected) {
      void this.activate();
    }
  }

  activate(): Promise<void> {
    return this.requestRefresh();
  }

  get hasLoadedSnapshot(): boolean {
    return this.snapshotLoaded;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.connected = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.clientGeneration += 1;
    this.stateGeneration += 1;
    this.refreshRequested = false;
    this.changedWidgets.clear();
    this.appViews.clear();
    this.wakeRetryDelay?.();
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
      if (this.disposed) {
        return;
      }
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
    if (this.disposed) {
      return Promise.resolve();
    }
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
      if (this.disposed) {
        this.refreshRequested = false;
        return;
      }
      this.refreshRequested = false;
      const changedWidgets = new Set(this.changedWidgets);
      this.changedWidgets.clear();
      const client = this.client;
      const stateGeneration = this.stateGeneration;
      try {
        const snapshot = await client.request<BoardSnapshot>("board.get", {
          sessionKey: this.sessionKey,
        });
        if (this.disposed) {
          return;
        }
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
        if (this.disposed) {
          return;
        }
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
    if (this.disposed) {
      throw new Error("Session dashboard provider is no longer active");
    }
    const client = this.client;
    const clientGeneration = this.clientGeneration;
    const stateGeneration = ++this.stateGeneration;
    try {
      const snapshot = await client.request<BoardSnapshot>(method, params);
      if (
        !this.disposed &&
        client === this.client &&
        clientGeneration === this.clientGeneration &&
        stateGeneration === this.stateGeneration
      ) {
        this.stateGeneration += 1;
        this.setSnapshot(snapshot, changedWidget ? new Set([changedWidget]) : new Set(), true);
      }
    } catch (error) {
      if (
        !this.disposed &&
        client === this.client &&
        clientGeneration === this.clientGeneration &&
        stateGeneration === this.stateGeneration
      ) {
        void this.requestRefresh();
      }
      throw error;
    }
  }

  private setSnapshot(
    snapshot: BoardSnapshot,
    changedWidgets = new Set<string>(),
    preserveMissingViewContracts = false,
  ): void {
    const receivedAtMs = Date.now();
    const previousWidgets = new Map(
      this.snapshotSignal.value.widgets.map((widget) => [widget.name, widget]),
    );
    const widgets = snapshot.widgets.map((widget) => {
      const previous = previousWidgets.get(widget.name);
      if (
        preserveMissingViewContracts &&
        previous &&
        !changedWidgets.has(widget.name) &&
        previous.revision === widget.revision &&
        previous.instanceId === widget.instanceId &&
        widget.viewGeneration === undefined
      ) {
        // Mutation snapshots contain board state but not the view contract minted
        // by board.get. Keep that contract only while the document revision matches.
        const preserved = preserveBoardWidgetViewContract(widget, previous);
        copyBoardWidgetTicketReceipt(preserved, previous, receivedAtMs);
        return preserved;
      }
      if (
        previous &&
        !changedWidgets.has(widget.name) &&
        previous.revision === widget.revision &&
        previous.instanceId === widget.instanceId &&
        previous.viewGeneration === widget.viewGeneration &&
        !widget.sandboxUrl &&
        previous.frameUrl
      ) {
        const preserved = { ...widget, frameUrl: previous.frameUrl };
        recordBoardWidgetTicketReceipt(preserved, receivedAtMs);
        return preserved;
      }
      recordBoardWidgetTicketReceipt(widget, receivedAtMs);
      return widget;
    });
    this.appViews.prune(widgets);
    this.snapshotLoaded = true;
    this.snapshotSignal.set({ ...snapshot, widgets });
  }
}

function preserveBoardWidgetViewContract(widget: BoardWidget, previous: BoardWidget): BoardWidget {
  return {
    ...widget,
    ...(previous.frameUrl !== undefined ? { frameUrl: previous.frameUrl } : {}),
    ...(previous.viewTicket !== undefined ? { viewTicket: previous.viewTicket } : {}),
    ...(previous.viewTicketTtlMs !== undefined
      ? { viewTicketTtlMs: previous.viewTicketTtlMs }
      : {}),
    ...(previous.viewGeneration !== undefined ? { viewGeneration: previous.viewGeneration } : {}),
    ...(previous.sandboxUrl !== undefined ? { sandboxUrl: previous.sandboxUrl } : {}),
    ...(previous.sandboxPort !== undefined ? { sandboxPort: previous.sandboxPort } : {}),
    ...(previous.sandboxOrigin !== undefined ? { sandboxOrigin: previous.sandboxOrigin } : {}),
  };
}
