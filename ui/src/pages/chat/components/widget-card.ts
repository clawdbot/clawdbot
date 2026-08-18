import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { ensureCustomElementDefined } from "../../../app/lazy-custom-element.ts";
import { icons } from "../../../components/icons.ts";
import {
  dispatchWidgetPrompt,
  WIDGET_PROMPT_EVENT,
  type WidgetPromptEventDetail,
} from "../../../components/mcp-app-security.ts";
import "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import {
  canvasWidgetNameForDocument,
  mcpAppWidgetNameForViewId,
  type BoardProvider,
} from "../../../lib/board/provider.ts";
import { getCanvasWidgetFrameConnectionGeneration } from "../../../lib/chat/canvas-widget-frame-generation.ts";
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
  boardProvider?: BoardProvider;
};

async function pinWidget(event: Event, pin: () => Promise<void>): Promise<void> {
  const button = event.currentTarget;
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  button.disabled = true;
  const pendingLabel = t("chat.toolCards.pinToDashboardPending");
  button.title = button.ariaLabel = pendingLabel;
  try {
    await pin();
    const pinnedLabel = t("chat.toolCards.pinnedToDashboard");
    button.title = button.ariaLabel = pinnedLabel;
    button.dataset.pinned = "true";
  } catch {
    button.disabled = false;
    button.ariaLabel = t("chat.toolCards.pinToDashboard");
    const failureLabel = t("chat.toolCards.pinToDashboardFailed");
    button.title = failureLabel;
    showToast({ message: failureLabel });
  }
}

async function pinCanvasWidget(
  event: Event,
  preview: ToolPreview,
  provider: BoardProvider,
  name: string,
): Promise<void> {
  const docId = preview.viewId?.trim();
  if (!docId) {
    return;
  }
  return pinWidget(event, () =>
    provider.pinWidget({
      docId,
      name,
      ...(preview.title?.trim() ? { title: preview.title.trim() } : {}),
    }),
  );
}

async function pinMcpAppWidget(
  event: Event,
  preview: ToolPreview,
  provider: BoardProvider,
  name: string,
  viewId: string,
): Promise<void> {
  return pinWidget(event, () =>
    provider.pinMcpApp({
      viewId,
      name,
      ...(preview.title?.trim() ? { title: preview.title.trim() } : {}),
    }),
  );
}

function canvasWidgetName(preview: ToolPreview): string | undefined {
  if (preview.boardWidgetName) {
    return preview.boardWidgetName;
  }
  const viewId = preview.viewId?.trim();
  return viewId ? canvasWidgetNameForDocument(viewId) : undefined;
}

function isManagedCanvasDocumentPreview(preview: ToolPreview): boolean {
  const viewId = preview.viewId?.trim();
  const entryUrl = preview.url?.trim();
  if (!viewId || !entryUrl) {
    return false;
  }
  try {
    const entry = new URL(entryUrl, "http://localhost");
    const prefix = "/__openclaw__/canvas/documents/";
    if (entry.origin !== "http://localhost" || !entry.pathname.startsWith(prefix)) {
      return false;
    }
    const [encodedDocumentId, entrypoint] = entry.pathname.slice(prefix.length).split("/", 2);
    if (!encodedDocumentId || !entrypoint) {
      return false;
    }
    const documentId = decodeURIComponent(encodedDocumentId);
    return /^[A-Za-z0-9._-]+$/u.test(documentId) && documentId === viewId;
  } catch {
    return false;
  }
}

// Sandboxed widget documents report their content height via postMessage so the
// preview iframe can fit short/tall widgets. The event source must be one of our
// preview frames and the height is clamped, so widget code can only resize its
// own frame within the same bounds the preview contract allows.
const WIDGET_SIZE_MESSAGE_TYPE = "openclaw:widget-size";
const WIDGET_PROMPT_OFFER_MESSAGE_TYPE = "openclaw:widget-prompt-offer";
const WIDGET_PROMPT_MESSAGE_TYPE = "openclaw:widget-prompt";
const WIDGET_PROMPT_HOST_READY_MESSAGE_TYPE = "openclaw:widget-prompt-host-ready";
const WIDGET_CHAT_HOST_MESSAGE_TYPE = "openclaw:widget-chat-host";
const WIDGET_FRAME_MIN_HEIGHT = 48;
const WIDGET_FRAME_MAX_HEIGHT = 1200;
// Preview frames render inside lit shadow roots, so a document query cannot
// find them; frames register themselves on load and are dropped once detached.
const widgetFrameRegistry = new Set<HTMLIFrameElement>();
// Reported heights keyed by the frame's stable identity, NOT its src: lit
// re-renders re-apply the style binding, so the template must read the reported
// height back or it resets. A capability rotation changes the src while the
// frame stays mounted, and the in-frame reporter only posts on height change —
// keying by src would strand the frame at its default height until its content
// happened to resize.
const widgetFrameHeightsByKey = new Map<string, number>();
const WIDGET_FRAME_HEIGHT_KEY_ATTRIBUTE = "data-frame-key";
const WIDGET_FRAME_HEIGHTS_MAX_ENTRIES = 100;
// Keyed by window, not a module boolean: non-isolated test workers swap the
// global window between files while module state persists.
const widgetSizeListenerWindows = new WeakSet<Window>();

function rememberWidgetFrameHeight(key: string, height: number) {
  if (
    !widgetFrameHeightsByKey.has(key) &&
    widgetFrameHeightsByKey.size >= WIDGET_FRAME_HEIGHTS_MAX_ENTRIES
  ) {
    const oldest = widgetFrameHeightsByKey.keys().next().value;
    if (oldest !== undefined) {
      widgetFrameHeightsByKey.delete(oldest);
    }
  }
  widgetFrameHeightsByKey.set(key, height);
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
  const source = frame.contentWindow;
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
  // The wrapper waits for this trusted adoption signal before using the
  // legacy inline channel, so board widgets can wait for their view ticket.
  port.postMessage({ type: WIDGET_PROMPT_HOST_READY_MESSAGE_TYPE });
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
    if (offeredWidgetPromptSources.has(source)) {
      // Only the first offer per content window can win; a replacement
      // document's offer must never displace the genuine bridge's.
      port.close();
      return;
    }
    offeredWidgetPromptSources.add(source);
    pendingWidgetPromptPorts.set(source, port);
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
        const key =
          frame.getAttribute(WIDGET_FRAME_HEIGHT_KEY_ATTRIBUTE) ?? frame.getAttribute("src");
        if (key) {
          rememberWidgetFrameHeight(key, height);
        }
        return;
      }
    }
  });
}

function renderPreviewFrame(params: {
  title: string;
  src?: string;
  frameKey?: string;
  connectionGeneration?: number;
  height?: number;
  sandbox?: string;
  promptCapable?: boolean;
}) {
  installWidgetSizeListener();
  installWidgetThemeObserver(() => widgetFrameRegistry);
  const sandbox = params.sandbox ?? "";
  const src = params.src ?? "";
  const heightKey = params.frameKey || src;
  const reportedHeight = heightKey ? widgetFrameHeightsByKey.get(heightKey) : undefined;
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
      frame.contentWindow?.postMessage({ type: WIDGET_CHAT_HOST_MESSAGE_TYPE }, "*");
    }
  };
  return keyed(
    `${sandbox}\u0000${params.frameKey ?? ""}\u0000${src ? 1 : 0}\u0000${params.connectionGeneration ?? 0}\u0000${params.height ?? ""}`,
    html`
      <iframe
        ${ref((element) => {
          if (!(element instanceof HTMLIFrameElement)) {
            return;
          }
          if (heightKey) {
            element.setAttribute(WIDGET_FRAME_HEIGHT_KEY_ATTRIBUTE, heightKey);
          }
          // Assign the capability URL once per element: a rotation must not
          // reload a mounted widget, while a fresh element always gets the
          // current lease URL.
          if (src && !element.hasAttribute("src")) {
            element.setAttribute("src", src);
          }
        })}
        class="chat-tool-card__preview-frame"
        title=${params.title}
        sandbox=${sandbox}
        style=${height ? `height:${height}px;min-height:${height}px` : ""}
        @load=${handleLoad}
      ></iframe>
    `,
  );
}

const loadMcpAppView = async () => {
  const registration = await import("../../../components/mcp-app-view-registration.ts");
  registration.registerMcpAppView();
};

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
    case "canvas-html": {
      const promptCapable = isInternalCanvasEntryUrl(preview.url);
      return renderPreviewFrame({
        title: preview.title?.trim() || t("chat.toolCards.canvas"),
        src: resolveCanvasIframeUrl(
          preview.url,
          options?.canvasPluginSurfaceUrl,
          options?.allowExternalEmbedUrls ?? false,
        ),
        frameKey: preview.url?.trim() || preview.viewId?.trim(),
        connectionGeneration: promptCapable
          ? getCanvasWidgetFrameConnectionGeneration()
          : undefined,
        height: preview.preferredHeight,
        sandbox: resolveEmbedSandbox(options?.embedSandboxMode ?? "scripts", preview.sandbox),
        // Only hosted Canvas documents may drive the chat; externally
        // allowed embed URLs render but never get prompt authority.
        promptCapable,
      });
    }
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
  if (value === "raw-details") {
    const dropdown = event.currentTarget;
    const host =
      dropdown instanceof HTMLElement ? dropdown.closest(".chat-tool-card__widget-host") : null;
    const toggle = host?.querySelector<HTMLButtonElement>(
      ".chat-tool-card__widget-raw .chat-tool-card__raw-toggle",
    );
    toggle?.click();
    const label = dropdown instanceof HTMLElement ? dropdown.querySelector("[data-raw-label]") : null;
    label?.replaceChildren(
      t(
        toggle && toggle.getAttribute("aria-expanded") === "true"
          ? "chat.toolCards.hideRawDetails"
          : "chat.toolCards.showRawDetails",
      ),
    );
    return;
  }
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
      } else if (value === "copy") {
        showToast({ message: t("common.copied") });
      }
    })
    .catch(() => {
      showToast({ message: t("chat.toolCards.widgetExportFailed") });
    });
}

function renderWidgetActions(preview: ToolPreview, hasRawDetails: boolean) {
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
      <wa-dropdown-item class="session-menu__item" value="copy">
        <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.copyImage}</span>
        <span class="session-menu__text">${t("chat.toolCards.copyAsImage")}</span>
      </wa-dropdown-item>
      <wa-dropdown-item class="session-menu__item" value="download">
        <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.download}</span>
        <span class="session-menu__text">${t("chat.toolCards.downloadAsImage")}</span>
      </wa-dropdown-item>
      ${hasRawDetails
        ? html`<wa-dropdown-item class="session-menu__item" value="raw-details">
            <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.fileText}</span>
            <span class="session-menu__text" data-raw-label
              >${t("chat.toolCards.showRawDetails")}</span
            >
          </wa-dropdown-item>`
        : nothing}
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
  const contentKind = preview.mcpApp ? "mcp-app" : "canvas-html";
  const provider = options?.boardProvider;
  const mcpAppViewId = preview.mcpApp?.viewId?.trim();
  const pinName = preview.mcpApp
    ? mcpAppViewId
      ? mcpAppWidgetNameForViewId(mcpAppViewId)
      : undefined
    : canvasWidgetName(preview);
  const pinnedWidget = pinName
    ? provider?.snapshot$.value.widgets.find((widget) => widget.name === pinName)
    : undefined;
  const pinned = Boolean(pinnedWidget);
  const pinLabel = t(pinned ? "chat.toolCards.pinnedToDashboard" : "chat.toolCards.pinToDashboard");
  const pinAction =
    provider &&
    (contentKind === "mcp-app" ? provider.canPinMcpApps : provider.canPinWidgets) &&
    pinName &&
    ((contentKind === "canvas-html" &&
      preview.sandbox === "scripts" &&
      isManagedCanvasDocumentPreview(preview)) ||
      (contentKind === "mcp-app" && mcpAppViewId))
      ? html`<button
          class="btn btn--ghost btn--icon chat-tool-card__widget-action"
          type="button"
          data-pin-widget
          ?disabled=${pinned}
          ?data-pinned=${pinned}
          title=${pinLabel}
          aria-label=${pinLabel}
          @click=${(event: Event) =>
            contentKind === "mcp-app" && mcpAppViewId
              ? void pinMcpAppWidget(event, preview, provider, pinName, mcpAppViewId)
              : void pinCanvasWidget(event, preview, provider, pinName)}
        >
          ${icons.pin}
        </button>`
      : nothing;
  const widgetActions = renderWidgetActions(preview, Boolean(options?.rawText));
  const actions =
    pinAction === nothing && widgetActions === nothing
      ? nothing
      : html`<div class="chat-tool-card__preview-actions" data-widget-actions>
          ${pinAction} ${widgetActions}
        </div>`;
  return html`
    <div
      class="chat-tool-card__preview"
      data-content-kind=${contentKind}
      ?data-has-widget-actions=${actions !== nothing}
      data-kind="canvas"
      data-surface=${surface}
    >
      ${actions}
      <div class="chat-tool-card__preview-panel" data-side="canvas">
        ${renderWidgetContent(contentKind, preview, options)}
      </div>
    </div>
  `;
}

export const renderToolPreview = renderWidgetCard;
