import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import {
  CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS,
  CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE,
  CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY,
  CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY,
  resolveControlUiPluginTabPathname,
  type ControlUiPluginFrameGrantAck,
} from "../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient, GatewayControlUiPluginTab } from "../../api/gateway.ts";
import type { RouteId } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorApprovalsAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { resolveEmbedSandbox } from "../../lib/chat/tool-display.ts";
import { OpenClawLightDomContentsElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { pluginTabKey } from "./route.ts";

/**
 * Bundled plugin tab views ship with the Control UI and render natively; every
 * other tab either embeds the plugin-served panel (descriptor path) in a
 * sandboxed frame or shows the unavailable card.
 */
type BundledPluginTabView = {
  render: (props: {
    host: object;
    client: GatewayBrowserClient | null;
    connected: boolean;
    embed?: {
      embedSandboxMode: ApplicationContext<RouteId>["config"]["current"]["embedSandboxMode"];
      allowExternalEmbedUrls: boolean;
    };
    onRequestUpdate: () => void;
    // L5: custom widgets need the gateway HTTP base (iframe src) and the session
    // key (prompt dispatch). Bundled views that don't use them ignore these.
    basePath?: string;
    sessionKey?: string;
    /** Canonical sessions.list publication revision, used by session-backed widgets. */
    sessionListRevision?: number;
    /** Whether this connection can decide pending custom-widget code. */
    canApproveWidgets?: boolean;
  }) => unknown;
  stop: (host: object) => void;
};

function pluginFrameGrantCoversTab(
  grant: ControlUiPluginFrameGrantAck,
  info: GatewayControlUiPluginTab,
): boolean {
  if (!info.path || grant.pluginId !== info.pluginId) {
    return false;
  }
  const tabPath = resolveControlUiPluginTabPathname(info.path);
  if (!tabPath) {
    return false;
  }
  if (grant.match === "exact") {
    return tabPath === grant.path;
  }
  return (
    tabPath === grant.path ||
    (tabPath.startsWith(grant.path) &&
      (grant.path.endsWith("/") || tabPath.at(grant.path.length) === "/"))
  );
}

const EXTERNAL_AUTH_REFRESH_TIMEOUT_MS = 10_000;
const EXTERNAL_AUTH_PROBE_TIMEOUT_MS = 5_000;

// Keyed by pluginId/tabId: tab ids are only unique within their plugin.
const BUNDLED_TAB_VIEWS: Record<string, () => Promise<BundledPluginTabView>> = {
  "workspaces/workspaces": async () => {
    const [{ renderWorkspace }, { stopWorkspace }] = await Promise.all([
      import("./workspace-view.ts"),
      import("./workspace-controller.ts"),
    ]);
    return { render: renderWorkspace, stop: stopWorkspace };
  },
  "logbook/logbook": async () => {
    const [{ renderLogbook }, { stopLogbookPolling }] = await Promise.all([
      import("./logbook-view.ts"),
      import("./logbook-controller.ts"),
    ]);
    return { render: renderLogbook, stop: stopLogbookPolling };
  },
};

export class PluginPage extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) pluginId = "";
  @property({ attribute: false }) tabId = "";

  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext<RouteId>;

  @state() private bundledView: BundledPluginTabView | null = null;
  @state() private externalAuthReadyKey: string | null = null;
  @state() private externalAuthUnavailableKey: string | null = null;

  private bundledViewId: string | null = null;
  private bundledViewLoadToken: object | null = null;
  private bundledViewHost: object = {};
  private gatewaySource?: ApplicationContext<RouteId>["gateway"];
  private gatewayClient: GatewayBrowserClient | null = null;
  private gatewayConnected = false;
  private externalAuthTargetKey: string | null = null;
  private externalAuthRefreshMarker: object | null = null;
  private externalAuthRefreshAbortController: AbortController | null = null;
  private externalAuthRefreshWatchdog: ReturnType<typeof setTimeout> | null = null;
  private externalAuthProbeMarker: object | null = null;
  private externalAuthProbeAbortController: AbortController | null = null;
  private externalAuthRestartKey: string | null = null;
  private externalAuthRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private externalAuthExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private externalAuthRefreshedAt = 0;
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
      (gateway) => this.updateGatewaySource(gateway),
    )
    .watch(
      () => this.context?.sessions,
      (sessions, notify) => sessions.subscribe(notify),
    );

  private readonly handleVisibilityChange = () => {
    if (document.visibilityState !== "visible" || !this.externalAuthTargetKey) {
      return;
    }
    if (Date.now() - this.externalAuthRefreshedAt >= CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS) {
      // A suspended browser may miss renewal timers. Remove an expired frame
      // until the parent refreshes its route-bound cookie on resume.
      this.externalAuthReadyKey = null;
      this.externalAuthRefreshedAt = 0;
      this.requestExternalTabAuthRestart(this.externalAuthTargetKey);
      return;
    }
    this.refreshExternalTabAuth(this.externalAuthTargetKey);
  };

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  override disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.clearExternalTabAuth();
    this.subscriptions.clear();
    this.stopBundledView();
    super.disconnectedCallback();
  }

  private tabKey(): string {
    return pluginTabKey({ pluginId: this.pluginId, id: this.tabId });
  }

  protected loadBundledView(key: string): Promise<BundledPluginTabView> {
    const load = BUNDLED_TAB_VIEWS[key];
    return load ? load() : Promise.reject(new Error(`Unknown bundled plugin tab: ${key}`));
  }

  override willUpdate() {
    if (!this.isConnected) {
      return;
    }
    const key = this.tabKey();
    const info = this.tabInfo();
    const hasBundledDescriptor = info !== undefined && key in BUNDLED_TAB_VIEWS;
    // Switching between plugin tabs reuses this element; the previous bundled
    // view must stop its background polling before the next one renders. A
    // descriptor can also disappear in place after disablement or scope loss.
    if (this.bundledViewId !== null && (this.bundledViewId !== key || !hasBundledDescriptor)) {
      this.stopBundledView();
    }
    if (this.bundledViewId === null && hasBundledDescriptor) {
      const loadToken = {};
      this.bundledViewId = key;
      this.bundledViewLoadToken = loadToken;
      void this.loadBundledView(key).then((view) => {
        if (
          this.bundledViewLoadToken === loadToken &&
          this.bundledViewId === key &&
          this.tabKey() === key
        ) {
          this.bundledView = view;
        }
      });
    }
    this.syncExternalTabAuth(info, hasBundledDescriptor);
  }

  private externalTabAuthKey(
    info: GatewayControlUiPluginTab | undefined,
    hasBundledDescriptor: boolean,
  ): string | null {
    return info?.path &&
      info.requiresGatewayAuth === true &&
      !hasBundledDescriptor &&
      this.isExternalTabAuthSupported()
      ? `${this.tabKey()}\n${info.path}`
      : null;
  }

  private isExternalTabAuthSupported(): boolean {
    // Secure cross-site cookies work on HTTPS and browser-trusted loopback.
    // Insecure LAN HTTP must not fall back to an ambient bearer substitute.
    return window.isSecureContext;
  }

  protected probeExternalTabAuth(path: string, signal: AbortSignal): Promise<boolean> {
    const url = new URL(path, window.location.href);
    if (url.origin !== window.location.origin) {
      return Promise.resolve(false);
    }
    const random = new Uint8Array(16);
    crypto.getRandomValues(random);
    const nonce = Array.from(random, (value) => value.toString(16).padStart(2, "0")).join("");
    url.searchParams.set(CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY, nonce);
    url.searchParams.set(CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY, window.location.origin);

    return new Promise((resolve) => {
      const frame = document.createElement("iframe");
      frame.hidden = true;
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("sandbox", "allow-scripts");
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = (result: boolean) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        window.removeEventListener("message", handleMessage);
        signal.removeEventListener("abort", handleAbort);
        frame.remove();
        resolve(result);
      };
      const handleMessage = (event: MessageEvent) => {
        if (
          event.source === frame.contentWindow &&
          event.data?.type === CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE &&
          event.data?.nonce === nonce
        ) {
          finish(true);
        }
      };
      const handleAbort = () => finish(false);
      window.addEventListener("message", handleMessage);
      signal.addEventListener("abort", handleAbort, { once: true });
      timeout = setTimeout(() => finish(false), EXTERNAL_AUTH_PROBE_TIMEOUT_MS);
      frame.src = url.toString();
      document.body.append(frame);
    });
  }

  private syncExternalTabAuth(
    info: GatewayControlUiPluginTab | undefined,
    hasBundledDescriptor: boolean,
  ) {
    const targetKey = this.externalTabAuthKey(info, hasBundledDescriptor);
    if (this.externalAuthTargetKey !== targetKey) {
      this.clearExternalTabAuth();
      this.externalAuthTargetKey = targetKey;
    }
    if (
      targetKey &&
      this.externalAuthReadyKey !== targetKey &&
      this.externalAuthUnavailableKey !== targetKey
    ) {
      this.refreshExternalTabAuth(targetKey);
    }
  }

  private refreshExternalTabAuth(targetKey: string) {
    const context = this.context;
    if (
      !context ||
      !context.gateway.snapshot.connected ||
      this.externalAuthTargetKey !== targetKey ||
      this.externalAuthRefreshMarker ||
      this.externalAuthProbeMarker
    ) {
      return;
    }
    const refreshMarker = {};
    const refreshStartedAt = Date.now();
    const abortController = new AbortController();
    this.externalAuthUnavailableKey = null;
    this.externalAuthRefreshMarker = refreshMarker;
    this.externalAuthRefreshAbortController = abortController;
    this.externalAuthRefreshWatchdog = setTimeout(() => {
      if (this.externalAuthRefreshMarker === refreshMarker) {
        this.requestExternalTabAuthRestart(targetKey);
      }
    }, EXTERNAL_AUTH_REFRESH_TIMEOUT_MS);
    void context.config
      .refresh({ signal: abortController.signal })
      .then((refreshed) => {
        if (
          this.externalAuthRefreshMarker !== refreshMarker ||
          this.externalAuthTargetKey !== targetKey
        ) {
          return;
        }
        const shouldRestart = this.finishExternalTabAuthRefreshAttempt(targetKey);
        if (shouldRestart) {
          this.refreshExternalTabAuth(targetKey);
          return;
        }
        const info = this.tabInfo();
        const path = info?.path;
        const granted =
          refreshed !== null &&
          info !== undefined &&
          path !== undefined &&
          refreshed.pluginFrameGrants.some((grant) => pluginFrameGrantCoversTab(grant, info));
        if (granted) {
          this.startExternalTabAuthProbe(targetKey, path, refreshStartedAt);
        } else if (refreshed) {
          this.externalAuthReadyKey = null;
          this.externalAuthUnavailableKey = targetKey;
          this.externalAuthRefreshedAt = 0;
        } else {
          this.scheduleExternalTabAuthRefresh(targetKey, false);
        }
      })
      .catch(() => {
        if (
          this.externalAuthRefreshMarker !== refreshMarker ||
          this.externalAuthTargetKey !== targetKey
        ) {
          return;
        }
        const shouldRestart = this.finishExternalTabAuthRefreshAttempt(targetKey);
        if (shouldRestart) {
          this.refreshExternalTabAuth(targetKey);
        } else {
          this.scheduleExternalTabAuthRefresh(targetKey, false);
        }
      });
  }

  private startExternalTabAuthProbe(targetKey: string, path: string, refreshedAt: number) {
    this.cancelExternalTabAuthProbe();
    const probeMarker = {};
    const abortController = new AbortController();
    this.externalAuthProbeMarker = probeMarker;
    this.externalAuthProbeAbortController = abortController;
    let probeResult: Promise<boolean>;
    try {
      probeResult = this.probeExternalTabAuth(path, abortController.signal);
    } catch {
      probeResult = Promise.resolve(false);
    }
    void probeResult
      .catch(() => false)
      .then((available) => {
        if (
          this.externalAuthProbeMarker !== probeMarker ||
          this.externalAuthTargetKey !== targetKey
        ) {
          return;
        }
        this.externalAuthProbeMarker = null;
        this.externalAuthProbeAbortController = null;
        if (available) {
          this.externalAuthReadyKey = targetKey;
          this.externalAuthRefreshedAt = refreshedAt;
          this.scheduleExternalTabAuthExpiry(targetKey, refreshedAt);
          this.scheduleExternalTabAuthRefresh(targetKey, true);
          return;
        }
        this.externalAuthReadyKey = null;
        this.externalAuthUnavailableKey = targetKey;
        this.externalAuthRefreshedAt = 0;
        if (this.externalAuthRefreshTimer) {
          clearTimeout(this.externalAuthRefreshTimer);
          this.externalAuthRefreshTimer = null;
        }
        if (this.externalAuthExpiryTimer) {
          clearTimeout(this.externalAuthExpiryTimer);
          this.externalAuthExpiryTimer = null;
        }
      });
  }

  private cancelExternalTabAuthProbe() {
    this.externalAuthProbeMarker = null;
    const abortController = this.externalAuthProbeAbortController;
    this.externalAuthProbeAbortController = null;
    abortController?.abort();
  }

  private finishExternalTabAuthRefreshAttempt(targetKey: string): boolean {
    const shouldRestart = this.externalAuthRestartKey === targetKey;
    if (this.externalAuthRefreshWatchdog) {
      clearTimeout(this.externalAuthRefreshWatchdog);
    }
    this.externalAuthRefreshWatchdog = null;
    this.externalAuthRefreshAbortController = null;
    this.externalAuthRefreshMarker = null;
    this.externalAuthRestartKey = null;
    return shouldRestart;
  }

  private requestExternalTabAuthRestart(targetKey: string) {
    if (this.externalAuthTargetKey !== targetKey) {
      return;
    }
    if (this.externalAuthRefreshMarker) {
      // Wait for abort settlement before starting the replacement request so a
      // stale response cannot overwrite its newer route cookie.
      this.externalAuthRestartKey = targetKey;
      this.externalAuthRefreshAbortController?.abort();
      return;
    }
    if (this.externalAuthProbeMarker) {
      this.cancelExternalTabAuthProbe();
    }
    this.refreshExternalTabAuth(targetKey);
  }

  private scheduleExternalTabAuthExpiry(targetKey: string, refreshedAt: number) {
    if (this.externalAuthExpiryTimer) {
      clearTimeout(this.externalAuthExpiryTimer);
    }
    const delay = Math.max(0, refreshedAt + CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS - Date.now());
    this.externalAuthExpiryTimer = setTimeout(() => {
      this.externalAuthExpiryTimer = null;
      if (this.externalAuthTargetKey !== targetKey || this.externalAuthReadyKey !== targetKey) {
        return;
      }
      // Cookie expiry is independent of renewal completion. Unmount the frame,
      // abandon any hung refresh, and obtain a fresh grant before remounting.
      this.externalAuthReadyKey = null;
      this.externalAuthRefreshedAt = 0;
      if (this.externalAuthRefreshTimer) {
        clearTimeout(this.externalAuthRefreshTimer);
        this.externalAuthRefreshTimer = null;
      }
      this.requestExternalTabAuthRestart(targetKey);
    }, delay);
  }

  private scheduleExternalTabAuthRefresh(targetKey: string, refreshed: boolean) {
    if (this.externalAuthRefreshTimer) {
      clearTimeout(this.externalAuthRefreshTimer);
    }
    const delay = refreshed ? CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2 : 5_000;
    this.externalAuthRefreshTimer = setTimeout(() => {
      this.externalAuthRefreshTimer = null;
      this.refreshExternalTabAuth(targetKey);
    }, delay);
  }

  private clearExternalTabAuth() {
    if (this.externalAuthRefreshTimer) {
      clearTimeout(this.externalAuthRefreshTimer);
    }
    if (this.externalAuthExpiryTimer) {
      clearTimeout(this.externalAuthExpiryTimer);
    }
    if (this.externalAuthRefreshWatchdog) {
      clearTimeout(this.externalAuthRefreshWatchdog);
    }
    this.externalAuthRefreshAbortController?.abort();
    this.cancelExternalTabAuthProbe();
    this.externalAuthRefreshTimer = null;
    this.externalAuthExpiryTimer = null;
    this.externalAuthRefreshWatchdog = null;
    this.externalAuthRefreshAbortController = null;
    this.externalAuthRefreshMarker = null;
    this.externalAuthRestartKey = null;
    this.externalAuthTargetKey = null;
    this.externalAuthReadyKey = null;
    this.externalAuthUnavailableKey = null;
    this.externalAuthRefreshedAt = 0;
  }

  private resetExternalTabAuthForGatewayChange(targetKey: string, connected: boolean) {
    if (this.externalAuthRefreshTimer) {
      clearTimeout(this.externalAuthRefreshTimer);
      this.externalAuthRefreshTimer = null;
    }
    if (this.externalAuthExpiryTimer) {
      clearTimeout(this.externalAuthExpiryTimer);
      this.externalAuthExpiryTimer = null;
    }
    this.externalAuthReadyKey = null;
    this.externalAuthUnavailableKey = null;
    this.externalAuthRefreshedAt = 0;
    this.externalAuthTargetKey = targetKey;
    this.cancelExternalTabAuthProbe();
    if (this.externalAuthRefreshMarker) {
      this.externalAuthRestartKey = connected ? targetKey : null;
      this.externalAuthRefreshAbortController?.abort();
    } else if (connected) {
      this.refreshExternalTabAuth(targetKey);
    }
  }

  private stopBundledView() {
    this.replaceBundledViewHost();
    this.bundledView = null;
    this.bundledViewId = null;
    this.bundledViewLoadToken = null;
  }

  private replaceBundledViewHost() {
    this.bundledView?.stop(this.bundledViewHost);
    // Async controller work is keyed by host. A new host makes every completion
    // from the retired connection epoch unreachable without coupling plugins to Lit.
    this.bundledViewHost = {};
  }

  private updateGatewaySource(gateway: ApplicationContext<RouteId>["gateway"]) {
    const { client, connected } = gateway.snapshot;
    if (
      this.gatewaySource === gateway &&
      this.gatewayClient === client &&
      this.gatewayConnected === connected
    ) {
      return;
    }
    const externalAuthTargetKey = this.externalAuthTargetKey;
    this.replaceBundledViewHost();
    this.gatewaySource = gateway;
    this.gatewayClient = client;
    this.gatewayConnected = connected;
    if (externalAuthTargetKey) {
      this.resetExternalTabAuthForGatewayChange(externalAuthTargetKey, connected);
    }
  }

  private tabInfo(): GatewayControlUiPluginTab | undefined {
    const tabs = this.context?.gateway.snapshot.hello?.controlUiTabs ?? [];
    return tabs.find((tab) => tab.pluginId === this.pluginId && tab.id === this.tabId);
  }

  override render() {
    const context = this.context;
    if (!context) {
      return nothing;
    }
    // Only advertised tabs render: hello omits descriptors whose plugin is
    // inactive or whose required scopes the connection lacks.
    const info = this.tabInfo();
    if (info && this.tabKey() in BUNDLED_TAB_VIEWS) {
      if (!this.bundledView) {
        return nothing;
      }
      const snapshot = context.gateway.snapshot;
      // Config may be absent in unit harnesses; the Workspaces view defaults the
      // embed policy to strict when `embed` is omitted.
      const config = context.config?.current;
      return this.bundledView.render({
        host: this.bundledViewHost,
        client: snapshot.client,
        connected: snapshot.connected,
        embed: config
          ? {
              embedSandboxMode: config.embedSandboxMode,
              allowExternalEmbedUrls: config.allowExternalEmbedUrls,
            }
          : undefined,
        onRequestUpdate: () => this.requestUpdate(),
        basePath: context.basePath,
        sessionKey: snapshot.sessionKey,
        sessionListRevision: context.sessions?.canonicalListRevision,
        canApproveWidgets: hasOperatorApprovalsAccess(snapshot.hello?.auth ?? null),
      });
    }
    if (info?.path) {
      if (info.requiresGatewayAuth === true && !this.isExternalTabAuthSupported()) {
        return html`
          <section class="card lazy-view-state" role="status">
            <div class="card-title">${t("login.failure.insecure.title")}</div>
            <div class="card-sub">${t("login.failure.insecure.stepHttps")}</div>
          </section>
        `;
      }
      const externalAuthKey = this.externalTabAuthKey(info, false);
      if (
        info.requiresGatewayAuth === true &&
        this.externalAuthUnavailableKey === externalAuthKey
      ) {
        return html`
          <section class="card lazy-view-state" role="status">
            <div class="card-title">${t("pluginTabs.unavailableTitle")}</div>
            <div class="card-sub">${t("pluginTabs.unavailableSubtitle")}</div>
          </section>
        `;
      }
      if (info.requiresGatewayAuth === true && this.externalAuthReadyKey !== externalAuthKey) {
        return nothing;
      }
      return html`
        <section class="plugin-tab-embed">
          <iframe
            class="plugin-tab-embed__frame"
            src=${info.path}
            title=${info.label}
            sandbox=${resolveEmbedSandbox(context.config.current.embedSandboxMode)}
          ></iframe>
        </section>
      `;
    }
    return html`
      <section class="card lazy-view-state" role="status">
        <div class="card-title">${t("pluginTabs.unavailableTitle")}</div>
        <div class="card-sub">${t("pluginTabs.unavailableSubtitle")}</div>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-plugin-page")) {
  customElements.define("openclaw-plugin-page", PluginPage);
}
