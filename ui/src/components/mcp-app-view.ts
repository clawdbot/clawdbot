import { consume } from "@lit/context";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  type CallToolResult,
  type ListToolsRequest,
  ListToolsRequestSchema,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { I18nController, t } from "../i18n/index.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import {
  buildMcpAppHostCapabilities,
  dispatchWidgetPrompt,
  resolveMcpAppSandboxUrl,
  type McpAppHostSandboxCsp,
} from "./mcp-app-security.ts";

type McpAppViewPayload = {
  sandboxUrl: string;
  sandboxPort: number;
  sandboxOrigin?: string;
  html: string;
  csp?: McpAppHostSandboxCsp;
  toolInput: unknown;
  toolResult: unknown;
  messageSupported?: boolean;
};

type HostContext = NonNullable<
  NonNullable<ConstructorParameters<typeof AppBridge>[3]>["hostContext"]
>;
type ScheduleFrame = (callback: FrameRequestCallback) => number;
type ScheduleFallback = (callback: () => void, delayMs: number) => number;

async function waitForMcpAppHandlerRegistration(
  scheduleFrame: ScheduleFrame = window.requestAnimationFrame.bind(window),
  scheduleFallback: ScheduleFallback = window.setTimeout.bind(window),
): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve) => {
      scheduleFrame(() => {
        scheduleFrame(() => resolve());
      });
    }),
    new Promise<void>((resolve) => {
      scheduleFallback(resolve, 1_000);
    }),
  ]);
}

function hostContext(element: Element | undefined, height: number): HostContext {
  const rect = element?.getBoundingClientRect();
  const touch = navigator.maxTouchPoints > 0 || window.matchMedia?.("(pointer: coarse)").matches;
  const themeMode = document.documentElement.dataset.themeMode;
  return {
    theme:
      themeMode === "light" || themeMode === "dark"
        ? themeMode
        : window.matchMedia?.("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light",
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    containerDimensions: {
      width: Math.max(1, Math.round(rect?.width || window.innerWidth)),
      height,
    },
    locale: navigator.language || undefined,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: touch && window.innerWidth < 768 ? "mobile" : "web",
    deviceCapabilities: {
      touch,
      hover: window.matchMedia?.("(hover: hover)").matches,
    },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  };
}

class OpenClawAppBridge extends AppBridge {
  setMessageHandler(handler: NonNullable<AppBridge["onmessage"]>) {
    Reflect.set(this, "onmessage", handler);
  }

  setListToolsHandler(handler: (params: ListToolsRequest["params"]) => Promise<ListToolsResult>) {
    this.replaceRequestHandler(ListToolsRequestSchema, (request) => handler(request.params));
  }
}

export class McpAppView extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
    }
    .mount {
      width: 100%;
      min-height: 160px;
    }
    .mount:empty {
      min-height: 0;
    }
    iframe {
      display: block;
      width: 100%;
      border: 0;
      background: transparent;
    }
    .error {
      padding: 14px;
      color: var(--danger, #dc2626);
      font-size: 13px;
    }
  `;

  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) viewId = "";
  @property({ type: Number }) height = 600;
  @property() override title = "";
  @state() private error: string | null = null;

  protected readonly i18nController = new I18nController(this);
  private readonly mount = createRef<HTMLDivElement>();
  private bridge: AppBridge | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private transport: { close(): Promise<void> } | null = null;
  private hostContextCleanup: (() => void) | null = null;
  private hostResizeObserver: ResizeObserver | null = null;
  private setupKey = "";
  private setupClient: object | null = null;
  private setupGeneration = 0;

  override disconnectedCallback() {
    this.setupGeneration += 1;
    void this.teardown();
    super.disconnectedCallback();
  }

  override updated() {
    if (this.iframe) {
      this.iframe.title = this.title || t("mcpApp.title");
    }
    const nextKey = `${this.sessionKey}\0${this.viewId}`;
    const nextClient = this.context?.gateway.snapshot.client ?? null;
    if (nextKey !== this.setupKey || nextClient !== this.setupClient) {
      this.setupKey = nextKey;
      this.setupClient = nextClient;
      void this.setup();
    }
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const client = this.context?.gateway.snapshot.client;
    if (!client || !this.sessionKey || !this.viewId) {
      throw new Error("MCP App gateway unavailable");
    }
    return await client.request(method, {
      sessionKey: this.sessionKey,
      viewId: this.viewId,
      ...params,
    });
  }

  private async teardown() {
    const bridge = this.bridge;
    const transport = this.transport;
    const iframe = this.iframe;
    const hostContextCleanup = this.hostContextCleanup;
    const hostResizeObserver = this.hostResizeObserver;
    this.bridge = null;
    this.transport = null;
    this.iframe = null;
    this.hostContextCleanup = null;
    this.hostResizeObserver = null;
    // Clear ownership before awaiting: a stale teardown must never close a
    // replacement setup that installs its resources during the handshake.
    hostContextCleanup?.();
    hostResizeObserver?.disconnect();
    iframe?.remove();
    if (bridge) {
      await Promise.race([
        bridge.teardownResource({}).catch(() => undefined),
        new Promise((resolve) => {
          setTimeout(resolve, 250);
        }),
      ]);
    }
    await transport?.close().catch(() => undefined);
  }

  private async setup() {
    const generation = ++this.setupGeneration;
    await this.teardown();
    if (!this.sessionKey || !this.viewId || generation !== this.setupGeneration) {
      return;
    }
    try {
      const payload = (await this.request("mcp.app.view", {})) as McpAppViewPayload;
      const mount = this.mount.value;
      if (!mount || generation !== this.setupGeneration) {
        return;
      }
      const iframe = document.createElement("iframe");
      iframe.title = this.title || t("mcpApp.title");
      // The isolated proxy binds its parent before accepting messages. Only the
      // Control UI origin is disclosed; path/query data remains suppressed.
      iframe.referrerPolicy = "origin";
      iframe.style.height = `${this.height}px`;
      // The proxy listener is a dedicated origin that never serves host data,
      // so Apps retain their required origin capabilities without reaching Control UI.
      iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      mount.appendChild(iframe);
      this.iframe = iframe;

      const proxyReady = new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          window.removeEventListener("message", onMessage);
          reject(new Error("MCP App sandbox timed out"));
        }, 15_000);
        const onMessage = (event: MessageEvent) => {
          if (
            event.source === iframe.contentWindow &&
            event.data?.method === "ui/notifications/sandbox-proxy-ready"
          ) {
            window.clearTimeout(timeout);
            window.removeEventListener("message", onMessage);
            resolve();
          }
        };
        window.addEventListener("message", onMessage);
      });
      iframe.src = resolveMcpAppSandboxUrl(
        payload.sandboxUrl,
        payload.sandboxPort,
        payload.sandboxOrigin,
        this.context?.gateway.connection.gatewayUrl ?? "",
        window.location.origin,
      );
      await proxyReady;
      if (!iframe.contentWindow || generation !== this.setupGeneration) {
        return;
      }

      let frameHeight = this.height;
      const bridge = new OpenClawAppBridge(
        null,
        { name: "OpenClaw", version: "1.0.0" },
        buildMcpAppHostCapabilities(payload.csp, payload.messageSupported === true),
        { hostContext: hostContext(mount, this.height) },
      );
      if (payload.messageSupported === true) {
        const promptRateKey = `${this.sessionKey}\0${this.viewId}`;
        bridge.setMessageHandler(async ({ content }) => {
          const block = content.length === 1 ? content[0] : undefined;
          const text = block?.type === "text" ? block.text : null;
          const accepted = dispatchWidgetPrompt(iframe, text, promptRateKey, (prompt) =>
            window.confirm(`${t("common.confirm")}:\n\n${prompt}`),
          );
          return accepted ? {} : { isError: true };
        });
      }
      bridge.oncalltool = async (params) =>
        (await this.request("mcp.app.callTool", {
          toolName: params.name,
          arguments: params.arguments,
        })) as CallToolResult;
      bridge.setListToolsHandler(
        async (params) =>
          (await this.request(
            "mcp.app.listTools",
            params?.cursor ? { cursor: params.cursor } : {},
          )) as ListToolsResult,
      );
      bridge.onlistresources = async (params) =>
        (await this.request(
          "mcp.app.listResources",
          params?.cursor ? { cursor: params.cursor } : {},
        )) as never;
      bridge.onlistresourcetemplates = async (params) =>
        (await this.request(
          "mcp.app.listResourceTemplates",
          params?.cursor ? { cursor: params.cursor } : {},
        )) as never;
      bridge.onreadresource = async (params) =>
        (await this.request("mcp.app.readResource", { uri: params.uri })) as never;
      bridge.onopenlink = async ({ url }) => (openExternalUrlSafe(url) ? {} : { isError: true });
      bridge.onsizechange = ({ height }) => {
        if (height !== undefined) {
          const nextHeight = Math.min(1200, Math.max(160, Math.round(height)));
          frameHeight = nextHeight;
          iframe.style.height = `${nextHeight}px`;
          bridge.setHostContext(hostContext(mount, nextHeight));
        }
      };
      const initialized = new Promise<void>((resolve) => {
        bridge.oninitialized = () => resolve();
      });
      const transport = new PostMessageTransport(iframe.contentWindow, iframe.contentWindow);
      this.bridge = bridge;
      this.transport = transport;
      await bridge.connect(transport);
      await bridge.sendSandboxResourceReady({
        html: payload.html,
        csp: payload.csp,
      });
      await Promise.race([
        initialized,
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error("MCP App initialization timed out")), 15_000);
        }),
      ]);
      if (generation !== this.setupGeneration) {
        return;
      }
      const updateHostContext = () => bridge.setHostContext(hostContext(mount, frameHeight));
      this.hostContextCleanup = this.context?.theme.subscribe(updateHostContext) ?? null;
      if (typeof ResizeObserver !== "undefined") {
        this.hostResizeObserver = new ResizeObserver(updateHostContext);
        this.hostResizeObserver.observe(mount);
      }
      await waitForMcpAppHandlerRegistration();
      if (generation !== this.setupGeneration) {
        return;
      }
      await bridge.sendToolInput({
        arguments:
          payload.toolInput &&
          typeof payload.toolInput === "object" &&
          !Array.isArray(payload.toolInput)
            ? (payload.toolInput as Record<string, unknown>)
            : {},
      });
      await bridge.sendToolResult(payload.toolResult as never);
      if (generation === this.setupGeneration) {
        this.error = null;
      }
    } catch (error) {
      if (generation === this.setupGeneration) {
        await this.teardown();
        this.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  override render() {
    return html`<div ${ref(this.mount)} class="mount"></div>
      ${this.error
        ? html`<div class="error">${t("mcpApp.unavailable", { error: this.error })}</div>`
        : nothing}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "mcp-app-view": McpAppView;
  }
}
