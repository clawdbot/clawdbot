import type { PluginDiscoveryEntry } from "../../lib/plugins/index.ts";
import { fetchCatalogIconBlobUrl, type PluginIconFetchContext } from "./icon-loader.ts";

type CatalogIconControllerHost = {
  getFetchContext: () => PluginIconFetchContext;
  isConnected: () => boolean;
  onUrlsChange: (urls: Record<string, string>) => void;
};

export class CatalogIconController {
  private readonly misses = new Set<string>();
  private readonly requests = new Map<string, AbortController>();
  private urls: Record<string, string> = {};

  constructor(private readonly host: CatalogIconControllerHost) {}

  sync(entries: readonly PluginDiscoveryEntry[], extraUrls: readonly string[] = []): void {
    const eligible = new Set([
      ...entries.flatMap((entry) => (entry.catalog.imageUrl ? [entry.catalog.imageUrl] : [])),
      ...extraUrls,
    ]);
    const next = { ...this.urls };
    let changed = false;
    for (const [iconUrl, blobUrl] of Object.entries(next)) {
      if (!eligible.has(iconUrl)) {
        URL.revokeObjectURL(blobUrl);
        delete next[iconUrl];
        changed = true;
      }
    }
    for (const [iconUrl, controller] of this.requests) {
      if (!eligible.has(iconUrl)) {
        controller.abort();
        this.requests.delete(iconUrl);
      }
    }
    if (changed) {
      this.publish(next);
    }
    for (const iconUrl of eligible) {
      if (!this.urls[iconUrl] && !this.misses.has(iconUrl) && !this.requests.has(iconUrl)) {
        this.fetch(iconUrl);
      }
    }
  }

  reset(): void {
    for (const controller of this.requests.values()) {
      controller.abort();
    }
    for (const blobUrl of Object.values(this.urls)) {
      URL.revokeObjectURL(blobUrl);
    }
    this.requests.clear();
    this.misses.clear();
    if (Object.keys(this.urls).length > 0) {
      this.publish({});
    }
  }

  private fetch(iconUrl: string): void {
    const controller = new AbortController();
    this.requests.set(iconUrl, controller);
    void fetchCatalogIconBlobUrl({
      iconUrl,
      ...this.host.getFetchContext(),
      signal: controller.signal,
    })
      .then((blobUrl) => {
        if (this.requests.get(iconUrl) !== controller || !this.host.isConnected()) {
          if (blobUrl) {
            URL.revokeObjectURL(blobUrl);
          }
          return;
        }
        if (blobUrl) {
          this.publish({ ...this.urls, [iconUrl]: blobUrl });
        } else {
          this.misses.add(iconUrl);
        }
      })
      .catch(() => {
        if (this.requests.get(iconUrl) === controller && !controller.signal.aborted) {
          this.misses.add(iconUrl);
        }
      })
      .finally(() => {
        if (this.requests.get(iconUrl) === controller) {
          this.requests.delete(iconUrl);
        }
      });
  }

  private publish(urls: Record<string, string>): void {
    this.urls = urls;
    this.host.onUrlsChange(urls);
  }
}
