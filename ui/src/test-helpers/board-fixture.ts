import { html } from "lit";
import { state } from "lit/decorators.js";
import type { BoardOp, BoardSnapshot } from "../lib/board/types.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
// The fixture page renders outside the app shell, so it must load the app
// stylesheet itself (Web Awesome theme included) or dropdown menus render
// theme-less: dark item text on the fixture's dark panels.
import "../styles.css";
import "../components/board/board-view.ts";

document.documentElement.classList.add("wa-dark");

const initialSnapshot: BoardSnapshot = {
  sessionKey: "agent:main:board-fixture",
  revision: 7,
  tabs: [
    { tabId: "overview", title: "Overview", position: 0, chatDock: "right" },
    { tabId: "operations", title: "Operations", position: 1, chatDock: "bottom" },
  ],
  widgets: [
    {
      name: "service-pulse",
      tabId: "overview",
      title: "Service pulse",
      contentKind: "html",
      presentation: "full-bleed",
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "none",
      revision: 3,
    },
    {
      name: "content-controls",
      tabId: "overview",
      title: "Content controls",
      contentKind: "html",
      sizeW: 6,
      sizeH: 6,
      position: 1,
      grantState: "none",
      revision: 1,
    },
    {
      name: "local-time",
      tabId: "overview",
      title: "Local time",
      contentKind: "html",
      presentation: "frameless",
      sizeW: 6,
      sizeH: 5,
      position: 2,
      grantState: "none",
      revision: 1,
    },
    {
      name: "deploy-window",
      tabId: "overview",
      title: "Deploy window",
      contentKind: "mcp-app",
      sizeW: 6,
      sizeH: 4,
      position: 3,
      grantState: "granted",
      revision: 2,
    },
    {
      name: "latency-bands",
      tabId: "overview",
      title: "Latency bands",
      contentKind: "html",
      presentation: "full-bleed",
      sizeW: 4,
      sizeH: 5,
      position: 4,
      grantState: "none",
      revision: 1,
    },
    {
      name: "incident-tools",
      tabId: "overview",
      title: "Incident tools",
      contentKind: "html",
      sizeW: 4,
      sizeH: 5,
      position: 5,
      grantState: "pending",
      revision: 1,
    },
    {
      name: "retired-report",
      tabId: "overview",
      title: "Retired report",
      contentKind: "html",
      sizeW: 4,
      sizeH: 5,
      position: 6,
      grantState: "rejected",
      revision: 4,
    },
    {
      name: "worker-queue",
      tabId: "operations",
      title: "Worker queue",
      contentKind: "html",
      presentation: "full-bleed",
      sizeW: 12,
      sizeH: 6,
      position: 0,
      grantState: "none",
      revision: 5,
    },
  ],
};

function contentControlsDocument(): string {
  return `<!doctype html><meta charset="utf-8"><style>
    :root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif}
    *{box-sizing:border-box}body{margin:0;color:#d9dce3;background:transparent}
    main{display:grid;gap:12px}h2{font-size:18px;margin:0}p{color:#8f98a6;font-size:12px;margin:0}
    .actions{display:flex;gap:8px}button,input{border:1px solid #3a424e;border-radius:7px;background:#171b21;
      color:#d9dce3;font:inherit;padding:8px 10px}input{min-width:0;width:100%}
  </style><main><h2>Deploy controls</h2><p>Agent-authored content with no document inset.</p>
  <div class="actions"><button type="button">Preview</button><button type="button">Deploy</button></div>
  <input aria-label="Release note" placeholder="Release note"></main><script>
    const report=()=>parent.postMessage({type:"openclaw:widget-size",height:document.body.scrollHeight},"*");
    addEventListener("load",report);addEventListener("resize",report);new ResizeObserver(report).observe(document.documentElement);
  </script>`;
}

function clockDocument(): string {
  return `<!doctype html><meta charset="utf-8"><style>
    :root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
    body{align-items:center;background:transparent;color:#d9dce3;display:grid;height:100vh;margin:0;text-align:center}
    .time{font-size:clamp(54px,12vw,104px);font-weight:680;letter-spacing:-.08em;line-height:.9}
    .zone{color:#778291;font-size:11px;letter-spacing:.18em;margin-top:14px}
  </style><main><div class="time">10:42</div><div class="zone">LOCAL / SAN FRANCISCO</div></main>`;
}

const frameCopy: Record<string, { eyebrow: string; value: string; detail: string }> = {
  "service-pulse": { eyebrow: "UPTIME / 24H", value: "99.982%", detail: "All regions nominal" },
  "deploy-window": { eyebrow: "NEXT WINDOW", value: "14:30 UTC", detail: "3 changes queued" },
  "latency-bands": { eyebrow: "P95 LATENCY", value: "184 ms", detail: "−12 ms since last hour" },
  "worker-queue": { eyebrow: "QUEUE DEPTH", value: "38", detail: "12 active · 4 waiting" },
};

function frameUrl(name: string): string {
  if (name === "content-controls") {
    return `data:text/html;charset=utf-8,${encodeURIComponent(contentControlsDocument())}`;
  }
  if (name === "local-time") {
    return `data:text/html;charset=utf-8,${encodeURIComponent(clockDocument())}`;
  }
  const copy = frameCopy[name] ?? { eyebrow: "WIDGET", value: name, detail: "Mock fixture" };
  const document = `<!doctype html><meta charset="utf-8"><style>
    :root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
    body{box-sizing:border-box;margin:0;height:100vh;padding:22px;color:#d9dce3;background:
      radial-gradient(circle at 85% 5%,rgba(74,201,168,.16),transparent 38%),#13161b}
    .eyebrow{font-size:10px;letter-spacing:.14em;color:#7f8897}.value{font-size:clamp(24px,7vw,48px);
      font-weight:650;letter-spacing:-.06em;margin-top:16px}.detail{color:#77cdb5;font-size:11px;margin-top:9px}
    .ticks{display:flex;align-items:end;gap:5px;height:52px;margin-top:20px}.ticks i{display:block;flex:1;
      min-width:4px;border-radius:2px 2px 0 0;background:#39434d}.ticks i:nth-child(3n){background:#4ec9a8}
    @media(prefers-color-scheme:light){:root{color-scheme:light}body{color:#403c35;background:
      radial-gradient(circle at 85% 5%,rgba(20,184,166,.12),transparent 38%),#f4f1ec}
      .eyebrow{color:#6e6960}.detail{color:#0f766e}.ticks i{background:#d8d1c7}
      .ticks i:nth-child(3n){background:#14b8a6}}
  </style><div class="eyebrow">${copy.eyebrow}</div><div class="value">${copy.value}</div>
  <div class="detail">${copy.detail}</div><div class="ticks">${[28, 52, 37, 68, 44, 81, 59, 72]
    .map((height) => `<i style="height:${height}%"></i>`)
    .join("")}</div>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(document)}`;
}

function normalizePositions(snapshot: BoardSnapshot): BoardSnapshot {
  const widgets = snapshot.widgets.map((widget) => ({ ...widget }));
  for (const tab of snapshot.tabs) {
    widgets
      .filter((widget) => widget.tabId === tab.tabId)
      .toSorted(
        (left, right) => left.position - right.position || left.name.localeCompare(right.name),
      )
      .forEach((widget, position) => {
        widget.position = position;
      });
  }
  return { ...snapshot, widgets };
}

function moveFixtureWidget(
  snapshot: BoardSnapshot,
  op: Extract<BoardOp, { kind: "widget_move" }>,
): BoardSnapshot {
  const moving = snapshot.widgets.find((widget) => widget.name === op.name);
  if (!moving) {
    return snapshot;
  }
  const tabId = op.tabId ?? moving.tabId;
  const remaining = snapshot.widgets.filter((widget) => widget.name !== op.name);
  const destination = remaining
    .filter((widget) => widget.tabId === tabId)
    .toSorted(
      (left, right) => left.position - right.position || left.name.localeCompare(right.name),
    );
  const afterIndex = op.after ? destination.findIndex((widget) => widget.name === op.after) : -1;
  const requestedPosition =
    afterIndex >= 0
      ? afterIndex + 1
      : (op.position ?? (tabId === moving.tabId ? moving.position : destination.length));
  const position = Math.max(0, Math.min(Math.trunc(requestedPosition), destination.length));
  destination.splice(position, 0, { ...moving, tabId, position });
  destination.forEach((widget, nextPosition) => {
    widget.position = nextPosition;
  });
  return normalizePositions({
    ...snapshot,
    widgets: [...remaining.filter((widget) => widget.tabId !== tabId), ...destination],
  });
}

export function applyBoardFixtureOps(
  snapshot: BoardSnapshot,
  ops: readonly BoardOp[],
): BoardSnapshot {
  let next = structuredClone(snapshot);
  for (const op of ops) {
    if (op.kind === "widget_remove") {
      next.widgets = next.widgets.filter((widget) => widget.name !== op.name);
    } else if (op.kind === "widget_resize") {
      next.widgets = next.widgets.map((widget) => {
        if (widget.name !== op.name) {
          return widget;
        }
        if (
          widget.sizeW === op.sizeW &&
          widget.sizeH === op.sizeH &&
          (op.heightMode === undefined || widget.heightMode === op.heightMode)
        ) {
          return widget;
        }
        return {
          ...widget,
          sizeW: op.sizeW,
          sizeH: op.sizeH,
          ...(op.heightMode !== undefined ? { heightMode: op.heightMode } : {}),
        };
      });
    } else if (op.kind === "widget_move") {
      next = moveFixtureWidget(next, op);
    }
  }
  next = normalizePositions(next);
  return { ...next, revision: next.revision + 1 };
}

class BoardFixture extends OpenClawLightDomElement {
  @state() private snapshot = structuredClone(initialSnapshot);
  @state() private activeTabId = "overview";

  private async applyOps(ops: BoardOp[]): Promise<void> {
    this.snapshot = applyBoardFixtureOps(this.snapshot, ops);
  }

  private async grant(name: string, decision: "granted" | "rejected"): Promise<void> {
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      widgets: this.snapshot.widgets.map((widget) =>
        widget.name === name ? { ...widget, grantState: decision } : widget,
      ),
    };
  }

  override render() {
    return html`
      <main class="board-fixture-shell">
        <header class="board-fixture-header">
          <div>
            <span>SESSION DASHBOARD / MOCK</span>
            <h1>Launch control</h1>
          </div>
          <div class="board-fixture-status"><i></i> fixture online</div>
        </header>
        <openclaw-board-view
          .snapshot=${this.snapshot}
          .activeTabId=${this.activeTabId}
          .widgetFrameUrl=${frameUrl}
          .callbacks=${{
            applyOps: (ops: BoardOp[]) => this.applyOps(ops),
            grant: (name: string, decision: "granted" | "rejected") => this.grant(name, decision),
            selectTab: (tabId: string) => {
              this.activeTabId = tabId;
            },
          }}
        ></openclaw-board-view>
      </main>
    `;
  }
}

if (!customElements.get("openclaw-board-fixture")) {
  customElements.define("openclaw-board-fixture", BoardFixture);
}

document.querySelector("#app")?.append(document.createElement("openclaw-board-fixture"));
