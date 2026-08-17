import { consume } from "@lit/context";
import { Task, TaskStatus } from "@lit/task";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  type CallToolResult,
  type ListToolsRequest,
  ListToolsRequestSchema,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { isMcpAppViewExpiredError } from "@openclaw/gateway-protocol";
import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { I18nController, t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import {
  buildMcpAppHostCapabilities,
  dispatchWidgetPrompt,
  MCP_APP_VIEW_EXPIRED_EVENT,
  resolveMcpAppSandboxUrl,
  type McpAppHostSandboxCsp,
} from "./mcp-app-security.ts";
import { collectMcpAppStyleVariables } from "./mcp-app-theme.ts";

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
  operationTimeoutMs: number;
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
  disposed: boolean;
};
type McpAppBinding = {
  client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
  sessionKey: string;
  viewId: string;
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
    // Additive alongside `theme`: the string says which appearance is active,
    // these say what it actually resolves to. Republished by the same theme
    // subscription that re-sends this context.
    styles: { variables: collectMcpAppStyleVariables() },
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
      background: var(--board-surface, transparent);
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
  protected readonly i18nController = new I18nController(this);
  private readonly mount = createRef<HTMLDivElement>();
  private resources: McpAppResources | null = null;
  private teardownPromise: Promise<void> | null = null;

  private readonly setupTask = new Task(this, {
    autoRun: "afterUpdate",
    args: () =>
      [this.context?.gateway.snapshot.client ?? null, this.sessionKey, this.viewId] as const,
    task: async ([client, sessionKey, viewId], { signal }) => {
      await this.teardownResources(this.resources);
      if (!sessionKey || !viewId) {
        return null;
      }
      if (!client) {
        throw new Error(t("mcpApp.errors.gatewayUnavailable"));
      }
      return this.setupResources({ client, sessionKey, viewId }, signal);
    },
  });

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
  }

  private async request(
    binding: McpAppBinding,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown> {
    try {
      const requestParams = {
        sessionKey: binding.sessionKey,
        viewId: binding.viewId,
        ...params,
      };
      const hasRequestOptions = signal !== undefined || timeoutMs !== undefined;
      return await (hasRequestOptions
        ? binding.client.request(method, requestParams, {
            ...(signal ? { signal } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          })
        : binding.client.request(method, requestParams));
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

  private async teardownResources(resources: McpAppResources | null | undefined) {
    if (!resources || resources.disposed) {
      await this.teardownPromise;
      return;
    }
    resources.disposed = true;
    if (this.resources === resources) {
      this.resources = null;
    }
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
    this.setupTask.abort();
    await this.teardownResources(this.resources);
  }

  /** Restarts a torn-down view only when its parent kept the element connected. */
  restartAfterTeardown() {
    if (!this.isConnected || this.resources || this.teardownPromise) {
      return;
    }
    void this.setupTask.run();
  }

  private async setupResources(
    binding: McpAppBinding,
    signal: AbortSignal,
  ): Promise<McpAppResources> {
    const { sessionKey, viewId } = binding;
    let resources: McpAppResources | null = null;
    try {
      const payload = (await this.request(
        binding,
        "mcp.app.view",
        {},
        signal,
      )) as McpAppViewPayload;
      const mount = this.mount.value;
      signal.throwIfAborted();
      if (!mount) {
        throw new Error(t("mcpApp.errors.mountUnavailable"));
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
      const createdResources: McpAppResources = {
        bridge: null,
        cleanups: new Set(),
        frameHeight: this.height,
        iframe,
        transport: null,
        disposed: false,
      };
      resources = createdResources;
      this.resources = createdResources;
      signal.addEventListener("abort", () => void this.teardownResources(createdResources), {
        once: true,
      });

      const proxyReady = new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanupProxyReady();
          reject(new Error(t("mcpApp.errors.sandboxTimedOut")));
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
        const cleanupProxyReady = this.addResourceCleanup(createdResources, () => {
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
      signal.throwIfAborted();
      if (!iframe.contentWindow) {
        throw new Error(t("mcpApp.errors.sandboxUnavailable"));
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
      createdResources.bridge = bridge;
      // The Gateway owns the authoritative operation deadline. Keep the local
      // transport watchdog behind it so server timeout/error responses can win.
      const operationTimeoutMs =
        addTimerTimeoutGraceMs(payload.operationTimeoutMs) ?? payload.operationTimeoutMs;
      const request = (method: string, params: Record<string, unknown>) =>
        this.request(binding, method, params, undefined, operationTimeoutMs);
      const handleRequestTeardown = () => {
        void this.teardown();
      };
      bridge.onrequestteardown = handleRequestTeardown;
      this.addResourceCleanup(createdResources, () => {
        if (bridge.onrequestteardown === handleRequestTeardown) {
          bridge.onrequestteardown = undefined;
        }
      });
      if (payload.messageSupported === true) {
        const promptRateKey = `${sessionKey}\0${viewId}`;
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
          await request("mcp.app.updateModelContext", { ...params });
          return {};
        });
      }
      bridge.oncalltool = async (params) =>
        (await request("mcp.app.callTool", {
          toolName: params.name,
          arguments: params.arguments,
        })) as CallToolResult;
      bridge.setListToolsHandler(
        async (params) =>
          (await request(
            "mcp.app.listTools",
            params?.cursor ? { cursor: params.cursor } : {},
          )) as ListToolsResult,
      );
      bridge.onlistresources = async (params) =>
        (await request(
          "mcp.app.listResources",
          params?.cursor ? { cursor: params.cursor } : {},
        )) as never;
      bridge.onlistresourcetemplates = async (params) =>
        (await request(
          "mcp.app.listResourceTemplates",
          params?.cursor ? { cursor: params.cursor } : {},
        )) as never;
      bridge.onreadresource = async (params) =>
        (await request("mcp.app.readResource", { uri: params.uri })) as never;
      bridge.onopenlink = async ({ url }) => (openExternalUrlSafe(url) ? {} : { isError: true });
      bridge.onsizechange = ({ height }) => {
        if (height !== undefined && !this.fixedHeight) {
          const nextHeight = Math.min(1200, Math.max(160, Math.round(height)));
          createdResources.frameHeight = nextHeight;
          iframe.style.height = `${nextHeight}px`;
          bridge.setHostContext(hostContext(mount, nextHeight));
        }
      };
      const initialized = new Promise<void>((resolve) => {
        bridge.oninitialized = () => resolve();
      });
      const transport = new PostMessageTransport(iframe.contentWindow, iframe.contentWindow);
      createdResources.transport = transport;
      await bridge.connect(transport);
      signal.throwIfAborted();
      await bridge.sendSandboxResourceReady({
        html: payload.html,
        csp: payload.csp,
      });
      let initializationTimeout: number | undefined;
      const cleanupInitializationTimeout = this.addResourceCleanup(createdResources, () => {
        if (initializationTimeout !== undefined) {
          window.clearTimeout(initializationTimeout);
        }
      });
      try {
        await Promise.race([
          initialized,
          new Promise<never>((_, reject) => {
            initializationTimeout = window.setTimeout(
              () => reject(new Error(t("mcpApp.errors.initializationTimedOut"))),
              15_000,
            );
          }),
        ]);
      } finally {
        cleanupInitializationTimeout();
      }
      signal.throwIfAborted();
      const updateHostContext = () =>
        bridge.setHostContext(hostContext(mount, createdResources.frameHeight));
      const hostContextCleanup = this.context?.theme.subscribe(updateHostContext);
      if (hostContextCleanup) {
        this.addResourceCleanup(createdResources, hostContextCleanup);
      }
      if (typeof ResizeObserver !== "undefined") {
        const hostResizeObserver = new ResizeObserver(updateHostContext);
        hostResizeObserver.observe(mount);
        this.addResourceCleanup(createdResources, () => hostResizeObserver.disconnect());
      }
      await waitForMcpAppHandlerRegistration();
      signal.throwIfAborted();
      await bridge.sendToolInput({
        arguments:
          payload.toolInput &&
          typeof payload.toolInput === "object" &&
          !Array.isArray(payload.toolInput)
            ? (payload.toolInput as Record<string, unknown>)
            : {},
      });
      await bridge.sendToolResult(payload.toolResult as never);
      signal.throwIfAborted();
      return createdResources;
    } catch (error) {
      await this.teardownResources(resources);
      throw error;
    }
  }

  override render() {
    const error = this.setupTask.status === TaskStatus.ERROR ? this.setupTask.error : null;
    const errorText = error
      ? t("mcpApp.unavailable", {
          error: formatUiError(error, t("mcpApp.errors.requestFailed")),
        })
      : null;
    return html`<div ${ref(this.mount)} class="mount"></div>
      ${errorText ? html`<div class="error">${errorText}</div>` : nothing}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "mcp-app-view": McpAppView;
  }
}
