// builtin:preview — an agent-authored live URL with reload and viewport controls.
// It deliberately shares iframe-embed's URL gate and sandbox ceiling: even an
// operator-trusted chat embed must not grant this builtin same-origin access.

import { html, type TemplateResult } from "lit";
import { createRef } from "lit/directives/ref.js";
import { t } from "../../../i18n/index.ts";
import type { WorkspaceWidget } from "../types.ts";
import { evaluateEmbedUrl, renderWorkspaceEmbedFrame } from "./iframe-embed.ts";
import type { BuiltinWidgetContext, PreviewViewport } from "./types.ts";
import { widgetProps } from "./types.ts";

const PREVIEW_VIEWPORTS: readonly PreviewViewport[] = ["desktop", "tablet", "mobile"];

function mapPreviewViewport(widget: WorkspaceWidget): PreviewViewport {
  const raw = widgetProps(widget).defaultViewport;
  return raw === "tablet" || raw === "mobile" ? raw : "desktop";
}

function viewportClass(viewport: PreviewViewport): string {
  return `workspace-preview__frame-wrap workspace-preview__frame-wrap--${viewport}`;
}

export function renderPreview(
  widget: WorkspaceWidget,
  value: unknown,
  ctx: BuiltinWidgetContext,
): TemplateResult {
  // A declared primary binding owns the preview URL, including malformed
  // values. Falling back to props would hide broken or hostile binding data.
  const hasBinding = Object.hasOwn(widget.bindings ?? {}, "value");
  const rawUrl = hasBinding ? value : widgetProps(widget).url;
  const decision = evaluateEmbedUrl(rawUrl, {
    allowExternalEmbedUrls: ctx.embed.allowExternalEmbedUrls,
  });
  if (decision.status === "missing") {
    return html`<div class="workspace-widget__placeholder">
      ${t("workspaces.widget.preview.missing")}
    </div>`;
  }
  if (decision.status === "blocked") {
    return html`<div class="workspace-widget__placeholder" data-test-id="workspace-preview-blocked">
      ${decision.reason === "external"
        ? t("workspaces.widget.preview.blockedExternal")
        : t("workspaces.widget.preview.blockedScheme")}
    </div>`;
  }

  const selectedViewport = ctx.preview.getViewport(widget.id, mapPreviewViewport(widget));
  const frameRef = createRef<HTMLIFrameElement>();

  const reload = () => {
    const frame = frameRef.value;
    const src = frame?.getAttribute("src");
    if (frame && src !== null && src !== undefined) {
      frame.setAttribute("src", src);
    }
  };

  return html`<div class="workspace-preview">
    <div
      class="workspace-preview__toolbar"
      role="toolbar"
      aria-label=${t("workspaces.widget.preview.toolbar")}
    >
      <div
        class="workspace-preview__viewports"
        role="group"
        aria-label=${t("workspaces.widget.preview.viewport.label")}
      >
        ${PREVIEW_VIEWPORTS.map(
          (viewport) => html`<button
            class="workspace-preview__viewport"
            type="button"
            data-test-id=${`workspace-preview-viewport-${viewport}`}
            aria-label=${t(`workspaces.widget.preview.viewport.${viewport}`)}
            aria-pressed=${String(viewport === selectedViewport)}
            @click=${() => ctx.preview.setViewport(widget.id, viewport)}
          >
            ${t(`workspaces.widget.preview.viewport.${viewport}`)}
          </button>`,
        )}
      </div>
      <button
        class="workspace-preview__reload"
        type="button"
        data-test-id="workspace-preview-reload"
        aria-label=${t("workspaces.widget.preview.reload")}
        @click=${reload}
      >
        ${t("workspaces.widget.preview.reload")}
      </button>
    </div>
    <div class=${viewportClass(selectedViewport)}>
      ${renderWorkspaceEmbedFrame({
        widget,
        url: decision.url,
        ctx,
        className: "workspace-embed__frame workspace-preview__frame",
        testId: "workspace-preview-frame",
        frameRef,
      })}
    </div>
  </div>`;
}
