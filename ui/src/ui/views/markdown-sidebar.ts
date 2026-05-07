import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { resolveCanvasIframeUrl } from "../canvas-url.ts";
import { resolveEmbedSandbox, type EmbedSandboxMode } from "../embed-sandbox.ts";
import { icons } from "../icons.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import type { SidebarContent } from "../sidebar-content.ts";

function resolveSidebarCanvasSandbox(
  content: SidebarContent,
  embedSandboxMode: EmbedSandboxMode,
): string {
  return content.kind === "canvas" ? resolveEmbedSandbox(embedSandboxMode) : "allow-scripts";
}

export type MarkdownSidebarProps = {
  content: SidebarContent | null;
  error: string | null;
  onClose: () => void;
  onViewRawText: () => void;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
};

export function renderMarkdownSidebar(props: MarkdownSidebarProps) {
  const content = props.content;
  return html`
    <div class="sidebar-panel">
      <div class="sidebar-header">
        <div class="sidebar-title">
          ${content?.kind === "canvas"
            ? content.title?.trim() || "Render Preview"
            : content?.kind === "markdown"
              ? "Markdown Preview"
              : "Tool Details"}
        </div>
        <button
          @click=${props.onClose}
          class="btn"
          type="button"
          title="Close sidebar"
          aria-label="Close sidebar"
        >
          ${icons.x}
        </button>
      </div>
      <div class="sidebar-content">
        ${props.error
          ? html`
              <div class="callout danger">${props.error}</div>
              <button
                @click=${props.onViewRawText}
                class="btn"
                type="button"
                style="margin-top: 12px;"
              >
                View Raw Text
              </button>
            `
          : content
            ? content.kind === "canvas"
              ? html`
                  <div class="chat-tool-card__preview" data-kind="canvas">
                    <div class="chat-tool-card__preview-panel" data-side="front">
                      <iframe
                        class="chat-tool-card__preview-frame"
                        title=${content.title?.trim() || "Render preview"}
                        sandbox=${resolveSidebarCanvasSandbox(
                          content,
                          props.embedSandboxMode ?? "scripts",
                        )}
                        src=${resolveCanvasIframeUrl(
                          content.entryUrl,
                          props.canvasPluginSurfaceUrl,
                          props.allowExternalEmbedUrls ?? false,
                        ) ?? nothing}
                        style=${content.preferredHeight
                          ? `height:${content.preferredHeight}px`
                          : ""}
                      ></iframe>
                    </div>
                    ${content.rawText?.trim()
                      ? html`
                          <div style="margin-top: 12px;">
                            <button @click=${props.onViewRawText} class="btn" type="button">
                              View Raw Text
                            </button>
                          </div>
                        `
                      : nothing}
                  </div>
                `
              : html`
                  <section class="sidebar-markdown-shell">
                    <div class="sidebar-markdown-shell__toolbar">
                      <div class="sidebar-markdown-shell__intro">
                        <div class="sidebar-markdown-shell__eyebrow">
                          ${icons.scrollText}
                          <span>Rendered Markdown</span>
                        </div>
                        <div class="sidebar-markdown-shell__hint">
                          Sanitized rich-text preview for quick reading.
                        </div>
                      </div>
                      <button @click=${props.onViewRawText} class="btn btn--sm" type="button">
                        View Raw Text
                      </button>
                    </div>
                    <article class="sidebar-markdown-reader sidebar-markdown">
                      ${unsafeHTML(toSanitizedMarkdownHtml(content.content))}
                    </article>
                  </section>
                `
            : html` <div class="muted">No content available</div> `}
      </div>
    </div>
  `;
}
