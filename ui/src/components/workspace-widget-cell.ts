// Cell chrome for a workspace widget: title bar, collapse toggle, kebab menu,
// provenance badge, and a per-cell error boundary. Pure render fns (workboard
// view idiom) — the Workspaces view owns state and passes callbacks in.
//
// The error boundary wraps the widget body render: a throw yields an error card in
// this cell only, so the shell and sibling widgets are unaffected (spec-30).

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { gridPlacementStyle } from "../lib/workspace/grid.ts";
import { workspaceAgentProvenance, type WorkspaceBindingResult } from "../lib/workspace/index.ts";
import type {
  WorkspaceCreatedBy,
  WorkspaceWidget,
  WorkspaceWidgetStatus,
  WidgetManifestView,
} from "../lib/workspace/types.ts";
import { getBuiltinRenderer, type BuiltinWidgetContext } from "../lib/workspace/widgets/index.ts";
import { icons } from "./icons.ts";
import { renderCustomWidgetHost, type CustomWidgetHostContext } from "./workspace-custom-widget.ts";
import "./web-awesome.ts";

export type WorkspaceWidgetCellCallbacks = {
  onToggleCollapse: (widget: WorkspaceWidget) => void;
  onToggleMenu: (widget: WorkspaceWidget) => void;
  onCloseMenu: (widget: WorkspaceWidget) => void;
  onHide: (widget: WorkspaceWidget) => void;
  onRemove: (widget: WorkspaceWidget) => void;
  onEditTitle: (widget: WorkspaceWidget) => void;
  onMoveToTab: (widget: WorkspaceWidget) => void;
  onMovePointerDown: (widget: WorkspaceWidget, event: PointerEvent) => void;
  onResizePointerDown: (widget: WorkspaceWidget, event: PointerEvent) => void;
  onKeyboardNudge: (
    widget: WorkspaceWidget,
    mode: "move" | "resize",
    direction: "left" | "right" | "up" | "down",
  ) => void;
};

/**
 * Custom-widget (`custom:<name>`) rendering context (L5). Passed only for custom
 * widgets; builtin widgets ignore it. Carries the registry approval status (gates
 * whether an iframe is ever built), the loaded manifest, the sandbox host context,
 * and the operator-only approve/reject actions for the pending placeholder.
 */
export type WorkspaceCustomWidgetContext = {
  status: WorkspaceWidgetStatus | null;
  /** Provenance of the scaffolded code being approved, not its layout instance. */
  createdBy?: WorkspaceCreatedBy;
  manifest: WidgetManifestView | null;
  host: CustomWidgetHostContext;
  onApprove: (widget: WorkspaceWidget) => void;
  onReject: (widget: WorkspaceWidget) => void;
};

type WorkspaceWidgetCellProps = {
  widget: WorkspaceWidget;
  /** Resolved binding value for the primary binding, or an error to surface. */
  binding: WorkspaceBindingResult | null;
  menuOpen: boolean;
  pending: boolean;
  /** When set, this cell is the live drag/resize ghost source. */
  dragging: boolean;
  /** Ambient context builtins may need (embed policy for iframe-embed). */
  builtinContext: BuiltinWidgetContext;
  callbacks: WorkspaceWidgetCellCallbacks;
  /** Present for `custom:` widgets only (L5); builtin widgets leave this undefined. */
  custom?: WorkspaceCustomWidgetContext;
};

/**
 * Visible widget title with a trailing " (custom)" provenance suffix stripped
 * (#8). The suffix is redundant with the AI/provenance chip and only causes
 * truncation; the full title is still exposed via the `title=` attribute.
 */
function displayWidgetTitle(title: string): string {
  return title.replace(/\s*\(custom\)\s*$/iu, "").trim() || title;
}

/** Renders the provenance chip when a widget was authored by an agent. */
function renderProvenanceChip(widget: WorkspaceWidget): TemplateResult | typeof nothing {
  const agentId = workspaceAgentProvenance(widget.createdBy);
  if (!agentId) {
    return nothing;
  }
  return html`<span
    class="workspace-widget__provenance"
    title=${t("workspaces.widget.provenanceTooltip", { agent: agentId })}
    >${t("workspaces.widget.provenanceChip")}</span
  >`;
}

function renderMenu(): TemplateResult {
  return html`
    <wa-dropdown-item class="workspace-widget__menu-item" value="edit-title">
      ${t("workspaces.widget.menu.editTitle")}
    </wa-dropdown-item>
    <wa-dropdown-item class="workspace-widget__menu-item" value="move-to-tab">
      ${t("workspaces.widget.menu.moveToTab")}
    </wa-dropdown-item>
    <wa-dropdown-item class="workspace-widget__menu-item" value="hide">
      ${t("workspaces.widget.menu.hide")}
    </wa-dropdown-item>
    <wa-dropdown-item
      class="workspace-widget__menu-item workspace-widget__menu-item--danger"
      value="remove"
      variant="danger"
    >
      ${t("workspaces.widget.menu.remove")}
    </wa-dropdown-item>
  `;
}

/**
 * Renders a builtin widget body via the L4 registry. A binding error is
 * re-thrown so the cell error boundary shows it inline; unknown/custom kinds
 * render a placeholder (L5 replaces custom with the sandboxed iframe host).
 */
function renderBuiltinWidget(
  widget: WorkspaceWidget,
  binding: WorkspaceBindingResult | null,
  ctx: BuiltinWidgetContext,
): TemplateResult {
  if (binding && "error" in binding) {
    // A binding failure is data-level, not a render throw: show it inline so the
    // widget stays mounted and refetches on the next broadcast.
    throw new Error(binding.error);
  }
  const value = binding && "value" in binding ? binding.value : undefined;
  const renderer = getBuiltinRenderer(widget.kind);
  if (renderer) {
    return renderer(widget, value, ctx);
  }
  if (widget.kind.startsWith("custom:")) {
    // Custom widgets are dispatched by renderWidgetBody BEFORE this builtin path;
    // reaching here means no L5 host context was supplied (e.g. a unit test
    // rendering the builtin body in isolation). Neutral placeholder — never an
    // iframe without a manifest.
    return html`<div class="workspace-widget__placeholder">
      ${t("workspaces.widget.customPlaceholder")}
    </div>`;
  }
  return html`<div class="workspace-widget__placeholder">
    ${t("workspaces.widget.unknownKind", { kind: widget.kind })}
  </div>`;
}

/**
 * Renders a `custom:<name>` widget (L5). The registry status is the render gate,
 * mirroring the server's approved-only serving gate:
 * - `approved` → the sandboxed iframe host (only path that ever builds an iframe).
 * - `pending`  → a placeholder card with operator-only Approve/Reject.
 * - `rejected` / unknown → a neutral placeholder; NO iframe is constructed.
 */
function renderCustomWidget(
  widget: WorkspaceWidget,
  custom: WorkspaceCustomWidgetContext,
): TemplateResult {
  if (custom.status === "approved") {
    if (!custom.manifest) {
      // Approved but the manifest has not loaded yet: hold the cell without an
      // iframe until the manifest resolves (the parent re-renders on load).
      return html`<div
        class="workspace-widget__placeholder"
        data-test-id="workspace-custom-loading"
      >
        ${t("workspaces.widget.customLoading")}
      </div>`;
    }
    return renderCustomWidgetHost({
      widget,
      manifest: custom.manifest,
      context: custom.host,
    });
  }
  if (custom.status === "pending") {
    const author = workspaceAgentProvenance(custom.createdBy);
    return html`
      <div
        class="workspace-widget__approval"
        role="group"
        data-test-id="workspace-custom-pending"
        aria-label=${t("workspaces.widget.approval.title")}
      >
        <div class="workspace-widget__approval-title">${t("workspaces.widget.approval.title")}</div>
        <div class="workspace-widget__approval-sub">
          ${author
            ? t("workspaces.widget.approval.byAgent", { agent: author })
            : t("workspaces.widget.approval.byUnknown")}
        </div>
        <div class="workspace-widget__approval-actions">
          <button
            class="btn btn--small btn--primary"
            type="button"
            data-test-id="workspace-custom-approve"
            @click=${() => custom.onApprove(widget)}
          >
            ${t("workspaces.widget.approval.approve")}
          </button>
          <button
            class="btn btn--small"
            type="button"
            data-test-id="workspace-custom-reject"
            @click=${() => custom.onReject(widget)}
          >
            ${t("workspaces.widget.approval.reject")}
          </button>
        </div>
      </div>
    `;
  }
  return html`<div class="workspace-widget__placeholder" data-test-id="workspace-custom-rejected">
    ${t("workspaces.widget.approval.unavailable")}
  </div>`;
}

/**
 * Error boundary around the widget body. Any throw during the builtin render (a
 * broken widget, a bad binding) is caught and rendered as an error card in THIS
 * cell — siblings and the shell keep rendering (spec-30 acceptance criterion).
 */
function renderWidgetBody(
  widget: WorkspaceWidget,
  binding: WorkspaceBindingResult | null,
  ctx: BuiltinWidgetContext,
  callbacks: WorkspaceWidgetCellCallbacks,
  custom?: WorkspaceCustomWidgetContext,
): TemplateResult {
  try {
    // Builtins render eagerly inside this try. Custom widgets mount through a Lit
    // directive whose render runs at commit time — outside this catch — so it
    // carries its own boundary (`CustomWidgetFrameDirective.render`).
    if (widget.kind.startsWith("custom:") && custom) {
      return renderCustomWidget(widget, custom);
    }
    return renderBuiltinWidget(widget, binding, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return html`
      <div class="workspace-widget__error" role="alert" data-test-id="workspace-widget-error">
        <div class="workspace-widget__error-title">${t("workspaces.widget.errorTitle")}</div>
        <div class="workspace-widget__error-humane">${t("workspaces.widget.errorHumane")}</div>
        <details class="workspace-widget__error-detail">
          <summary>${t("workspaces.widget.errorDetailSummary")}</summary>
          <div class="workspace-widget__error-message">${message}</div>
        </details>
        <button class="btn btn--small" type="button" @click=${() => callbacks.onRemove(widget)}>
          ${t("workspaces.widget.menu.remove")}
        </button>
      </div>
    `;
  }
}

export function renderWidgetCell(props: WorkspaceWidgetCellProps): TemplateResult {
  const { widget, callbacks } = props;
  const classes = [
    "workspace-widget",
    widget.collapsed ? "workspace-widget--collapsed" : "",
    props.pending ? "workspace-widget--pending" : "",
    props.dragging ? "workspace-widget--dragging" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <section
      class=${classes}
      style=${gridPlacementStyle(widget.grid)}
      data-widget-id=${widget.id}
      data-test-id="workspace-widget"
    >
      <header
        class="workspace-widget__bar"
        @pointerdown=${(event: PointerEvent) => callbacks.onMovePointerDown(widget, event)}
      >
        <button
          class="workspace-widget__collapse"
          type="button"
          aria-expanded=${widget.collapsed ? "false" : "true"}
          aria-label=${widget.collapsed
            ? t("workspaces.widget.expand")
            : t("workspaces.widget.collapse")}
          @pointerdown=${(event: PointerEvent) => event.stopPropagation()}
          @click=${() => callbacks.onToggleCollapse(widget)}
        >
          ${widget.collapsed ? icons.chevronRight : icons.chevronDown}
        </button>
        <span class="workspace-widget__title" title=${widget.title}
          >${displayWidgetTitle(widget.title)}</span
        >
        ${renderProvenanceChip(widget)}
        <span
          class="workspace-widget__handle"
          role="button"
          tabindex="0"
          aria-label=${t("workspaces.widget.moveHandle")}
          @keydown=${(event: KeyboardEvent) => handleNudgeKey(event, widget, "move", callbacks)}
          >${icons.arrowUpDown}</span
        >
        <wa-dropdown
          class="workspace-widget__menu"
          placement="bottom-end"
          .open=${props.menuOpen}
          @pointerdown=${(event: PointerEvent) => event.stopPropagation()}
          @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
            switch (event.detail.item.value) {
              case "edit-title":
                callbacks.onEditTitle(widget);
                break;
              case "move-to-tab":
                callbacks.onMoveToTab(widget);
                break;
              case "hide":
                callbacks.onHide(widget);
                break;
              case "remove":
                callbacks.onRemove(widget);
                break;
              case undefined:
                break;
            }
          }}
          @wa-show=${() => {
            if (!props.menuOpen) {
              callbacks.onToggleMenu(widget);
            }
          }}
          @wa-hide=${() => {
            if (props.menuOpen) {
              callbacks.onCloseMenu(widget);
            }
          }}
        >
          <button
            slot="trigger"
            class="workspace-widget__menu-toggle"
            type="button"
            aria-label=${t("workspaces.widget.menuLabel")}
          >
            ${icons.moreHorizontal}
          </button>
          ${renderMenu()}
        </wa-dropdown>
      </header>
      ${widget.collapsed
        ? nothing
        : html`
            <div class="workspace-widget__body">
              ${renderWidgetBody(
                widget,
                props.binding,
                props.builtinContext,
                callbacks,
                props.custom,
              )}
            </div>
            <span
              class="workspace-widget__resize"
              role="button"
              tabindex="0"
              aria-label=${t("workspaces.widget.resizeHandle")}
              @pointerdown=${(event: PointerEvent) => callbacks.onResizePointerDown(widget, event)}
              @keydown=${(event: KeyboardEvent) =>
                handleNudgeKey(event, widget, "resize", callbacks)}
            ></span>
          `}
    </section>
  `;
}

/** Keyboard fallback for move/resize (a11y): arrow keys nudge by one grid unit. */
function handleNudgeKey(
  event: KeyboardEvent,
  widget: WorkspaceWidget,
  mode: "move" | "resize",
  callbacks: WorkspaceWidgetCellCallbacks,
): void {
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
  callbacks.onKeyboardNudge(widget, mode, direction);
}
