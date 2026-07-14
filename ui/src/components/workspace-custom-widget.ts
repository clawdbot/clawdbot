// Sandboxed host for approved custom widgets (spec-50 §UI side). Renders the
// `<iframe sandbox="allow-scripts">` and wires the parent side of the postMessage
// bridge (`lib/workspace/bridge.ts`).
//
// SECURITY INVARIANTS (each has a test — the review gate):
// - The sandbox attribute is the CONSTANT string "allow-scripts". Never config,
//   never `allow-same-origin`/`allow-forms`/`allow-popups`/`allow-top-navigation`.
//   The iframe's origin is therefore opaque (`null`).
// - `referrerpolicy="no-referrer"` — the frame leaks no referrer.
// - Window messages are accepted only for the one-time, token-bound MessagePort
//   bootstrap injected before approved widget bytes. All bridge traffic then uses
//   that document-owned port; navigation destroys it, while WindowProxy identity
//   would incorrectly survive.
// - Parent→child posts use targetOrigin "*" (opaque origin) and carry only static
//   workspace values / theme tokens the manifest entitles the widget to. Privileged
//   RPC/file data never enters agent-authored code: sandboxed children can navigate.

import { html, type TemplateResult } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { generateUUID } from "../lib/uuid.ts";
import {
  createWidgetBridge,
  type WidgetBridge,
  type WidgetOutboundMessage,
} from "../lib/workspace/bridge.ts";
import type {
  WorkspaceBinding,
  WorkspaceWidget,
  WorkspaceWidgetCapability,
  WidgetManifestView,
} from "../lib/workspace/types.ts";

// Theme tokens exposed to widgets so agent-authored UIs match the active theme
// (00 §7). Read from the document root's computed styles at getTheme time.
const WIDGET_THEME_TOKENS = [
  "--bg",
  "--card",
  "--card-foreground",
  "--text",
  "--muted",
  "--border",
  "--accent",
  "--accent-foreground",
  "--radius",
  "--radius-sm",
  "--font-sans",
  "--font-mono",
] as const;

export type CustomWidgetHostContext = {
  client: GatewayBrowserClient | null;
  /** Gateway HTTP base path (from the app context); "" for same-origin root. */
  basePath: string;
  /** Session key for prompt dispatch via chat.send. */
  sessionKey: string;
  /** Operator confirm dialog quoting the prompt text; resolves true to send. */
  confirmPrompt?: (text: string) => Promise<boolean> | boolean;
  /** Read theme tokens; defaults to computed styles of the document root. */
  readThemeTokens?: () => Record<string, string>;
};

/** Builds the served asset URL for a widget file under the plugin route. */
function widgetAssetUrl(basePath: string, frameToken: string, name: string, file: string): string {
  const base = basePath.replace(/\/+$/, "");
  const encodedToken = encodeURIComponent(frameToken);
  const encodedName = encodeURIComponent(name);
  const encodedFile = file
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/plugins/workspaces/widgets/${encodedToken}/${encodedName}/${encodedFile}`;
}

function readThemeTokensFromRoot(): Record<string, string> {
  const tokens: Record<string, string> = {};
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return tokens;
  }
  const styles = getComputedStyle(document.documentElement);
  for (const token of WIDGET_THEME_TOKENS) {
    const value = styles.getPropertyValue(token).trim();
    if (value) {
      tokens[token] = value;
    }
  }
  return tokens;
}

function primaryBindingByManifestId(
  widget: WorkspaceWidget,
  bindingId: string,
): WorkspaceBinding | null {
  const binding = widget.bindings?.[bindingId];
  return binding ?? null;
}

function parseManifestBinding(value: unknown): { id: string; binding: WorkspaceBinding } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || id === "__proto__" || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
    return null;
  }
  if (record.source === "static" && Object.hasOwn(record, "value")) {
    return { id, binding: { source: "static", value: record.value } };
  }
  return null;
}

/** Custom code may receive only static workspace values granted by its manifest. */
function bindingMatchesManifestGrant(binding: WorkspaceBinding, grant: WorkspaceBinding): boolean {
  return binding.source === "static" && grant.source === "static";
}

/** Fetches and shapes a widget's manifest into the bridge's read model. */
export async function loadWidgetManifestView(
  client: GatewayBrowserClient | null,
  name: string,
): Promise<WidgetManifestView | null> {
  if (!client) {
    return null;
  }
  try {
    const payload: unknown = await client.request("workspaces.widget.frame", { name });
    if (typeof payload !== "object" || payload === null) {
      return null;
    }
    const response = payload as Record<string, unknown>;
    const frameToken = response.frameToken;
    const frameExpiresAt = response.frameExpiresAt;
    const manifest = response.manifest;
    if (
      typeof frameToken !== "string" ||
      typeof frameExpiresAt !== "number" ||
      !Number.isFinite(frameExpiresAt) ||
      frameExpiresAt <= Date.now() ||
      typeof manifest !== "object" ||
      manifest === null
    ) {
      return null;
    }
    const record = manifest as Record<string, unknown>;
    const manifestBindings = Array.isArray(record.bindings) ? record.bindings : [];
    // A null-prototype record keeps every accepted manifest id as data.
    const bindings = Object.create(null) as Record<string, WorkspaceBinding>;
    for (const value of manifestBindings) {
      const parsedBinding = parseManifestBinding(value);
      if (!parsedBinding || Object.hasOwn(bindings, parsedBinding.id)) {
        return null;
      }
      bindings[parsedBinding.id] = parsedBinding.binding;
    }
    const capabilities = (Array.isArray(record.capabilities) ? record.capabilities : []).filter(
      (cap): cap is WorkspaceWidgetCapability => cap === "data:read" || cap === "prompt:send",
    );
    // The approval gate hashes the manifest's declared entrypoint. Loading a
    // different file would mount code the operator never approved.
    const entrypoint = typeof record.entrypoint === "string" ? record.entrypoint : "";
    if (!entrypoint) {
      return null;
    }
    return { name, frameToken, frameExpiresAt, entrypoint, bindings, capabilities };
  } catch {
    return null;
  }
}

/**
 * Wires the parent bridge for one iframe: manifest gating, binding resolution over
 * the trusted gateway client, theme tokens, and prompt dispatch. The returned
 * teardown removes the window listener and disposes the bridge.
 */
function attachWidgetBridge(params: {
  iframe: HTMLIFrameElement;
  widget: WorkspaceWidget;
  manifest: WidgetManifestView;
  context: CustomWidgetHostContext;
  bridgeToken: string;
}): () => void {
  // Workspaces has never shipped, so there are no released approved widgets on
  // the old WindowProxy transport to migrate. Keeping that transport here would
  // preserve the navigation capability this document-bound channel removes.
  const { iframe, widget, manifest, context, bridgeToken } = params;
  let bridge: WidgetBridge | null = null;
  let port: MessagePort | null = null;
  let disposed = false;

  const createBridge = (connectedPort: MessagePort): WidgetBridge =>
    createWidgetBridge({
      manifest,
      post: (message: WidgetOutboundMessage): void => connectedPort.postMessage(message, []),
      assertBindingAllowed: (bindingId) => {
        // Agent-authored frames can navigate themselves despite their sandbox/CSP.
        // Never place privileged RPC/file data in them; built-in widgets own those
        // bindings. Static values are already agent/operator-authored workspace data.
        const binding = primaryBindingByManifestId(widget, bindingId);
        const grant = manifest.bindings[bindingId];
        if (!binding || !grant || !bindingMatchesManifestGrant(binding, grant)) {
          return "binding_denied";
        }
        return null;
      },
      resolveBinding: async (bindingId) => {
        const binding = primaryBindingByManifestId(widget, bindingId);
        if (!binding) {
          throw new Error(`binding not configured: ${bindingId}`);
        }
        if (binding.source !== "static") {
          throw new Error(`binding not allowed: ${bindingId}`);
        }
        return binding.value;
      },
      resolveTheme: context.readThemeTokens ?? readThemeTokensFromRoot,
      confirmPrompt: async (text) => {
        if (context.confirmPrompt) {
          return await context.confirmPrompt(text);
        }
        return typeof window !== "undefined" ? window.confirm(text) : false;
      },
      sendPrompt: async (text) => {
        if (!context.client) {
          throw new Error("Not connected.");
        }
        await context.client.request("chat.send", {
          sessionKey: context.sessionKey,
          message: text,
          deliver: false,
          idempotencyKey: generateUUID(),
        });
      },
    });

  const onBootstrap = (event: MessageEvent): void => {
    if (
      disposed ||
      bridge ||
      event.source !== iframe.contentWindow ||
      event.ports.length !== 1 ||
      typeof event.data !== "object" ||
      event.data === null ||
      event.data.v !== 1 ||
      event.data.type !== "workspace:bridge:init" ||
      event.data.token !== bridgeToken
    ) {
      return;
    }
    window.removeEventListener("message", onBootstrap);
    port = event.ports[0] ?? null;
    if (!port) {
      return;
    }
    bridge = createBridge(port);
    port.addEventListener("message", (message) => bridge?.handleMessage(message.data));
    port.start();
  };
  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    window.removeEventListener("message", onBootstrap);
    port?.close();
    bridge?.dispose();
    port = null;
    bridge = null;
  };
  window.addEventListener("message", onBootstrap);
  return dispose;
}

/**
 * Lit directive that owns the iframe element's lifecycle: it constructs the
 * sandboxed iframe once, attaches the bridge, and tears both down on disconnect.
 * Using a directive (rather than re-rendering an `<iframe>` template) keeps the
 * frame from being recreated on every parent render, which would drop bridge
 * state and reload the widget.
 */
class CustomWidgetFrameDirective extends AsyncDirective {
  private iframe: HTMLIFrameElement | null = null;
  private detach: (() => void) | null = null;
  private key = "";

  render(params: {
    widget: WorkspaceWidget;
    manifest: WidgetManifestView;
    context: CustomWidgetHostContext;
  }): HTMLElement {
    const name = params.widget.kind.slice("custom:".length);
    const assetUrl = widgetAssetUrl(
      params.context.basePath,
      params.manifest.frameToken,
      name,
      params.manifest.entrypoint,
    );
    const nextKey = `${params.widget.id}::${assetUrl}`;
    if (this.iframe && this.key === nextKey) {
      return this.iframe;
    }
    this.detach?.();
    try {
      const iframe = document.createElement("iframe");
      // CONSTANT sandbox — do not templatize. Only script execution is granted.
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.setAttribute("referrerpolicy", "no-referrer");
      iframe.setAttribute("loading", "lazy");
      iframe.className = "workspace-widget__frame";
      iframe.title = params.widget.title;
      const bridgeToken = params.manifest.frameToken;
      iframe.src = assetUrl;
      iframe.setAttribute("data-test-id", "workspace-custom-widget-frame");
      this.detach = attachWidgetBridge({
        iframe,
        widget: params.widget,
        manifest: params.manifest,
        context: params.context,
        bridgeToken,
      });
      this.iframe = iframe;
      this.key = nextKey;
      return iframe;
    } catch (error) {
      // A directive's render runs at Lit COMMIT time, outside the try/catch in
      // `renderWidgetBody`. A throw here would escape the per-cell error boundary
      // and take down the whole tab, so the boundary has to exist here too.
      this.detach = null;
      this.iframe = null;
      this.key = "";
      const fallback = document.createElement("div");
      fallback.className = "workspace-widget__error";
      fallback.setAttribute("role", "alert");
      fallback.setAttribute("data-test-id", "workspace-custom-widget-error");
      fallback.textContent = error instanceof Error ? error.message : String(error);
      return fallback;
    }
  }

  override disconnected(): void {
    this.detach?.();
    this.detach = null;
    this.iframe = null;
    this.key = "";
  }
}

const customWidgetFrame = directive(CustomWidgetFrameDirective);

/** Renders the sandboxed iframe host for an approved custom widget. */
export function renderCustomWidgetHost(params: {
  widget: WorkspaceWidget;
  manifest: WidgetManifestView;
  context: CustomWidgetHostContext;
}): TemplateResult {
  return html`<div class="workspace-widget__custom" data-test-id="workspace-custom-widget">
    ${customWidgetFrame(params)}
  </div>`;
}
