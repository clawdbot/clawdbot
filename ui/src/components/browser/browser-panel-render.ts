import { html, nothing, svg } from "lit";
import { t } from "../../i18n/index.ts";
import { openExternalUrlSafe } from "../../lib/open-external-url.ts";
import type { BrowserPanelController } from "./browser-panel-controller.ts";
import { renderBrowserPanelTabs } from "./browser-panel-tabs.ts";

const CLOSE_GLYPH = svg`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>`;
const DOCK_BOTTOM_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 10h12" /></svg>`;
const DOCK_RIGHT_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M10 2.5v11" /></svg>`;
const BACK_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5" /></svg>`;
const FORWARD_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5" /></svg>`;
const RELOAD_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" /></svg>`;
const EXTERNAL_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 3.5H3.5v9h9V9.5M9.5 3h3.5v3.5M12.8 3.2L7.5 8.5" /></svg>`;
const PENCIL_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.3 2.7l2 2L5 13H3v-2z" /></svg>`;
const INSPECT_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l5.5 10 1.2-4.3L14 7.5z" /></svg>`;

export type BrowserPanelDock = "bottom" | "right";

function renderTabStrip(controller: BrowserPanelController) {
  return renderBrowserPanelTabs({
    tabs: controller.tabs,
    activeTargetId: controller.activeTargetId,
    onSelect: (targetId) => void controller.selectTab(targetId),
    onClose: (targetId) => void controller.closeTab(targetId),
    onNew: () => controller.beginNewTab(),
  });
}

function renderHeaderActions(
  controller: BrowserPanelController,
  dock: BrowserPanelDock,
  onDockChange: (dock: BrowserPanelDock) => void,
  onClose: () => void,
) {
  const activeUrl = controller.view?.metrics?.url || controller.view?.url || controller.urlDraft;
  return html`
    <div class="bp-actions">
      <button
        class="bp-icon ${dock === "bottom" ? "is-active" : ""}"
        type="button"
        title=${t("browser.dockBottom")}
        aria-label=${t("browser.dockBottom")}
        @click=${() => onDockChange("bottom")}
      >
        ${DOCK_BOTTOM_GLYPH}
      </button>
      <button
        class="bp-icon ${dock === "right" ? "is-active" : ""}"
        type="button"
        title=${t("browser.dockRight")}
        aria-label=${t("browser.dockRight")}
        @click=${() => onDockChange("right")}
      >
        ${DOCK_RIGHT_GLYPH}
      </button>
      <button
        class="bp-icon"
        type="button"
        title=${t("browser.openExternal")}
        aria-label=${t("browser.openExternal")}
        ?disabled=${!activeUrl}
        @click=${() => {
          if (activeUrl) {
            openExternalUrlSafe(activeUrl);
          }
        }}
      >
        ${EXTERNAL_GLYPH}
      </button>
      <button
        class="bp-icon"
        type="button"
        title=${t("browser.hide")}
        aria-label=${t("browser.hide")}
        @click=${onClose}
      >
        ${CLOSE_GLYPH}
      </button>
    </div>
  `;
}

function renderToolbar(controller: BrowserPanelController) {
  const hasView = Boolean(controller.view);
  return html`
    <div class="bp-toolbar">
      <button
        class="bp-icon"
        type="button"
        title=${t("browser.back")}
        aria-label=${t("browser.back")}
        ?disabled=${!hasView || controller.evaluateUnavailable}
        @click=${() => controller.goHistory(-1)}
      >
        ${BACK_GLYPH}
      </button>
      <button
        class="bp-icon"
        type="button"
        title=${t("browser.forward")}
        aria-label=${t("browser.forward")}
        ?disabled=${!hasView || controller.evaluateUnavailable}
        @click=${() => controller.goHistory(1)}
      >
        ${FORWARD_GLYPH}
      </button>
      <button
        class="bp-icon"
        type="button"
        title=${t("browser.reload")}
        aria-label=${t("browser.reload")}
        ?disabled=${!controller.activeTargetId}
        @click=${() => controller.reloadPage()}
      >
        ${RELOAD_GLYPH}
      </button>
      <input
        class="bp-url"
        type="text"
        spellcheck="false"
        autocomplete="off"
        placeholder=${t("browser.urlPlaceholder")}
        .value=${controller.urlDraft}
        @focus=${(event: FocusEvent) => {
          controller.setUrlDraftEditing(true);
          (event.target as HTMLInputElement).select();
        }}
        @blur=${() => controller.setUrlDraftEditing(false)}
        @input=${(event: InputEvent) =>
          controller.setUrlDraft((event.target as HTMLInputElement).value)}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Enter") {
            event.preventDefault();
            controller.commitUrlDraft();
            (event.target as HTMLInputElement).blur();
          } else if (event.key === "Escape") {
            controller.resetUrlDraftFromView();
            (event.target as HTMLInputElement).blur();
          }
        }}
      />
      <button
        class="bp-icon ${controller.mode === "annotate" ? "is-active" : ""}"
        type="button"
        title=${t("browser.annotate")}
        aria-label=${t("browser.annotate")}
        ?disabled=${!hasView}
        @click=${() => controller.setMode("annotate")}
      >
        ${PENCIL_GLYPH}
      </button>
      <button
        class="bp-icon ${controller.mode === "inspect" ? "is-active" : ""}"
        type="button"
        title=${controller.evaluateUnavailable
          ? t("browser.inspectUnavailable")
          : t("browser.inspect")}
        aria-label=${t("browser.inspect")}
        ?disabled=${!hasView || controller.evaluateUnavailable}
        @click=${() => controller.setMode("inspect")}
      >
        ${INSPECT_GLYPH}
      </button>
    </div>
  `;
}

function renderAnnotateBar(controller: BrowserPanelController) {
  if (controller.mode !== "annotate") {
    return nothing;
  }
  return html`
    <div class="bp-annotatebar">
      <span class="bp-annotatebar__hint">${t("browser.annotateHint")}</span>
      <button
        class="bp-btn"
        type="button"
        ?disabled=${controller.strokes.length === 0}
        @click=${() => controller.undoStroke()}
      >
        ${t("browser.annotateUndo")}
      </button>
      <button
        class="bp-btn"
        type="button"
        ?disabled=${controller.strokes.length === 0}
        @click=${() => controller.clearStrokes()}
      >
        ${t("browser.annotateClear")}
      </button>
      <button
        class="bp-btn"
        type="button"
        title=${t("browser.annotateDone")}
        @click=${() => controller.exitCaptureModes()}
      >
        ${CLOSE_GLYPH}
      </button>
      <button
        class="bp-btn bp-btn--primary"
        type="button"
        ?disabled=${controller.strokes.length === 0}
        @click=${() => void controller.sendAnnotation({})}
      >
        ${t("browser.annotateSend")}
      </button>
    </div>
  `;
}

function renderInspectTooltip(controller: BrowserPanelController) {
  const node = controller.inspected;
  const pointer = controller.inspectPointer;
  if (controller.mode !== "inspect" || !node || !pointer) {
    return nothing;
  }
  const left = `${Math.min(92, Math.max(0, pointer.x * 100))}%`;
  const top = `${Math.min(92, Math.max(0, pointer.y * 100 + 2))}%`;
  const classes = node.classes.map((className) => `.${className}`).join("");
  return html`
    <div class="bp-tooltip" style="left:${left};top:${top}">
      <div class="bp-tooltip__title">
        <span class="bp-tooltip__selector"
          >${node.tag}${node.id ? `#${node.id}` : ""}${classes}</span
        >
        <span class="bp-tooltip__size"
          >${Math.round(node.rect.width)} × ${Math.round(node.rect.height)}</span
        >
      </div>
      ${node.name
        ? html`<div class="bp-tooltip__row">
            <span>${t("browser.inspectName")}</span><span>${node.name}</span>
          </div>`
        : nothing}
      ${node.role
        ? html`<div class="bp-tooltip__row">
            <span>${t("browser.inspectRole")}</span><span>${node.role}</span>
          </div>`
        : nothing}
      <div class="bp-tooltip__row">
        <span>${t("browser.inspectFocusable")}</span><span>${node.focusable ? "✓" : "–"}</span>
      </div>
    </div>
  `;
}

function renderViewportContent(controller: BrowserPanelController) {
  if (controller.running === false) {
    return html`
      <div class="bp-status">
        <span>${t("browser.notRunning")}</span>
        <button
          class="bp-btn bp-btn--primary"
          type="button"
          @click=${() => void controller.startBrowserNow()}
        >
          ${t("browser.start")}
        </button>
      </div>
    `;
  }
  if (!controller.view) {
    return html`
      <div class="bp-status">
        <span>${controller.loading ? t("browser.loading") : t("browser.empty")}</span>
      </div>
    `;
  }
  const overlayMode =
    controller.mode === "annotate"
      ? "bp-overlay--annotate"
      : controller.mode === "inspect"
        ? "bp-overlay--inspect"
        : "";
  return html`
    <div class="bp-stage">
      <img
        class="bp-shot"
        src=${controller.view.dataUrl}
        alt=${controller.view.metrics?.title || ""}
      />
      <canvas
        class="bp-overlay ${overlayMode}"
        @click=${(event: MouseEvent) => controller.handleStageClick(event)}
        @pointerdown=${(event: PointerEvent) => controller.handleOverlayPointerDown(event)}
        @pointermove=${(event: PointerEvent) => controller.handleOverlayPointerMove(event)}
        @pointerup=${() => controller.handleOverlayPointerUp()}
        @pointercancel=${() => controller.handleOverlayPointerUp()}
      ></canvas>
      ${renderInspectTooltip(controller)}
    </div>
  `;
}

function renderViewport(controller: BrowserPanelController) {
  return html`
    <wa-tab-panel
      id="browser-tab-panel"
      class="bp-viewport"
      name=${controller.activeTargetId ?? "browser"}
      active
      aria-labelledby=${controller.activeTargetId
        ? `browser-tab-${controller.activeTargetId}`
        : nothing}
      tabindex="0"
      @wheel=${(event: WheelEvent) => controller.handleWheel(event)}
      @keydown=${(event: KeyboardEvent) => controller.handleViewportKeydown(event)}
    >
      ${controller.loading && controller.view
        ? html`<span class="bp-loading">${t("browser.loading")}</span>`
        : nothing}
      ${renderViewportContent(controller)}
    </wa-tab-panel>
  `;
}

export function renderBrowserPanelChrome(
  controller: BrowserPanelController,
  dock: BrowserPanelDock,
  height: number,
  width: number,
  onDockChange: (dock: BrowserPanelDock) => void,
  onClose: () => void,
  onResize: (event: PointerEvent) => void,
) {
  const style = dock === "bottom" ? `height:${height}px` : `width:${width}px`;
  return html`
    <section class="bp bp--${dock}" style=${style} aria-label=${t("browser.title")}>
      <div
        class="bp-resizer bp-resizer--${dock}"
        @pointerdown=${onResize}
        role="separator"
        aria-label=${t("browser.resize")}
      ></div>
      <header class="bp-header">
        ${renderTabStrip(controller)}
        ${renderHeaderActions(controller, dock, onDockChange, onClose)}
      </header>
      ${renderToolbar(controller)} ${renderAnnotateBar(controller)}
      ${controller.errorText
        ? html`<div class="bp-note bp-note--error" role="alert">${controller.errorText}</div>`
        : controller.noticeText
          ? html`<div class="bp-note" role="status">${controller.noticeText}</div>`
          : nothing}
      ${renderViewport(controller)}
    </section>
  `;
}
