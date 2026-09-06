import type {
  BoardCommand,
  BoardCommandEvent,
  BoardOp,
  BoardSnapshot,
} from "@openclaw/gateway-protocol";
import { t } from "../i18n/index.ts";
import { normalizeBoardWidgetTitle } from "../lib/board/provider-helpers.ts";
import {
  EventStream,
  ValueSignal,
  type BoardEventStream,
  type BoardSnapshotSignal,
} from "../lib/board/provider-signals.ts";
import type {
  BoardPinMcpAppInput,
  BoardPinWidgetInput,
  BoardProvider,
} from "../lib/board/provider-types.ts";
import type { BoardWidgetAppViewState } from "../lib/board/view-types.ts";
import {
  canvasWidgetNameForDocument,
  mcpAppWidgetNameForViewId,
} from "../lib/board/widget-names.ts";
import { normalizeDefaultMainSessionAliasForUi } from "../lib/sessions/session-key.ts";
import { applyMockBoardOp, normalizeMockBoardSnapshot } from "./board-ops.ts";

function mockSnapshot(sessionKey: string): BoardSnapshot {
  return {
    sessionKey,
    revision: 1,
    tabs: [
      { tabId: "main", title: "Overview", position: 0, chatDock: "right" },
      {
        tabId: "research",
        title: "Research",
        position: 1,
        chatDock: "bottom",
      },
    ],
    widgets: [
      {
        name: "session-status",
        tabId: "main",
        title: "Session status",
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
        title: "Recent findings",
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
        title: "Source map",
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

class MockBoardProvider implements BoardProvider {
  readonly appViewGeneration = 0;
  readonly canMutate = true;
  readonly canGrant = true;
  readonly canPinWidgets = true;
  readonly canPinMcpApps = true;
  readonly hasLoadedSnapshot = true;
  readonly loadError$ = new ValueSignal<string | null>(null);
  readonly snapshot$: BoardSnapshotSignal<BoardSnapshot>;
  readonly events: BoardEventStream<BoardCommandEvent>;
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
    const name = input.name ?? canvasWidgetNameForDocument(input.docId);
    this.pinMockBoardWidget(input, name, "html");
  }

  async pinMcpApp(input: BoardPinMcpAppInput): Promise<void> {
    const name = input.name ?? mcpAppWidgetNameForViewId(input.viewId);
    this.pinMockBoardWidget(input, name, "mcp-app");
  }

  private pinMockBoardWidget(
    input: BoardPinWidgetInput | BoardPinMcpAppInput,
    name: string,
    contentKind: "html" | "mcp-app",
  ): void {
    const snapshot = this.snapshotSignal.value;
    const title = normalizeBoardWidgetTitle(input.title);
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
      contentKind,
      sizeW: existing?.sizeW ?? 6,
      sizeH: existing?.sizeH ?? 4,
      position: existing?.position ?? widgets.filter((widget) => widget.tabId === tabId).length,
      grantState: "none",
      revision: (existing?.revision ?? 0) + 1,
      ...(contentKind === "html"
        ? { frameUrl: `about:blank#board-widget=${encodeURIComponent(name)}` }
        : {}),
    });
    this.snapshotSignal.set(
      normalizeMockBoardSnapshot({ ...snapshot, revision: snapshot.revision + 1, tabs, widgets }),
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

export function createMockBoardProvider(sessionKey: string) {
  return new MockBoardProvider(normalizeDefaultMainSessionAliasForUi(sessionKey));
}
