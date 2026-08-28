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
  isConnected: () => boolean;
  requestUpdate: () => void;
};

export class ChannelPluginPresentationController {
  private catalog: PluginListResult | null = null;
  private iconUrls: Record<string, string> = {};
  private request: PluginPresentationRequest | null = null;

  constructor(private readonly hooks: PluginPresentationHooks) {}

  get pluginCatalog() {
    return this.catalog;
  }

  get pluginIconUrls() {
    return this.iconUrls;
  }

  ensure(client: GatewayBrowserClient) {
    if (this.catalog || this.request?.client === client) {
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
        request.iconTimeout = setTimeout(
          () => controller.abort(new DOMException("plugin icon fetch timed out", "TimeoutError")),
          CHANNEL_PLUGIN_ICON_TIMEOUT_MS,
        );
        const iconEntries = await Promise.all(
          result.plugins
            .filter((plugin) => plugin.hasIcon)
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
                signal: controller.signal,
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
        this.iconUrls = loadedUrls;
        this.hooks.requestUpdate();
      })
      .catch(() => {
        // Channel status metadata remains a complete fallback when catalog loading fails.
      })
      .finally(() => {
        if (request.iconTimeout) {
          clearTimeout(request.iconTimeout);
        }
        if (this.request === request) {
          this.request = null;
        }
      });
  }

  reset() {
    this.request?.controller.abort();
    if (this.request?.iconTimeout) {
      clearTimeout(this.request.iconTimeout);
    }
    this.request = null;
    for (const url of Object.values(this.iconUrls)) {
      URL.revokeObjectURL(url);
    }
    this.catalog = null;
    this.iconUrls = {};
    this.hooks.requestUpdate();
  }
}
