import { consume } from "@lit/context";
import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { ensureCustomElementDefined } from "../../app/lazy-custom-element.ts";
import { t } from "../../i18n/index.ts";
import type { BoardGridDirection, BoardGridRect } from "../../lib/board/grid.ts";
import {
  BOARD_DOCUMENT_AUTO_MAX_ROWS,
  boardChromeRowPx,
  exactBoardWidgetHeightPx,
  toCssPlacement,
} from "../../lib/board/grid.ts";
import type { BoardWidgetAppViewState } from "../../lib/board/provider.ts";
import type { BoardTab, BoardWidget } from "../../lib/board/types.ts";
import type { BoardGrantDecision, BoardWidgetFrameUrl } from "../../lib/board/view-types.ts";
import {
  getPluginWidgetKindContribution,
  loadPluginWidgetRenderer,
  pluginIdForWidgetKind,
  type PluginBoardWidgetRenderer,
} from "../../lib/board/widgets/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { showToast } from "../../lib/toast.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderCustomPluginUiDisabled } from "../../plugins/control-ui-disabled.ts";
import { renderPluginContribution } from "../../plugins/control-ui-view.ts";
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
  appViewGeneration: () => number;
  grant: (name: string, decision: BoardGrantDecision) => Promise<void>;
  movePointerDown: (widget: BoardWidget, event: PointerEvent) => void;
  resizePointerDown: (widget: BoardWidget, event: PointerEvent) => void;
  moveToTab: (widget: BoardWidget, tabId: string) => Promise<void>;
  resizeTo: (widget: BoardWidget, w: number, h: number) => Promise<void>;
  setHeightMode: (widget: BoardWidget, mode: "auto" | "fixed") => Promise<void>;
  reportContentHeight: (name: string, height: number) => void;
  remove: (widget: BoardWidget) => Promise<void>;
  nudge: (widget: BoardWidget, direction: BoardGridDirection) => Promise<void>;
  focus: (widget: BoardWidget, direction: BoardGridDirection) => void;
  focusChanged: (name: string) => void;
  frameLoadFailed: (name: string) => Promise<void>;
  widgetAppView: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
  refreshWidgetAppView: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
};

class OpenClawBoardWidgetCell extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) widget?: BoardWidget;
  @property({ attribute: false }) rect?: BoardGridRect;
  @property({ attribute: false }) contentHeightPx?: number;
  @property({ type: Boolean }) fitAutoContent = false;
  @property({ attribute: false }) tabs: readonly BoardTab[] = [];
  @property({ attribute: false }) session: BoardGetParams = { sessionKey: "" };
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) widgetFrameUrl?: BoardWidgetFrameUrl;
  @property({ attribute: false }) callbacks?: BoardWidgetCellCallbacks;
  @property({ type: Boolean }) active = true;
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
  private readonly pluginSubscriptions = new SubscriptionsController(this).watch(
    () => this.context?.plugins,
    (plugins, notify) => plugins.subscribe(notify),
  );
  private readonly appView = new BoardMcpAppLifecycle({
    active: () => this.active,
    connected: () => this.isConnected,
    requestUpdate: () => this.requestUpdate(),
    sessionKey: () => this.sessionKey,
    widget: () => this.widget,
  });
  private readonly frame = new BoardWidgetFrameLifecycle({
    active: () => this.active,
    connected: () => this.isConnected,
    context: () => this.context,
    refreshFrame: () => this.callbacks?.frameLoadFailed,
    reportContentHeight: (name, height) => this.callbacks?.reportContentHeight(name, height),
    scrollBy: (deltaY) => {
      this.closest("openclaw-board-view")?.scrollBy({ top: deltaY, behavior: "auto" });
    },
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
    if (changed.has("active")) {
      this.appView.activityChanged();
      this.frame.activityChanged();
      if (this.active) {
        this.appView.observe(
          this.querySelector(".board-widget"),
          this.widget?.contentKind === "mcp-app",
        );
      }
    }
    this.syncPluginRenderer();
  }

  override updated(): void {
    if (!this.isConnected) {
      this.appView.observe(null, false);
      return;
    }
    this.appView.observe(
      this.querySelector(".board-widget"),
      this.active && this.widget?.contentKind === "mcp-app",
    );
    queueMicrotask(() => {
      if (this.isConnected) {
        this.appView.sync();
      }
    });
    this.frame.update();
  }

  override disconnectedCallback(): void {
    this.pluginSubscriptions.clear();
    this.resetPluginRenderer();
    this.frame.disconnect();
    this.appView.disconnect();
    super.disconnectedCallback();
  }

  private async runAction(action: () => Promise<void>, failureMessage?: string): Promise<void> {
    if (this.actionPending || this.busy) {
      return;
    }
    this.actionPending = true;
    this.actionError = "";
    closeBoardWidgetMenu(this);
    try {
      await action();
    } catch (error) {
      this.actionError = formatUiError(error);
      if (failureMessage) {
        showToast({ message: failureMessage });
      }
    } finally {
      this.actionPending = false;
    }
  }

  private runGrantDecision(
    widget: BoardWidget,
    callbacks: BoardWidgetCellCallbacks,
    decision: BoardGrantDecision,
  ): void {
    const failureMessage = t(
      decision === "granted" ? "board.widget.allowFailed" : "board.widget.rejectFailed",
    );
    void this.runAction(() => callbacks.grant(widget.name, decision), failureMessage);
  }

  private handleMenuSelect(
    event: CustomEvent<{ item: { value?: string } }>,
    widget: BoardWidget,
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

  private renderMcpApp(widget: BoardWidget, callbacks: BoardWidgetCellCallbacks): TemplateResult {
    void ensureCustomElementDefined("mcp-app-view", loadMcpAppView).catch(() => undefined);
    const accessNotice =
      widget.grantState === "pending"
        ? renderBoardWidgetPending({
            widget,
            disabled: this.busy || this.actionPending || !this.canGrant,
            onGrant: (decision) => this.runGrantDecision(widget, callbacks, decision),
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
      active: this.active,
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

  private renderBody(widget: BoardWidget, callbacks: BoardWidgetCellCallbacks): TemplateResult {
    if (widget.contentKind === "mcp-app") {
      return this.renderMcpApp(widget, callbacks);
    }
    if (widget.grantState === "pending") {
      return renderBoardWidgetPending({
        widget,
        disabled: this.busy || this.actionPending || !this.canGrant,
        onGrant: (decision) => this.runGrantDecision(widget, callbacks, decision),
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
    if (widget.contentKind === "plugin" && widget.frameUrl) {
      return this.frame.render(widget);
    }
    if (widget.contentKind === "plugin") {
      const pluginId = pluginIdForWidgetKind(widget.pluginKind);
      const activeKinds = this.context?.gateway.snapshot.hello?.controlUiWidgetKinds ?? [];
      const runtime = this.context?.plugins;
      const key = `${pluginId}/${widget.pluginKind?.slice(pluginId.length + 1)}`;
      const advertised = activeKinds.some(
        (entry) => entry.kind === widget.pluginKind && entry.pluginId === pluginId,
      );
      const native = advertised
        ? runtime?.registrations("widgets").find((entry) => entry.key === key)
        : undefined;
      // Keep healthy renderers visible while their replacement loads or fails.
      if (native) {
        return renderPluginContribution(
          "widgets",
          key,
          {
            ...this.session,
            widget: { name: widget.name, props: widget.props },
            canMutate: this.canMutate,
            canGrant: this.canGrant,
          },
          nothing,
          this.active,
        );
      }
      if (this.pluginRendererError) {
        return renderBoardWidgetError(this.pluginRendererError, () => this.retryPluginRenderer());
      }
      if (this.pluginRenderer) {
        return this.pluginRenderer({
          widget,
          sessionKey: this.sessionKey,
          active: this.active,
          canMutate: this.canMutate,
          requestUpdate: () => this.requestUpdate(),
        });
      }
      const contribution = getPluginWidgetKindContribution(widget.pluginKind, activeKinds);
      if (
        contribution ||
        (this.context && this.context.gateway.snapshot.phase !== "connected") ||
        runtime?.isLoading(pluginId)
      ) {
        return html`<p class="board-widget__plugin-loading">${t("board.widget.pluginLoading")}</p>`;
      }
      const disabled = renderCustomPluginUiDisabled(this.context, pluginId);
      if (!disabled && advertised && runtime) {
        const error = runtime.errors.find(
          (entry) => entry.pluginId === pluginId || entry.pluginId === "host",
        );
        if (error) {
          return renderBoardWidgetError(error.message, () => void runtime.refresh());
        }
      }
      return renderBoardDisabledPlugin({
        pluginId,
        content: disabled,
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
      widget?.contentKind === "plugin" && !widget.frameUrl
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
          this.pluginRendererError = formatUiError(error);
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
    widget: BoardWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): void {
    if (event.target !== event.currentTarget || !this.canMutate) {
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
    const readOnly = !this.canMutate;
    const bodyScrollable =
      bodyErrored ||
      this.actionError !== "" ||
      widget.grantState === "pending" ||
      widget.grantState === "rejected";
    const contentScrollable =
      bodyScrollable ||
      widget.contentKind === "mcp-app" ||
      (widget.contentKind === "plugin" && !widget.frameUrl);
    const presentation =
      widget.contentKind === "html" || widget.frameUrl
        ? (widget.presentation ?? "card")
        : undefined;
    // While a move/resize gesture runs, the card fills its (preview) cell so
    // the user manipulates the quantized rect they will actually commit.
    const exactHeightPx = this.dragging
      ? undefined
      : exactBoardWidgetHeightPx(
          widget,
          this.contentHeightPx,
          boardChromeRowPx(),
          this.fitAutoContent ? BOARD_DOCUMENT_AUTO_MAX_ROWS : undefined,
        );
    const exactHeightStyle =
      exactHeightPx === undefined ? "" : ` height: ${exactHeightPx}px; align-self: start;`;
    return html`
      <section
        class=${`board-widget ${this.dragging ? "board-widget--dragging" : ""} ${presentation ? `board-widget--${presentation}` : ""}`}
        style=${`${toCssPlacement(rect)} --board-widget-rows: ${rect.h}; --board-widget-order: ${this.positionInSet};${exactHeightStyle}`}
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
          ${
            readOnly
              ? nothing
              : html`<span
                  class="board-widget__drag-handle"
                  aria-hidden="true"
                  title=${t("board.widget.moveHandle", { title: label })}
                  @pointerdown=${(event: PointerEvent) => callbacks.movePointerDown(widget, event)}
                >
                  <span aria-hidden="true">⠿</span>
                </span>`
          }
          <span class="board-widget__title" title=${label}>${label}</span>
          <span class="board-widget__kind"
            >${
              widget.contentKind === "mcp-app"
                ? t("board.widget.kindMcp")
                : widget.contentKind === "plugin"
                  ? widget.kindLabel || this.pluginRendererLabel || t("board.widget.kindPlugin")
                  : t("board.widget.kindHtml")
            }</span
          >
          ${renderBoardGrantedCapabilities(widget)}
          ${
            readOnly
              ? nothing
              : renderBoardWidgetMenu({
                  widget,
                  tabs: this.tabs,
                  disabled: this.busy || this.actionPending,
                  onSelect: (event) => this.handleMenuSelect(event, widget, callbacks),
                })
          }
        </header>
        <div
          class=${`board-widget__body ${contentScrollable ? "board-widget__body--scrollable" : ""} ${presentation === "card" ? "board-widget__body--card" : ""}`}
        >
          ${body}
          ${
            this.actionError && widget.grantState !== "pending"
              ? html`<div class="board-widget__error-overlay">
                  ${renderBoardWidgetActionError(this.actionError)}
                </div>`
              : nothing
          }
        </div>
        ${
          readOnly
            ? nothing
            : html`<span
                class="board-widget__resize-handle"
                aria-hidden="true"
                title=${t("board.widget.resizeHandle", { title: label })}
                @pointerdown=${(event: PointerEvent) => callbacks.resizePointerDown(widget, event)}
              ></span>`
        }
        ${
          widget.grantState === "granted"
            ? html`<span class="board-widget__grant-dot" aria-hidden="true"></span>`
            : nothing
        }
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
