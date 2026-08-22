import { html, nothing, svg, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import { openExternalUrlSafe } from "../../lib/open-external-url.ts";
import { renderDockDestinations } from "../dock-destination-controls.ts";
import { icons } from "../icons.ts";
import { renderPanelEmptyState } from "../panel-empty-state.ts";
import type { BrowserPanelController } from "./browser-panel-controller.ts";
import { renderBrowserPanelTabs } from "./browser-panel-tabs.ts";

const CLOSE_GLYPH = svg`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>`;
const BACK_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5" /></svg>`;
const FORWARD_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5" /></svg>`;
const RELOAD_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" /></svg>`;
const PENCIL_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.3 2.7l2 2L5 13H3v-2z" /></svg>`;
const INSPECT_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l5.5 10 1.2-4.3L14 7.5z" /></svg>`;

export type BrowserPanelDock = "bottom" | "right";

function renderTabStrip(controller: BrowserPanelController, embedded: boolean) {
  return renderBrowserPanelTabs({
    tabs: controller.tabs,
    activeTargetId: controller.activeTargetId,
    onSelect: (targetId) => void controller.selectTab(targetId),
    onClose: (targetId) => controller.closeTab(targetId),
    onNew: () => controller.beginNewTab(),
    hideNewControl: embedded,
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
    <div class="rail-header__actions bp-actions">
      ${renderDockDestinations({
        current: dock,
        groupClass: "bp-dock-modes",
        groupLabel: t("browser.title"),
        destinations: [
          {
            dock: "bottom",
            label: t("browser.dockBottom"),
            icon: icons.panelBottomOpen,
            className: "bp-icon",
          },
          {
            dock: "right",
            label: t("browser.dockRight"),
            icon: icons.panelRightOpen,
            className: "bp-icon",
          },
        ],
        onSelect: onDockChange,
      })}
      <button
        class="rail-header__action bp-icon"
        type="button"
        data-new-tab-action
        title=${t("browser.openExternal")}
        aria-label=${t("browser.openExternal")}
        ?disabled=${!activeUrl}
        @click=${() => {
          if (activeUrl) {
            openExternalUrlSafe(activeUrl);
          }
        }}
      >
        ${icons.externalLink}
      </button>
      <button
        class="rail-header__action bp-icon"
        type="button"
        title=${t("browser.close")}
        aria-label=${t("browser.close")}
        @click=${onClose}
      >
        ${icons.x}
      </button>
    </div>
  `;
}

function renderToolbar(controller: BrowserPanelController, embedded: boolean) {
  const hasView = Boolean(controller.view);
  return html`
    <div class="bp-toolbar">
      ${embedded
        ? html`<button
            class="bp-icon"
            type="button"
            data-new-tab-action
            title=${t("browser.newTab")}
            aria-label=${t("browser.newTab")}
            @click=${() => controller.beginNewTab()}
          >
            ${icons.plus}
          </button>`
        : nothing}
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
    return renderPanelEmptyState({
      icon: icons.globe,
      heading: t("chat.sidePanel.browser"),
      description: t("browser.notRunning"),
      action: html`
        <button class="bp-btn" type="button" @click=${() => void controller.startBrowserNow()}>
          ${t("browser.start")}
        </button>
      `,
    });
  }
  if (!controller.view) {
    return controller.loading
      ? html`<div class="bp-status"><span>${t("browser.loading")}</span></div>`
      : renderPanelEmptyState({
          icon: icons.globe,
          heading: t("chat.sidePanel.browser"),
          description: t("chat.sidePanel.browserEmpty"),
        });
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
  resizer: TemplateResult | typeof nothing,
  embedded = false,
) {
  const style = embedded ? nothing : dock === "bottom" ? `height:${height}px` : `width:${width}px`;
  return html`
    <section
      class="bp bp--${embedded ? "embedded" : dock}"
      style=${style}
      aria-label=${t("browser.title")}
    >
      ${embedded ? nothing : resizer}
      ${embedded && controller.tabs.length === 0
        ? nothing
        : html`<header class="rail-header bp-header">
            ${renderTabStrip(controller, embedded)}
            ${embedded ? nothing : renderHeaderActions(controller, dock, onDockChange, onClose)}
          </header>`}
      ${renderToolbar(controller, embedded)} ${renderAnnotateBar(controller)}
      ${controller.errorText
        ? html`<div class="bp-note bp-note--error" role="alert">${controller.errorText}</div>`
        : controller.noticeText
          ? html`<div class="bp-note" role="status">${controller.noticeText}</div>`
          : nothing}
      ${renderViewport(controller)}
    </section>
  `;
}
