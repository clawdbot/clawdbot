import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import { fetchPluginIconBlobUrl } from "../plugins/icon-loader.ts";

const CHANNEL_PLUGIN_ICON_TIMEOUT_MS = 10_000;

type PluginPresentationRequest = {
  client: GatewayBrowserClient;
  controller: AbortController;
  iconTimeout?: ReturnType<typeof setTimeout>;
};

type PluginPresentationHooks = {
  getContext: () => ApplicationContext;
  getChannelIds: () => readonly string[];
  isConnected: () => boolean;
  requestUpdate: () => void;
};

export class ChannelPluginPresentationController {
  private catalog: PluginListResult | null = null;
  private iconUrls: Record<string, string> = {};
  private request: PluginPresentationRequest | null = null;
  private pendingEnsureClient: GatewayBrowserClient | null = null;

  constructor(private readonly hooks: PluginPresentationHooks) {}

  get pluginCatalog() {
    return this.catalog;
  }

  get pluginIconUrls() {
    return this.iconUrls;
  }

  ensure(client: GatewayBrowserClient | null) {
    if (!client) {
      return;
    }
    if (this.request?.client === client) {
      if (this.catalog) {
        this.pendingEnsureClient = client;
      }
      return;
    }
    if (this.catalog) {
      this.startIconLoad(client, this.catalog);
      return;
    }
    this.request?.controller.abort();
    const controller = new AbortController();
    const request: PluginPresentationRequest = { client, controller };
    this.request = request;
    void client
      .request<PluginListResult>("plugins.list", {}, { signal: controller.signal })
      .then(async (result) => {
        if (
          this.request !== request ||
          this.hooks.getContext().gateway.snapshot.client !== client
        ) {
          return;
        }
        this.catalog = result;
        this.hooks.requestUpdate();
        await this.loadIcons(result, request);
      })
      .catch(() => {
        // Channel status metadata remains a complete fallback when catalog loading fails.
      })
      .finally(() => this.finishRequest(request));
  }

  private startIconLoad(client: GatewayBrowserClient, catalog: PluginListResult) {
    this.request?.controller.abort();
    const request: PluginPresentationRequest = { client, controller: new AbortController() };
    this.request = request;
    void this.loadIcons(catalog, request).finally(() => this.finishRequest(request));
  }

  private async loadIcons(result: PluginListResult, request: PluginPresentationRequest) {
    request.iconTimeout = setTimeout(
      () =>
        request.controller.abort(new DOMException("plugin icon fetch timed out", "TimeoutError")),
      CHANNEL_PLUGIN_ICON_TIMEOUT_MS,
    );
    const channelIds = new Set(this.hooks.getChannelIds());
    const iconEntries = await Promise.all(
      result.plugins
        .filter(
          (plugin) => plugin.hasIcon && channelIds.has(plugin.id) && !this.iconUrls[plugin.id],
        )
        .map(async (plugin) => {
          const context = this.hooks.getContext();
          const url = await fetchPluginIconBlobUrl({
            pluginId: plugin.id,
            resourceBasePath: context.resourceBasePath,
            gatewayUrl: context.gateway.connection.gatewayUrl,
            auth: {
              hello: context.gateway.snapshot.hello,
              settings: { token: context.gateway.connection.token },
              password: context.gateway.connection.password,
            },
            signal: request.controller.signal,
          }).catch(() => null);
          return [plugin.id, url] as const;
        }),
    );
    const loadedUrls = Object.fromEntries(
      iconEntries.filter((entry): entry is readonly [string, string] => entry[1] !== null),
    );
    if (this.request !== request || !this.hooks.isConnected()) {
      for (const url of Object.values(loadedUrls)) {
        URL.revokeObjectURL(url);
      }
      return;
    }
    this.iconUrls = { ...this.iconUrls, ...loadedUrls };
    this.hooks.requestUpdate();
  }

  private finishRequest(request: PluginPresentationRequest) {
    if (request.iconTimeout) {
      clearTimeout(request.iconTimeout);
    }
    if (this.request !== request) {
      return;
    }
    this.request = null;
    const pendingClient = this.pendingEnsureClient;
    this.pendingEnsureClient = null;
    if (pendingClient && this.hooks.isConnected()) {
      this.ensure(pendingClient);
    }
  }

  reset() {
    this.request?.controller.abort();
    if (this.request?.iconTimeout) {
      clearTimeout(this.request.iconTimeout);
    }
    this.request = null;
    this.pendingEnsureClient = null;
    for (const url of Object.values(this.iconUrls)) {
      URL.revokeObjectURL(url);
    }
    this.catalog = null;
    this.iconUrls = {};
    this.hooks.requestUpdate();
  }
}
