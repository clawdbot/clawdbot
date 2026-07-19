import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { ensureCustomElementDefined } from "../../../app/lazy-custom-element.ts";
import { icons } from "../../../components/icons.ts";
import {
  dispatchWidgetPrompt,
  WIDGET_PROMPT_EVENT,
  type WidgetPromptEventDetail,
} from "../../../components/mcp-app-security.ts";
import "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import type { ToolPreview } from "../../../lib/chat/tool-cards.ts";
import {
  isInternalCanvasEntryUrl,
  resolveCanvasIframeUrl,
  resolveEmbedSandbox,
  type EmbedSandboxMode,
} from "../../../lib/chat/tool-display.ts";
import { showToast } from "../../../lib/toast.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import { exportWidget } from "./widget-export.ts";
import { installWidgetThemeObserver, postWidgetTheme } from "./widget-theme.ts";

export { WIDGET_PROMPT_EVENT };
export type { WidgetPromptEventDetail };

type WidgetCardOptions = {
  onOpenSidebar?: (content: SidebarContent) => void;
  rawText?: string | null;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  sessionKey?: string;
};

// Sandboxed widget documents report their content height via postMessage so the
// preview iframe can fit short/tall widgets. The event source must be one of our
// preview frames and the height is clamped, so widget code can only resize its
// own frame within the same bounds the preview contract allows.
const WIDGET_SIZE_MESSAGE_TYPE = "openclaw:widget-size";
const WIDGET_PROMPT_OFFER_MESSAGE_TYPE = "openclaw:widget-prompt-offer";
const WIDGET_PROMPT_MESSAGE_TYPE = "openclaw:widget-prompt";
const WIDGET_FRAME_MIN_HEIGHT = 160;
const WIDGET_FRAME_MAX_HEIGHT = 1200;
// Preview frames render inside lit shadow roots, so a document query cannot
// find them; frames register themselves on load and are dropped once detached.
const widgetFrameRegistry = new Set<HTMLIFrameElement>();
// Reported heights keyed by frame src: lit re-renders re-apply the style
// binding, so the template must read the reported height back or it resets.
const widgetFrameHeightsBySrc = new Map<string, number>();
const WIDGET_FRAME_HEIGHTS_MAX_ENTRIES = 100;
// Keyed by window, not a module boolean: non-isolated test workers swap the
// global window between files while module state persists.
const widgetSizeListenerWindows = new WeakSet<Window>();

function rememberWidgetFrameHeight(src: string, height: number) {
  if (
    !widgetFrameHeightsBySrc.has(src) &&
    widgetFrameHeightsBySrc.size >= WIDGET_FRAME_HEIGHTS_MAX_ENTRIES
  ) {
    const oldest = widgetFrameHeightsBySrc.keys().next().value;
    if (oldest !== undefined) {
      widgetFrameHeightsBySrc.delete(oldest);
    }
  }
  widgetFrameHeightsBySrc.set(src, height);
}

function registerWidgetFrame(event: Event) {
  const frame = event.currentTarget;
  if (frame instanceof HTMLIFrameElement) {
    widgetFrameRegistry.add(frame);
  }
}

function handleWidgetPromptMessage(frame: HTMLIFrameElement, data: unknown) {
  const payload = data as { type?: unknown; prompt?: unknown } | null;
  if (!payload || payload.type !== WIDGET_PROMPT_MESSAGE_TYPE) {
    return;
  }
  dispatchWidgetPrompt(frame, payload.prompt, frame.getAttribute("src") ?? "");
}

// Prompt authority is a MessagePort OFFERED by the trusted bridge script that
// wraps every hosted widget document. The bridge posts its offer at document
// parse time — before any widget code can run, steal the endpoint, or navigate
// the frame — so buffering only the FIRST offer per content window and adopting
// it once, at the frame's first load, binds the capability to the genuine
// widget document. A document that navigates away closes its ports with it,
// externally allowed embed URLs are never adopted, and later offers or loads
// cannot re-arm a consumed frame.
const pendingWidgetPromptPorts = new WeakMap<object, MessagePort>();
const offeredWidgetPromptSources = new WeakSet<object>();
const promptEligibleFrames = new WeakSet<HTMLIFrameElement>();
const adoptedWidgetPromptFrames = new WeakSet<HTMLIFrameElement>();
// Keyed by window, not a module boolean: non-isolated test workers swap the
// global window between files while module state persists.
const widgetPromptOfferListenerWindows = new WeakSet<Window>();

function tryAdoptWidgetPromptPort(frame: HTMLIFrameElement) {
  const source = frame.contentWindow as unknown as object | null;
  if (adoptedWidgetPromptFrames.has(frame) || !promptEligibleFrames.has(frame) || !source) {
    return;
  }
  const port = pendingWidgetPromptPorts.get(source);
  if (!port) {
    return;
  }
  adoptedWidgetPromptFrames.add(frame);
  pendingWidgetPromptPorts.delete(source);
  port.addEventListener("message", (message: MessageEvent) => {
    handleWidgetPromptMessage(frame, message.data);
  });
  port.start();
}

function installWidgetPromptOfferListener() {
  if (typeof window === "undefined" || widgetPromptOfferListenerWindows.has(window)) {
    return;
  }
  widgetPromptOfferListenerWindows.add(window);
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: unknown } | null;
    if (!data || data.type !== WIDGET_PROMPT_OFFER_MESSAGE_TYPE) {
      return;
    }
    const source = event.source;
    const port = event.ports[0];
    // Hosted widget documents run in an opaque origin; anything else is not a
    // Canvas widget bridge.
    if (!source || !port || event.origin !== "null") {
      return;
    }
    if (offeredWidgetPromptSources.has(source as unknown as object)) {
      // Only the first offer per content window can win; a replacement
      // document's offer must never displace the genuine bridge's.
      port.close();
      return;
    }
    offeredWidgetPromptSources.add(source as unknown as object);
    pendingWidgetPromptPorts.set(source as unknown as object, port);
    // Posted-message and iframe-load tasks have no guaranteed cross-source
    // ordering, so the offer may arrive after the eligible frame's load;
    // adopt for it now instead of stranding the widget without a channel.
    for (const frame of widgetFrameRegistry) {
      if (frame.contentWindow === source) {
        tryAdoptWidgetPromptPort(frame);
        return;
      }
    }
  });
}

function adoptWidgetPromptPort(frame: HTMLIFrameElement) {
  // Eligibility is granted at the frame's first prompt-capable load and the
  // adoption itself is one-shot; first-offer-wins buffering ensures the port
  // adopted here always belongs to the frame's original bridge document.
  promptEligibleFrames.add(frame);
  tryAdoptWidgetPromptPort(frame);
}

function installWidgetSizeListener() {
  if (typeof window === "undefined" || widgetSizeListenerWindows.has(window)) {
    return;
  }
  widgetSizeListenerWindows.add(window);
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: unknown; height?: unknown } | null;
    if (!data || data.type !== WIDGET_SIZE_MESSAGE_TYPE || typeof data.height !== "number") {
      return;
    }
    for (const frame of widgetFrameRegistry) {
      if (!frame.isConnected) {
        widgetFrameRegistry.delete(frame);
        continue;
      }
      if (frame.contentWindow === event.source) {
        const height = Math.min(
          Math.max(Math.trunc(data.height), WIDGET_FRAME_MIN_HEIGHT),
          WIDGET_FRAME_MAX_HEIGHT,
        );
        // The stylesheet floors the frame at min-height 420px; reported sizes
        // must override both properties to fit short widgets.
        frame.style.height = `${height}px`;
        frame.style.minHeight = `${height}px`;
        const src = frame.getAttribute("src");
        if (src) {
          rememberWidgetFrameHeight(src, height);
        }
        return;
      }
    }
  });
}

function renderPreviewFrame(params: {
  title: string;
  src?: string;
  height?: number;
  sandbox?: string;
  promptCapable?: boolean;
}) {
  installWidgetSizeListener();
  installWidgetThemeObserver(() => widgetFrameRegistry);
  const sandbox = params.sandbox ?? "";
  const src = params.src ?? "";
  const reportedHeight = src ? widgetFrameHeightsBySrc.get(src) : undefined;
  const height = reportedHeight ?? params.height;
  if (params.promptCapable) {
    installWidgetPromptOfferListener();
  }
  const handleLoad = (event: Event) => {
    registerWidgetFrame(event);
    if (event.currentTarget instanceof HTMLIFrameElement) {
      const frame = event.currentTarget;
      if (params.promptCapable) {
        adoptWidgetPromptPort(frame);
      }
      postWidgetTheme(frame);
    }
  };
  return keyed(
    `${sandbox}\u0000${src}\u0000${params.height ?? ""}`,
    html`
      <iframe
        class="chat-tool-card__preview-frame"
        title=${params.title}
        sandbox=${sandbox}
        src=${src || nothing}
        style=${height ? `height:${height}px;min-height:${height}px` : ""}
        @load=${handleLoad}
      ></iframe>
    `,
  );
}

const loadMcpAppView = () => import("../../../components/mcp-app-view-registration.ts");

function renderMcpAppView(params: {
  sessionKey: string;
  viewId: string;
  height: number;
  title: string;
}) {
  // Insert the tag before its chunk arrives. Native custom-element upgrade
  // preserves these bound fields, so the first preview initializes after registration.
  void ensureCustomElementDefined("mcp-app-view", loadMcpAppView).catch((error: unknown) => {
    console.error("[openclaw] failed to load MCP App view", error);
  });
  return html`<mcp-app-view
    .sessionKey=${params.sessionKey}
    .viewId=${params.viewId}
    .height=${params.height}
    .title=${params.title}
  ></mcp-app-view>`;
}

function renderWidgetContent(
  kind: "canvas-html" | "mcp-app",
  preview: ToolPreview,
  options?: WidgetCardOptions,
) {
  switch (kind) {
    case "canvas-html":
      return renderPreviewFrame({
        title: preview.title?.trim() || t("chat.toolCards.canvas"),
        src: resolveCanvasIframeUrl(
          preview.url,
          options?.canvasPluginSurfaceUrl,
          options?.allowExternalEmbedUrls ?? false,
        ),
        height: preview.preferredHeight,
        sandbox: resolveEmbedSandbox(options?.embedSandboxMode ?? "scripts", preview.sandbox),
        // Only hosted Canvas documents may drive the chat; externally
        // allowed embed URLs render but never get prompt authority.
        promptCapable: isInternalCanvasEntryUrl(preview.url),
      });
    case "mcp-app":
      return preview.mcpApp
        ? renderMcpAppView({
            sessionKey: options?.sessionKey ?? "",
            viewId: preview.mcpApp.viewId,
            height: preview.preferredHeight ?? 600,
            title: preview.title?.trim() || t("mcpApp.title"),
          })
        : nothing;
  }
  return nothing;
}

function handleWidgetExportAction(
  event: CustomEvent<{ item: { value?: string } }>,
  title: string | undefined,
) {
  const value = event.detail.item.value;
  if (value !== "copy" && value !== "download") {
    return;
  }
  const dropdown = event.currentTarget;
  const frame =
    dropdown instanceof HTMLElement
      ? dropdown
          .closest(".chat-tool-card__preview")
          ?.querySelector<HTMLIFrameElement>(".chat-tool-card__preview-frame")
      : null;
  if (!frame) {
    showToast({ message: t("chat.toolCards.widgetExportFailed") });
    return;
  }
  void exportWidget(value, frame, title)
    .then((result) => {
      if (result === "rerender-required") {
        showToast({ message: t("chat.toolCards.widgetExportRerender") });
      }
    })
    .catch(() => {
      showToast({ message: t("chat.toolCards.widgetExportFailed") });
    });
}

function renderWidgetActions(preview: ToolPreview) {
  if (preview.mcpApp || !isInternalCanvasEntryUrl(preview.url)) {
    return nothing;
  }
  return html`
    <wa-dropdown
      class="chat-tool-card__widget-actions"
      placement="bottom-end"
      aria-label=${t("chat.toolCards.widgetActions")}
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) =>
        handleWidgetExportAction(event, preview.title)}
    >
      <button
        slot="trigger"
        type="button"
        class="btn btn--ghost btn--icon chat-tool-card__widget-actions-trigger"
        aria-label=${t("chat.toolCards.widgetActions")}
        title=${t("chat.toolCards.widgetActions")}
      >
        ${icons.moreHorizontal}
      </button>
      <wa-dropdown-item value="copy">${t("chat.toolCards.copyToClipboard")}</wa-dropdown-item>
      <wa-dropdown-item value="download">${t("chat.toolCards.downloadFile")}</wa-dropdown-item>
    </wa-dropdown>
  `;
}

function renderWidgetCard(
  preview: ToolPreview | undefined,
  surface: "chat_tool" | "chat_message" | "sidebar",
  options?: WidgetCardOptions,
) {
  if (!preview) {
    return nothing;
  }
  if (
    preview.kind !== "canvas" ||
    surface === "chat_tool" ||
    (preview.mcpApp && surface !== "chat_message")
  ) {
    return nothing;
  }
  if (preview.surface !== "assistant_message") {
    return nothing;
  }
  const label = preview.title?.trim() || t("chat.toolCards.canvas");
  const contentKind = preview.mcpApp ? "mcp-app" : "canvas-html";
  return html`
    <div class="chat-tool-card__preview" data-kind="canvas" data-surface=${surface}>
      <div class="chat-tool-card__preview-header">
        <span class="chat-tool-card__preview-label">${label}</span>
        ${renderWidgetActions(preview)}
      </div>
      <div class="chat-tool-card__preview-panel" data-side="canvas">
        ${renderWidgetContent(contentKind, preview, options)}
      </div>
    </div>
  `;
}

export const renderToolPreview = renderWidgetCard;
