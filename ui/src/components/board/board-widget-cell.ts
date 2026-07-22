import { consume } from "@lit/context";
import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { ensureCustomElementDefined } from "../../app/lazy-custom-element.ts";
import { t } from "../../i18n/index.ts";
import type { BoardGridDirection, BoardGridRect } from "../../lib/board/grid.ts";
import { toCssPlacement } from "../../lib/board/grid.ts";
import type { BoardWidgetAppViewState } from "../../lib/board/provider.ts";
import type { BoardTab } from "../../lib/board/types.ts";
import type {
  BoardGrantDecision,
  BoardViewWidget,
  BoardWidgetFrameUrl,
} from "../../lib/board/view-types.ts";
import {
  getBuiltinWidgetRenderer,
  getPluginWidgetKindContribution,
  loadPluginWidgetRenderer,
  pluginIdForWidgetKind,
  type PluginBoardWidgetRenderer,
} from "../../lib/board/widgets/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { renderBoardMcpAppContent } from "./board-mcp-app-content.ts";
import { BoardMcpAppLifecycle } from "./board-mcp-app-lifecycle.ts";
import { renderBoardGrantedCapabilities } from "./board-widget-capabilities.ts";
import {
  BOARD_SIZE_PRESETS,
  closeBoardWidgetMenu,
  renderBoardDisabledPlugin,
  renderBoardWidgetActionError,
  renderBoardWidgetError,
  renderBoardWidgetMenu,
  renderBoardWidgetPending,
  renderBoardWidgetRejected,
} from "./board-widget-cell-render.ts";
import { BoardWidgetFrameLifecycle } from "./board-widget-frame.ts";
import "../tooltip.ts";
import "../web-awesome.ts";

const loadMcpAppView = () => import("../mcp-app-view-registration.ts");

export type BoardWidgetCellCallbacks = {
  grant: (name: string, decision: BoardGrantDecision) => Promise<void>;
  movePointerDown: (widget: BoardViewWidget, event: PointerEvent) => void;
  resizePointerDown: (widget: BoardViewWidget, event: PointerEvent) => void;
  moveToTab: (widget: BoardViewWidget, tabId: string) => Promise<void>;
  resizeTo: (widget: BoardViewWidget, w: number, h: number) => Promise<void>;
  setHeightMode: (widget: BoardViewWidget, mode: "auto" | "fixed") => Promise<void>;
  reportContentHeight: (name: string, height: number) => void;
  remove: (widget: BoardViewWidget) => Promise<void>;
  nudge: (widget: BoardViewWidget, direction: BoardGridDirection) => Promise<void>;
  focus: (widget: BoardViewWidget, direction: BoardGridDirection) => void;
  focusChanged: (name: string) => void;
  frameLoadFailed: (name: string) => Promise<void>;
  widgetAppView: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
  refreshWidgetAppView: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
};

class OpenClawBoardWidgetCell extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) widget?: BoardViewWidget;
  @property({ attribute: false }) rect?: BoardGridRect;
  @property({ attribute: false }) tabs: readonly BoardTab[] = [];
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) widgetFrameUrl?: BoardWidgetFrameUrl;
  @property({ attribute: false }) callbacks?: BoardWidgetCellCallbacks;
  @property({ attribute: false }) sessions: readonly GatewaySessionRow[] = [];
  @property({ type: Boolean }) dragging = false;
  @property({ type: Number }) focusTabIndex = -1;
  @property({ type: Number }) positionInSet = 1;
  @property({ type: Number }) setSize = 1;
  @property({ type: Boolean }) busy = false;
  @property({ type: Boolean }) canMutate = true;
  @property({ type: Boolean }) canGrant = true;

  @state() private actionError = "";
  @state() private actionPending = false;
  @state() private pluginRenderer: PluginBoardWidgetRenderer | null = null;
  @state() private pluginRendererError = "";
  @state() private pluginRendererLabel = "";
  private pluginRendererKind = "";
  private pluginRendererLoadToken: object | null = null;
  private readonly appView = new BoardMcpAppLifecycle({
    connected: () => this.isConnected,
    requestUpdate: () => this.requestUpdate(),
    sessionKey: () => this.sessionKey,
    widget: () => this.widget,
  });
  private readonly frame = new BoardWidgetFrameLifecycle({
    connected: () => this.isConnected,
    context: () => this.context,
    refreshFrame: () => this.callbacks?.frameLoadFailed,
    reportContentHeight: (name, height) => this.callbacks?.reportContentHeight(name, height),
    requestUpdate: () => this.requestUpdate(),
    resolveFrameUrl: () => this.widgetFrameUrl,
    root: () => this,
    widget: () => this.widget,
  });

  override connectedCallback(): void {
    super.connectedCallback();
    this.frame.connect();
    this.requestUpdate();
  }

  override willUpdate(changed: PropertyValues<this>): void {
    const previousWidget = changed.get("widget");
    if (previousWidget && previousWidget !== this.widget) {
      this.actionError = "";
      this.frame.widgetChanged(previousWidget, this.widget);
    }
    this.appView.update(this.widget, this.callbacks);
    this.syncPluginRenderer();
  }

  override updated(): void {
    if (!this.isConnected) {
      this.appView.observe(null, false);
      return;
    }
    this.appView.observe(
      this.querySelector(".board-widget"),
      this.widget?.contentKind === "mcp-app",
    );
    queueMicrotask(() => {
      if (this.isConnected) {
        this.appView.sync();
      }
    });
    this.frame.update();
  }

  override disconnectedCallback(): void {
    this.resetPluginRenderer();
    this.frame.disconnect();
    this.appView.disconnect();
    super.disconnectedCallback();
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    if (this.actionPending || this.busy) {
      return;
    }
    this.actionPending = true;
    this.actionError = "";
    closeBoardWidgetMenu(this);
    try {
      await action();
    } catch (error) {
      this.actionError = error instanceof Error ? error.message : String(error);
    } finally {
      this.actionPending = false;
    }
  }

  private handleMenuSelect(
    event: CustomEvent<{ item: { value?: string } }>,
    widget: BoardViewWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): void {
    if (!this.canMutate) {
      return;
    }
    const value = event.detail.item.value;
    if (value === "remove") {
      void this.runAction(() => callbacks.remove(widget));
      return;
    }
    if (value?.startsWith("move:")) {
      void this.runAction(() => callbacks.moveToTab(widget, value.slice("move:".length)));
      return;
    }
    if (value?.startsWith("resize:")) {
      const preset = value.slice("resize:".length) as keyof typeof BOARD_SIZE_PRESETS;
      const size = BOARD_SIZE_PRESETS[preset];
      if (size) {
        void this.runAction(() => callbacks.resizeTo(widget, size.w, size.h));
      }
      return;
    }
    if (value === "height:auto") {
      const mode = widget.heightMode !== "fixed" ? "fixed" : "auto";
      void this.runAction(() => callbacks.setHeightMode(widget, mode));
    }
  }

  private renderMcpApp(
    widget: BoardViewWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): TemplateResult {
    void ensureCustomElementDefined("mcp-app-view", loadMcpAppView).catch(() => undefined);
    const accessNotice =
      widget.grantState === "pending"
        ? renderBoardWidgetPending({
            widget,
            disabled: this.busy || this.actionPending || !this.canGrant,
            onGrant: (decision) =>
              void this.runAction(() => callbacks.grant(widget.name, decision)),
            ...(this.actionError
              ? { error: renderBoardWidgetActionError(this.actionError, true) }
              : {}),
          })
        : widget.grantState === "rejected"
          ? renderBoardWidgetRejected({
              widget,
              disabled: this.busy || this.actionPending || !this.canMutate,
              onRemove: () => void this.runAction(() => callbacks.remove(widget)),
            })
          : nothing;
    return renderBoardMcpAppContent({
      accessNotice,
      appView: this.appView.state,
      busy: this.busy || this.actionPending || !this.canMutate,
      loading: this.appView.loading,
      nearVisible: this.appView.nearVisible,
      rectHeight: this.rect?.h ?? 4,
      sessionKey: this.sessionKey,
      widget,
      expired: () => this.appView.expire(),
      remove: () => void this.runAction(() => callbacks.remove(widget)),
      retry: () => this.appView.retry(),
    });
  }

  private renderBody(widget: BoardViewWidget, callbacks: BoardWidgetCellCallbacks): TemplateResult {
    if (widget.contentKind === "mcp-app") {
      return this.renderMcpApp(widget, callbacks);
    }
    if (widget.grantState === "pending") {
      return renderBoardWidgetPending({
        widget,
        disabled: this.busy || this.actionPending || !this.canGrant,
        onGrant: (decision) => void this.runAction(() => callbacks.grant(widget.name, decision)),
        ...(this.actionError
          ? { error: renderBoardWidgetActionError(this.actionError, true) }
          : {}),
      });
    }
    if (widget.grantState === "rejected") {
      return renderBoardWidgetRejected({
        widget,
        disabled: this.busy || this.actionPending || !this.canMutate,
        onRemove: () => void this.runAction(() => callbacks.remove(widget)),
      });
    }
    if (widget.contentKind === "builtin") {
      const renderer = getBuiltinWidgetRenderer(widget.builtin);
      if (!renderer) {
        throw new Error(t("board.widget.frameResolverMissing"));
      }
      return renderer({ sessions: this.sessions, sessionKey: this.sessionKey });
    }
    if (widget.contentKind === "plugin") {
      if (this.pluginRendererError) {
        return renderBoardWidgetError(this.pluginRendererError, () => this.retryPluginRenderer());
      }
      if (this.pluginRenderer) {
        return this.pluginRenderer({
          widget,
          sessionKey: this.sessionKey,
          requestUpdate: () => this.requestUpdate(),
        });
      }
      const pluginId = pluginIdForWidgetKind(widget.pluginKind);
      const activeKinds = this.context?.gateway.snapshot.hello?.controlUiWidgetKinds ?? [];
      const contribution = getPluginWidgetKindContribution(widget.pluginKind, activeKinds);
      return contribution
        ? html`<p class="board-widget__plugin-loading">${t("board.widget.pluginLoading")}</p>`
        : renderBoardDisabledPlugin({
            pluginId,
            disabled: this.busy || this.actionPending || !this.canMutate,
            onRemove: () => void this.runAction(() => callbacks.remove(widget)),
          });
    }
    return this.frame.render(widget);
  }

  private syncPluginRenderer(): void {
    const widget = this.widget;
    const activeKinds = this.context?.gateway.snapshot.hello?.controlUiWidgetKinds ?? [];
    const contribution =
      widget?.contentKind === "plugin"
        ? getPluginWidgetKindContribution(widget.pluginKind, activeKinds)
        : null;
    if (!contribution) {
      if (this.pluginRendererKind || this.pluginRenderer || this.pluginRendererError) {
        this.resetPluginRenderer();
      }
      return;
    }
    if (this.pluginRendererKind === contribution.kind) {
      return;
    }
    const loadToken = {};
    this.pluginRendererKind = contribution.kind;
    this.pluginRendererLabel = contribution.label;
    this.pluginRenderer = null;
    this.pluginRendererError = "";
    this.pluginRendererLoadToken = loadToken;
    void loadPluginWidgetRenderer(contribution)
      .then((renderer) => {
        if (this.pluginRendererLoadToken === loadToken) {
          this.pluginRenderer = renderer;
          this.requestUpdate();
        }
      })
      .catch((error: unknown) => {
        if (this.pluginRendererLoadToken === loadToken) {
          this.pluginRendererError = error instanceof Error ? error.message : String(error);
          this.requestUpdate();
        }
      });
  }

  private resetPluginRenderer(): void {
    this.pluginRendererLoadToken = null;
    this.pluginRendererKind = "";
    this.pluginRendererLabel = "";
    this.pluginRenderer = null;
    this.pluginRendererError = "";
  }

  private retryPluginRenderer(): void {
    this.resetPluginRenderer();
    this.requestUpdate();
  }

  private handleKeyDown(
    event: KeyboardEvent,
    widget: BoardViewWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): void {
    if (event.target !== event.currentTarget || widget.readOnly || !this.canMutate) {
      return;
    }
    const direction =
      event.key === "ArrowLeft"
        ? "left"
        : event.key === "ArrowRight"
          ? "right"
          : event.key === "ArrowUp"
            ? "up"
            : event.key === "ArrowDown"
              ? "down"
              : null;
    if (!direction) {
      return;
    }
    event.preventDefault();
    if (event.altKey) {
      void this.runAction(() => callbacks.nudge(widget, direction));
    } else {
      callbacks.focus(widget, direction);
    }
  }

  override render() {
    const widget = this.widget;
    const rect = this.rect;
    const callbacks = this.callbacks;
    if (!widget || !rect || !callbacks) {
      return nothing;
    }
    let body: TemplateResult;
    let bodyErrored: boolean;
    try {
      body = this.frame.error
        ? renderBoardWidgetError(this.frame.error)
        : this.renderBody(widget, callbacks);
      bodyErrored = Boolean(this.frame.error);
    } catch (error) {
      body = renderBoardWidgetError(error);
      bodyErrored = true;
    }
    const label = widget.title || widget.name;
    const readOnly = widget.readOnly === true || !this.canMutate;
    const bodyScrollable =
      bodyErrored ||
      this.actionError !== "" ||
      widget.grantState === "pending" ||
      widget.grantState === "rejected";
    const contentScrollable =
      bodyScrollable || widget.contentKind === "mcp-app" || widget.contentKind === "plugin";
    const presentation =
      widget.contentKind === "html" ? (widget.presentation ?? "card") : undefined;
    return html`
      <section
        class=${`board-widget ${this.dragging ? "board-widget--dragging" : ""} ${presentation ? `board-widget--${presentation}` : ""}`}
        style=${toCssPlacement(rect)}
        role="listitem"
        tabindex=${this.focusTabIndex}
        aria-posinset=${this.positionInSet}
        aria-setsize=${this.setSize}
        aria-label=${readOnly ? label : t("board.widget.cellLabel", { title: label })}
        data-widget-name=${widget.name}
        data-test-id="board-widget"
        @focus=${() => callbacks.focusChanged(widget.name)}
        @keydown=${(event: KeyboardEvent) => this.handleKeyDown(event, widget, callbacks)}
      >
        <header class="board-widget__bar">
          ${readOnly
            ? nothing
            : html`<span
                class="board-widget__drag-handle"
                aria-hidden="true"
                title=${t("board.widget.moveHandle", { title: label })}
                @pointerdown=${(event: PointerEvent) => callbacks.movePointerDown(widget, event)}
              >
                <span aria-hidden="true">⠿</span>
              </span>`}
          <span class="board-widget__title" title=${label}>${label}</span>
          ${widget.contentKind === "builtin"
            ? nothing
            : html`<span class="board-widget__kind"
                >${widget.contentKind === "mcp-app"
                  ? t("board.widget.kindMcp")
                  : widget.contentKind === "plugin"
                    ? this.pluginRendererLabel || t("board.widget.kindPlugin")
                    : t("board.widget.kindHtml")}</span
              >`}
          ${widget.contentKind === "builtin" ? nothing : renderBoardGrantedCapabilities(widget)}
          ${readOnly
            ? nothing
            : renderBoardWidgetMenu({
                widget,
                tabs: this.tabs,
                disabled: this.busy || this.actionPending,
                onSelect: (event) => this.handleMenuSelect(event, widget, callbacks),
              })}
        </header>
        <div
          class=${`board-widget__body ${contentScrollable ? "board-widget__body--scrollable" : ""} ${presentation === "card" ? "board-widget__body--card" : ""}`}
        >
          ${body}
          ${this.actionError && widget.grantState !== "pending"
            ? html`<div class="board-widget__error-overlay">
                ${renderBoardWidgetActionError(this.actionError)}
              </div>`
            : nothing}
        </div>
        ${readOnly
          ? nothing
          : html`<span
              class="board-widget__resize-handle"
              aria-hidden="true"
              title=${t("board.widget.resizeHandle", { title: label })}
              @pointerdown=${(event: PointerEvent) => callbacks.resizePointerDown(widget, event)}
            ></span>`}
        ${widget.grantState === "granted" && widget.contentKind !== "builtin"
          ? html`<span class="board-widget__grant-dot" aria-hidden="true"></span>`
          : nothing}
      </section>
    `;
  }
}

if (!customElements.get("openclaw-board-widget-cell")) {
  customElements.define("openclaw-board-widget-cell", OpenClawBoardWidgetCell);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-board-widget-cell": OpenClawBoardWidgetCell;
  }
}
