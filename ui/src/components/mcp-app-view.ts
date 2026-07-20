import { consume } from "@lit/context";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  type CallToolResult,
  type ListToolsRequest,
  ListToolsRequestSchema,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { isMcpAppViewExpiredError } from "@openclaw/gateway-protocol";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { I18nController, t } from "../i18n/index.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import {
  buildMcpAppHostCapabilities,
  dispatchWidgetPrompt,
  MCP_APP_VIEW_EXPIRED_EVENT,
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
  updateModelContextSupported?: boolean;
};

type HostContext = NonNullable<
  NonNullable<ConstructorParameters<typeof AppBridge>[3]>["hostContext"]
>;
type ScheduleFrame = (callback: FrameRequestCallback) => number;
type ScheduleFallback = (callback: () => void, delayMs: number) => number;
type McpAppResources = {
  bridge: OpenClawAppBridge | null;
  cleanups: Set<() => void>;
  frameHeight: number;
  iframe: HTMLIFrameElement;
  transport: { close(): Promise<void> } | null;
};

const MCP_APP_TEARDOWN_TIMEOUT_MS = 250;

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

  setUpdateModelContextHandler(handler: NonNullable<AppBridge["onupdatemodelcontext"]>) {
    Reflect.set(this, "onupdatemodelcontext", handler);
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
  @property({ type: Boolean }) fixedHeight = false;
  @property() override title = "";
  @state() private error: string | null = null;

  protected readonly i18nController = new I18nController(this);
  private readonly mount = createRef<HTMLDivElement>();
  private resources: McpAppResources | null = null;
  private teardownPromise: Promise<void> | null = null;
  private setupKey = "";
  private setupClient: object | null = null;
  private setupGeneration = 0;

  override disconnectedCallback() {
    void this.teardown();
    super.disconnectedCallback();
  }

  override updated(changedProperties: PropertyValues<this>) {
    if (this.resources) {
      this.resources.iframe.title = this.title || t("mcpApp.title");
      if (
        changedProperties.has("height") ||
        (changedProperties.has("fixedHeight") && this.fixedHeight)
      ) {
        this.resources.frameHeight = this.height;
        this.resources.iframe.style.height = `${this.height}px`;
        this.resources.bridge?.setHostContext(hostContext(this.mount.value, this.height));
      }
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
    try {
      return await client.request(method, {
        sessionKey: this.sessionKey,
        viewId: this.viewId,
        ...params,
      });
    } catch (error) {
      if (isMcpAppViewExpiredError(error)) {
        this.dispatchEvent(
          new CustomEvent(MCP_APP_VIEW_EXPIRED_EVENT, { bubbles: true, composed: true }),
        );
      }
      throw error;
    }
  }

  private addResourceCleanup(resources: McpAppResources, cleanup: () => void): () => void {
    resources.cleanups.add(cleanup);
    return () => {
      if (resources.cleanups.delete(cleanup)) {
        cleanup();
      }
    };
  }

  private runResourceCleanups(resources: McpAppResources) {
    for (const cleanup of resources.cleanups) {
      resources.cleanups.delete(cleanup);
      cleanup();
    }
  }

  private async teardownCurrentResources() {
    const resources = this.resources;
    if (!resources) {
      await this.teardownPromise;
      return;
    }
    // Release ownership before awaiting so this generation can never close a replacement.
    this.resources = null;
    this.runResourceCleanups(resources);
    const teardown = (async () => {
      if (resources.bridge) {
        let timeout: number | undefined;
        try {
          await Promise.race([
            resources.bridge.teardownResource({}).catch(() => undefined),
            new Promise<void>((resolve) => {
              timeout = window.setTimeout(resolve, MCP_APP_TEARDOWN_TIMEOUT_MS);
            }),
          ]);
        } finally {
          if (timeout !== undefined) {
            window.clearTimeout(timeout);
          }
        }
      }
      await resources.transport?.close().catch(() => undefined);
      resources.iframe.remove();
    })();
    this.teardownPromise = teardown;
    try {
      await teardown;
    } finally {
      if (this.teardownPromise === teardown) {
        this.teardownPromise = null;
      }
    }
  }

  /** Parent render owners await this before removing the connected view. */
  async teardown() {
    this.setupGeneration += 1;
    await this.teardownCurrentResources();
  }

  /** Restarts a torn-down view only when its parent kept the element connected. */
  restartAfterTeardown() {
    if (!this.isConnected || this.resources || this.teardownPromise) {
      return;
    }
    this.setupKey = `${this.sessionKey}\0${this.viewId}`;
    this.setupClient = this.context?.gateway.snapshot.client ?? null;
    void this.setup();
  }

  private async setup() {
    const generation = ++this.setupGeneration;
    await this.teardownCurrentResources();
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
      const resources: McpAppResources = {
        bridge: null,
        cleanups: new Set(),
        frameHeight: this.height,
        iframe,
        transport: null,
      };
      this.resources = resources;

      const proxyReady = new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanupProxyReady();
          reject(new Error("MCP App sandbox timed out"));
        }, 15_000);
        const onMessage = (event: MessageEvent) => {
          if (
            event.source === iframe.contentWindow &&
            event.data?.method === "ui/notifications/sandbox-proxy-ready"
          ) {
            cleanupProxyReady();
            resolve();
          }
        };
        const cleanupProxyReady = this.addResourceCleanup(resources, () => {
          window.clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
        });
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

      const bridge = new OpenClawAppBridge(
        null,
        { name: "OpenClaw", version: "1.0.0" },
        buildMcpAppHostCapabilities(
          payload.csp,
          payload.messageSupported === true,
          payload.updateModelContextSupported === true,
        ),
        { hostContext: hostContext(mount, this.height) },
      );
      resources.bridge = bridge;
      const handleRequestTeardown = () => {
        void this.teardown();
      };
      bridge.onrequestteardown = handleRequestTeardown;
      this.addResourceCleanup(resources, () => {
        if (bridge.onrequestteardown === handleRequestTeardown) {
          bridge.onrequestteardown = undefined;
        }
      });
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
      if (payload.updateModelContextSupported === true) {
        bridge.setUpdateModelContextHandler(async (params) => {
          await this.request("mcp.app.updateModelContext", { ...params });
          return {};
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
        if (height !== undefined && !this.fixedHeight) {
          const nextHeight = Math.min(1200, Math.max(160, Math.round(height)));
          resources.frameHeight = nextHeight;
          iframe.style.height = `${nextHeight}px`;
          bridge.setHostContext(hostContext(mount, nextHeight));
        }
      };
      const initialized = new Promise<void>((resolve) => {
        bridge.oninitialized = () => resolve();
      });
      const transport = new PostMessageTransport(iframe.contentWindow, iframe.contentWindow);
      resources.transport = transport;
      await bridge.connect(transport);
      await bridge.sendSandboxResourceReady({
        html: payload.html,
        csp: payload.csp,
      });
      let initializationTimeout: number | undefined;
      const cleanupInitializationTimeout = this.addResourceCleanup(resources, () => {
        if (initializationTimeout !== undefined) {
          window.clearTimeout(initializationTimeout);
        }
      });
      try {
        await Promise.race([
          initialized,
          new Promise<never>((_, reject) => {
            initializationTimeout = window.setTimeout(
              () => reject(new Error("MCP App initialization timed out")),
              15_000,
            );
          }),
        ]);
      } finally {
        cleanupInitializationTimeout();
      }
      if (generation !== this.setupGeneration) {
        return;
      }
      const updateHostContext = () =>
        bridge.setHostContext(hostContext(mount, resources.frameHeight));
      const hostContextCleanup = this.context?.theme.subscribe(updateHostContext);
      if (hostContextCleanup) {
        this.addResourceCleanup(resources, hostContextCleanup);
      }
      if (typeof ResizeObserver !== "undefined") {
        const hostResizeObserver = new ResizeObserver(updateHostContext);
        hostResizeObserver.observe(mount);
        this.addResourceCleanup(resources, () => hostResizeObserver.disconnect());
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
        await this.teardownCurrentResources();
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
