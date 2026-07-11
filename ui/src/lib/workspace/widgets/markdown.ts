// builtin:markdown — renders a markdown body from a `content` binding (file /
// static) or `props.markdown` / `props.text`. Reuses the repo's sanitizing
// markdown util so the same allowlist/sanitizer governs workspace and chat.

import { html, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import type { WorkspaceWidget } from "../types.ts";
import { widgetProps } from "./types.ts";

export function mapMarkdownSource(widget: WorkspaceWidget, value: unknown): string {
  const props = widgetProps(widget);
  if (typeof value === "string") {
    return value;
  }
  if (typeof props.markdown === "string") {
    return props.markdown;
  }
  if (typeof props.text === "string") {
    return props.text;
  }
  return "";
}

export function renderMarkdown(widget: WorkspaceWidget, value: unknown): TemplateResult {
  const source = mapMarkdownSource(widget, value);
  if (!source.trim()) {
    return html`<div class="workspace-widget__placeholder">
      ${t("workspaces.widget.markdownEmpty")}
    </div>`;
  }
  return html`<div class="workspace-markdown markdown-body">
    ${unsafeHTML(toSanitizedMarkdownHtml(source))}
  </div>`;
}
