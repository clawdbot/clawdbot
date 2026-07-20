import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewaySessionRow } from "../../api/types.ts";
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
import { getBuiltinWidgetRenderer } from "../../lib/board/widgets/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { renderBoardMcpAppContent } from "./board-mcp-app-content.ts";
import { BoardMcpAppLifecycle } from "./board-mcp-app-lifecycle.ts";
import { renderBoardWidgetFrame } from "./board-widget-frame.ts";
import "../web-awesome.ts";

const BOARD_SIZE_PRESETS = {
  sm: { w: 3, h: 3 },
  md: { w: 6, h: 4 },
  lg: { w: 8, h: 6 },
  xl: { w: 12, h: 8 },
} as const;
const MAX_FRAME_REFRESH_ATTEMPTS = 3;
const loadMcpAppView = () => import("../mcp-app-view-registration.ts");

export type BoardWidgetCellCallbacks = {
  grant: (name: string, decision: BoardGrantDecision) => Promise<void>;
  movePointerDown: (widget: BoardViewWidget, event: PointerEvent) => void;
  resizePointerDown: (widget: BoardViewWidget, event: PointerEvent) => void;
  moveToTab: (widget: BoardViewWidget, tabId: string) => Promise<void>;
  resizeTo: (widget: BoardViewWidget, w: number, h: number) => Promise<void>;
  remove: (widget: BoardViewWidget) => Promise<void>;
  nudge: (widget: BoardViewWidget, direction: BoardGridDirection) => Promise<void>;
  focus: (widget: BoardViewWidget, direction: BoardGridDirection) => void;
  focusChanged: (name: string) => void;
  frameLoadFailed: (name: string) => Promise<void>;
  widgetAppView: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
  refreshWidgetAppView: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
};

class OpenClawBoardWidgetCell extends OpenClawLightDomElement {
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

  @state() private actionError = "";
  @state() private actionPending = false;
  @state() private frameError = "";
  private frameFailureKey = "";
  private frameRefreshAttempts = 0;
  private frameProbeGeneration = 0;
  private lastFrameUrl = "";
  private readonly appView = new BoardMcpAppLifecycle({
    connected: () => this.isConnected,
    requestUpdate: () => this.requestUpdate(),
    sessionKey: () => this.sessionKey,
    widget: () => this.widget,
  });

  override connectedCallback(): void {
    super.connectedCallback();
    this.requestUpdate();
  }

  override willUpdate(changed: PropertyValues<this>): void {
    const previousWidget = changed.get("widget");
    if (previousWidget && previousWidget !== this.widget) {
      this.actionError = "";
      if (
        previousWidget.name !== this.widget?.name ||
        previousWidget.revision !== this.widget?.revision
      ) {
        this.resetFrameFailures();
      } else if (this.widget && this.frameError) {
        const nextFrameUrl = this.widgetFrameUrl?.(this.widget.name, this.widget.revision) ?? "";
        if (nextFrameUrl && nextFrameUrl !== this.lastFrameUrl) {
          // A newly minted ticket gets one authorization probe, but keeps the
          // existing remint budget until that probe proves the frame healthy.
          this.frameError = "";
        }
      }
    }
    this.appView.update(this.widget, this.callbacks);
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
  }

  override disconnectedCallback(): void {
    this.appView.disconnect();
    super.disconnectedCallback();
  }

  private resetFrameFailures(): void {
    this.frameProbeGeneration += 1;
    this.frameFailureKey = "";
    this.frameRefreshAttempts = 0;
    this.frameError = "";
  }

  private closeMenu(): void {
    const menu = this.querySelector<HTMLElement & { open: boolean }>(".board-widget__menu");
    if (menu) {
      menu.open = false;
    }
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    if (this.actionPending || this.busy) {
      return;
    }
    this.actionPending = true;
    this.actionError = "";
    this.closeMenu();
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
    }
  }

  private renderMenu(widget: BoardViewWidget, callbacks: BoardWidgetCellCallbacks): TemplateResult {
    const otherTabs = this.tabs.filter((tab) => tab.tabId !== widget.tabId);
    return html`
      <wa-dropdown
        class="board-widget__menu"
        placement="bottom-end"
        @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) =>
          this.handleMenuSelect(event, widget, callbacks)}
      >
        <button
          class="board-widget__menu-trigger"
          slot="trigger"
          type="button"
          aria-label=${t("board.widget.menuLabel")}
          title=${t("board.widget.menuLabel")}
        >
          ⋮
        </button>
        <div class="board-widget__menu-heading">${t("board.widget.moveToTab")}</div>
        ${otherTabs.length > 0
          ? otherTabs.map(
              (tab) => html`
                <wa-dropdown-item
                  value=${`move:${tab.tabId}`}
                  ?disabled=${this.busy || this.actionPending}
                >
                  ${tab.title}
                </wa-dropdown-item>
              `,
            )
          : html`<span class="board-widget__menu-empty">${t("board.widget.noOtherTabs")}</span>`}
        <div class="board-widget__menu-heading">${t("board.widget.resize")}</div>
        ${Object.entries(BOARD_SIZE_PRESETS).map(
          ([label, size]) => html`
            <wa-dropdown-item
              class="board-widget__preset"
              value=${`resize:${label}`}
              ?disabled=${this.busy || this.actionPending}
            >
              ${label.toUpperCase()}
              <span slot="details">${size.w}×${size.h}</span>
            </wa-dropdown-item>
          `,
        )}
        <div class="board-widget__menu-separator" role="separator"></div>
        <wa-dropdown-item
          class="board-widget__menu-danger"
          value="remove"
          ?disabled=${this.busy || this.actionPending}
        >
          ${t("board.widget.remove")}
        </wa-dropdown-item>
      </wa-dropdown>
    `;
  }

  private renderPending(
    widget: BoardViewWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): TemplateResult {
    return html`
      <div class="board-widget__grant board-widget__grant--pending" data-test-id="board-pending">
        <div class="board-widget__grant-mark" aria-hidden="true">!</div>
        <strong>${t("board.widget.needsApproval")}</strong>
        ${widget.declaredSummary?.length
          ? html`<ul class="board-widget__grant-summary">
              ${widget.declaredSummary.map((summary) => html`<li>${summary}</li>`)}
            </ul>`
          : html`<span>${t("board.widget.needsApprovalDetail")}</span>`}
        <div class="board-widget__grant-actions">
          <button
            class="btn btn--small btn--primary"
            type="button"
            data-test-id="board-grant-allow"
            ?disabled=${this.busy || this.actionPending}
            @click=${() => void this.runAction(() => callbacks.grant(widget.name, "granted"))}
          >
            ${t("board.widget.allow")}
          </button>
          <button
            class="btn btn--small"
            type="button"
            data-test-id="board-grant-reject"
            ?disabled=${this.busy || this.actionPending}
            @click=${() => void this.runAction(() => callbacks.grant(widget.name, "rejected"))}
          >
            ${t("board.widget.reject")}
          </button>
        </div>
        ${this.actionError ? this.renderActionError(this.actionError, true) : nothing}
      </div>
    `;
  }

  private renderRejected(
    widget: BoardViewWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): TemplateResult {
    return html`
      <div class="board-widget__grant board-widget__grant--rejected" data-test-id="board-rejected">
        <strong>${t("board.widget.rejected")}</strong>
        <span>${t("board.widget.rejectedDetail")}</span>
        <button
          class="btn btn--small"
          type="button"
          ?disabled=${this.busy || this.actionPending}
          @click=${() => void this.runAction(() => callbacks.remove(widget))}
        >
          ${t("board.widget.remove")}
        </button>
      </div>
    `;
  }

  private refreshFailedFrame(widget: BoardViewWidget, callbacks: BoardWidgetCellCallbacks): void {
    this.frameProbeGeneration += 1;
    const failureKey = `${widget.name}:${widget.revision}`;
    if (this.frameFailureKey !== failureKey) {
      this.resetFrameFailures();
      this.frameFailureKey = failureKey;
    }
    if (this.frameRefreshAttempts >= MAX_FRAME_REFRESH_ATTEMPTS) {
      this.frameError = t("board.widget.frameAuthorizationFailed");
      return;
    }
    this.frameRefreshAttempts += 1;
    void callbacks.frameLoadFailed(widget.name).catch((error: unknown) => {
      this.frameError = error instanceof Error ? error.message : String(error);
    });
  }

  private verifyFrameAuthorization(
    event: Event,
    widget: BoardViewWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): void {
    const frame = event.currentTarget;
    const src = frame instanceof HTMLIFrameElement ? (frame.getAttribute("src") ?? "") : "";
    if (!src.startsWith("/__openclaw__/board/")) {
      return;
    }
    const probeGeneration = this.frameProbeGeneration + 1;
    this.frameProbeGeneration = probeGeneration;
    const isCurrentProbe = () =>
      frame instanceof HTMLIFrameElement &&
      frame.isConnected &&
      frame.getAttribute("src") === src &&
      this.frameProbeGeneration === probeGeneration &&
      this.widget?.name === widget.name &&
      this.widget.revision === widget.revision;
    // View tickets are reusable HMAC bindings until expiry. Iframe load events
    // hide HTTP status, so a credentialed probe is the only 401 signal.
    void fetch(src, { cache: "no-store" })
      .then((response) => {
        if (!isCurrentProbe()) {
          return;
        }
        if (response.status === 401) {
          this.refreshFailedFrame(widget, callbacks);
        } else if (response.ok) {
          this.resetFrameFailures();
        }
      })
      .catch(() => {
        if (isCurrentProbe()) {
          this.refreshFailedFrame(widget, callbacks);
        }
      });
  }

  private renderFrame(
    widget: BoardViewWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): TemplateResult {
    return renderBoardWidgetFrame(
      widget,
      this.widgetFrameUrl,
      (src) => (this.lastFrameUrl = src),
      () => this.refreshFailedFrame(widget, callbacks),
      (event) => this.verifyFrameAuthorization(event, widget, callbacks),
    );
  }

  private renderMcpApp(
    widget: BoardViewWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): TemplateResult {
    void ensureCustomElementDefined("mcp-app-view", loadMcpAppView).catch(() => undefined);
    const accessNotice =
      widget.grantState === "pending"
        ? this.renderPending(widget, callbacks)
        : widget.grantState === "rejected"
          ? this.renderRejected(widget, callbacks)
          : nothing;
    return renderBoardMcpAppContent({
      accessNotice,
      appView: this.appView.state,
      busy: this.busy || this.actionPending,
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
      return this.renderPending(widget, callbacks);
    }
    if (widget.grantState === "rejected") {
      return this.renderRejected(widget, callbacks);
    }
    if (widget.contentKind === "builtin") {
      const renderer = getBuiltinWidgetRenderer(widget.builtin);
      if (!renderer) {
        throw new Error(t("board.widget.frameResolverMissing"));
      }
      return renderer({ sessions: this.sessions, sessionKey: this.sessionKey });
    }
    return this.renderFrame(widget, callbacks);
  }

  private renderError(error: unknown): TemplateResult {
    const message = error instanceof Error ? error.message : String(error);
    return html`
      <div class="board-widget__error" role="alert" data-test-id="board-widget-error">
        <strong>${t("board.widget.errorTitle")}</strong>
        <span>${t("board.widget.errorDetail")}</span>
        <details>
          <summary>${t("board.widget.errorShow")}</summary>
          <code>${message}</code>
        </details>
      </div>
    `;
  }

  private renderActionError(error: string, inline = false): TemplateResult {
    return html`
      <div
        class=${`board-widget__error ${inline ? "board-widget__error--inline" : ""}`}
        role="alert"
        data-test-id="board-widget-action-error"
      >
        <strong>${t("board.widget.actionErrorTitle")}</strong>
        <span>${t("board.widget.actionErrorDetail")}</span>
        <details>
          <summary>${t("board.widget.errorShow")}</summary>
          <code>${error}</code>
        </details>
      </div>
    `;
  }

  private handleKeyDown(
    event: KeyboardEvent,
    widget: BoardViewWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): void {
    if (event.target !== event.currentTarget || widget.readOnly) {
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
      body = this.frameError
        ? this.renderError(this.frameError)
        : this.renderBody(widget, callbacks);
      bodyErrored = Boolean(this.frameError);
    } catch (error) {
      body = this.renderError(error);
      bodyErrored = true;
    }
    const label = widget.title || widget.name;
    const readOnly = widget.readOnly === true;
    const bodyScrollable =
      bodyErrored ||
      this.actionError !== "" ||
      widget.grantState === "pending" ||
      widget.grantState === "rejected";
    const contentScrollable = bodyScrollable || widget.contentKind === "mcp-app";
    return html`
      <section
        class=${`board-widget ${this.dragging ? "board-widget--dragging" : ""}`}
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
                  : t("board.widget.kindHtml")}</span
              >`}
          ${readOnly ? nothing : this.renderMenu(widget, callbacks)}
        </header>
        <div
          class=${`board-widget__body ${contentScrollable ? "board-widget__body--scrollable" : ""}`}
        >
          ${body}
          ${this.actionError && widget.grantState !== "pending"
            ? html`<div class="board-widget__error-overlay">
                ${this.renderActionError(this.actionError)}
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
