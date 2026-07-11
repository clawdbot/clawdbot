// builtin:iframe-embed — an embedded URL (dev-server preview, hosted report).
//
// `props.url` is authored by whoever added the widget, which includes an agent —
// and a builtin needs no approval. So this embed is capped at the `"scripts"`
// sandbox ceiling: `embedSandboxMode: "trusted"` grants `allow-same-origin` for
// chat embeds, and a same-origin scripted frame pointed at the Control UI could
// read the parent's storage and script it. The chat path avoids this by allowing
// same-origin only for canvas host paths (`sanitizeCanvasEntryUrl`); here the
// ceiling does the same job without a path allowlist.
// External http(s) URLs stay blocked unless `config.allowExternalEmbedUrls`.

import { html, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import { resolveEmbedSandbox } from "../../chat/tool-display.ts";
import type { WorkspaceWidget } from "../types.ts";
import type { BuiltinWidgetContext } from "./types.ts";
import { widgetProps } from "./types.ts";

/**
 * Hard cap on the embed sandbox. `allow-same-origin` is never granted, whatever
 * the operator configured for chat embeds — see the module comment.
 */
const EMBED_SANDBOX_CEILING = "scripts" as const;

export type EmbedUrlDecision =
  | { status: "missing" }
  | { status: "blocked"; reason: "external" | "scheme"; url: string }
  | { status: "ok"; url: string; external: boolean };

/**
 * Resolve `props.url` against the embed policy. Relative URLs and same-origin
 * absolute URLs are internal and always allowed. Absolute http(s) URLs to a
 * different origin are external and require `allowExternalEmbedUrls`. Any other
 * scheme (javascript:, data:, file:, …) is rejected outright.
 */
export function evaluateEmbedUrl(
  rawUrl: unknown,
  policy: { allowExternalEmbedUrls: boolean },
  origin?: string,
): EmbedUrlDecision {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return { status: "missing" };
  }
  const url = rawUrl.trim();
  const base = origin ?? (typeof window !== "undefined" ? window.location.origin : undefined);
  let parsed: URL;
  try {
    // A relative URL resolves against the current origin; an absolute URL keeps
    // its own. Without a base, relative URLs cannot be classified — treat as
    // internal (they cannot escape the current document).
    parsed = base ? new URL(url, base) : new URL(url);
  } catch {
    // Relative URL with no base to resolve against: internal by construction.
    return { status: "ok", url, external: false };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { status: "blocked", reason: "scheme", url };
  }
  const external = base ? parsed.origin !== new URL(base).origin : true;
  if (external && !policy.allowExternalEmbedUrls) {
    return { status: "blocked", reason: "external", url };
  }
  return { status: "ok", url, external };
}

export function renderIframeEmbed(
  widget: WorkspaceWidget,
  _value: unknown,
  ctx: BuiltinWidgetContext,
): TemplateResult {
  const decision = evaluateEmbedUrl(widgetProps(widget).url, {
    allowExternalEmbedUrls: ctx.embed.allowExternalEmbedUrls,
  });
  if (decision.status === "missing") {
    return html`<div class="workspace-widget__placeholder">
      ${t("workspaces.widget.embed.missing")}
    </div>`;
  }
  if (decision.status === "blocked") {
    return html`<div class="workspace-widget__placeholder" data-test-id="workspace-embed-blocked">
      ${decision.reason === "external"
        ? t("workspaces.widget.embed.blockedExternal")
        : t("workspaces.widget.embed.blockedScheme")}
    </div>`;
  }
  return html`<iframe
    class="workspace-embed__frame"
    data-test-id="workspace-embed-frame"
    src=${decision.url}
    title=${widget.title}
    sandbox=${resolveEmbedSandbox(ctx.embed.embedSandboxMode, EMBED_SANDBOX_CEILING)}
    referrerpolicy="no-referrer"
    loading="lazy"
  ></iframe>`;
}
