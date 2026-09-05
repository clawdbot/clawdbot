import type { PluginListResult } from "../../lib/plugins/index.ts";
import { fetchPluginIconBlobUrl, type PluginIconFetchContext } from "./icon-loader.ts";
import { pluginArtPath } from "./presentation.ts";

type PluginIconControllerHost = {
  getFetchContext: () => PluginIconFetchContext;
  isConnected: () => boolean;
  onUrlsChange: (urls: Record<string, string>) => void;
};

export class PluginIconController {
  private readonly misses = new Set<string>();
  private readonly requests = new Map<
    string,
    { controller: AbortController; timeout: ReturnType<typeof setTimeout> }
  >();
  private urls: Record<string, string> = {};

  constructor(private readonly host: PluginIconControllerHost) {}

  reconcile(result: PluginListResult | null) {
    const eligiblePluginIds = new Set(
      (result?.plugins ?? [])
        .filter((plugin) => plugin.hasIcon && !pluginArtPath(plugin.id))
        .map((plugin) => plugin.id),
    );
    const nextUrls = { ...this.urls };
    let urlsChanged = false;
    for (const [pluginId, url] of Object.entries(nextUrls)) {
      if (!eligiblePluginIds.has(pluginId)) {
        URL.revokeObjectURL(url);
        delete nextUrls[pluginId];
        urlsChanged = true;
      }
    }
    if (urlsChanged) {
      this.publish(nextUrls);
    }
    for (const [pluginId, request] of this.requests) {
      if (!eligiblePluginIds.has(pluginId)) {
        clearTimeout(request.timeout);
        request.controller.abort();
        this.requests.delete(pluginId);
      }
    }
    for (const pluginId of this.misses) {
      if (!eligiblePluginIds.has(pluginId)) {
        this.misses.delete(pluginId);
      }
    }
  }

  reset() {
    for (const request of this.requests.values()) {
      clearTimeout(request.timeout);
      request.controller.abort();
    }
    for (const url of Object.values(this.urls)) {
      URL.revokeObjectURL(url);
    }
    this.requests.clear();
    this.misses.clear();
    this.publish({});
  }

  sync(result: PluginListResult | null) {
    for (const plugin of result?.plugins ?? []) {
      if (
        !plugin.hasIcon ||
        pluginArtPath(plugin.id) ||
        this.urls[plugin.id] ||
        this.misses.has(plugin.id) ||
        this.requests.has(plugin.id)
      ) {
        continue;
      }
      this.fetch(plugin.id);
    }
  }

  handleError(pluginId: string) {
    this.invalidate(pluginId);
    this.misses.add(pluginId);
  }

  invalidate(pluginId: string) {
    const request = this.requests.get(pluginId);
    if (request) {
      clearTimeout(request.timeout);
      request.controller.abort();
      this.requests.delete(pluginId);
    }
    const url = this.urls[pluginId];
    if (url) {
      URL.revokeObjectURL(url);
    }
    const nextUrls = { ...this.urls };
    delete nextUrls[pluginId];
    this.publish(nextUrls);
    this.misses.delete(pluginId);
  }

  private publish(urls: Record<string, string>) {
    this.urls = urls;
    this.host.onUrlsChange(urls);
  }

  private fetch(pluginId: string) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException("plugin icon fetch timed out", "TimeoutError")),
      10_000,
    );
    const request = { controller, timeout };
    this.requests.set(pluginId, request);
    void fetchPluginIconBlobUrl({
      pluginId,
      ...this.host.getFetchContext(),
      signal: controller.signal,
    })
      .then((url) => {
        if (this.requests.get(pluginId) !== request || !this.host.isConnected()) {
          if (url) {
            URL.revokeObjectURL(url);
          }
          return;
        }
        if (url) {
          this.publish({ ...this.urls, [pluginId]: url });
        } else {
          this.misses.add(pluginId);
        }
      })
      .catch(() => {
        if (this.requests.get(pluginId) === request) {
          this.misses.add(pluginId);
        }
      })
      .finally(() => {
        clearTimeout(timeout);
        if (this.requests.get(pluginId) === request) {
          this.requests.delete(pluginId);
        }
      });
  }
}
