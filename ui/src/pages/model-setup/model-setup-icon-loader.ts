import type { ApplicationContext } from "../../app/context.ts";
import { fetchCatalogIconBlobUrl } from "../plugins/icon-loader.ts";

type IconRequest = {
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout>;
};

export class ModelSetupIconLoader {
  private urls: Record<string, string> = {};
  private readonly misses = new Set<string>();
  private readonly requests = new Map<string, IconRequest>();

  constructor(
    private readonly getContext: () => ApplicationContext,
    private readonly isEligible: (iconUrl: string) => boolean,
    private readonly onChange: (urls: Record<string, string>) => void,
  ) {}

  reconcile(eligible: ReadonlySet<string>): void {
    const nextUrls = { ...this.urls };
    let changed = false;
    for (const [iconUrl, blobUrl] of Object.entries(nextUrls)) {
      if (!eligible.has(iconUrl)) {
        URL.revokeObjectURL(blobUrl);
        delete nextUrls[iconUrl];
        changed = true;
      }
    }
    if (changed) {
      this.publish(nextUrls);
    }
    for (const [iconUrl, request] of this.requests) {
      if (!eligible.has(iconUrl)) {
        clearTimeout(request.timeout);
        request.controller.abort();
        this.requests.delete(iconUrl);
      }
    }
    for (const iconUrl of this.misses) {
      if (!eligible.has(iconUrl)) {
        this.misses.delete(iconUrl);
      }
    }
    for (const iconUrl of eligible) {
      if (!this.urls[iconUrl] && !this.misses.has(iconUrl) && !this.requests.has(iconUrl)) {
        this.fetch(iconUrl);
      }
    }
  }

  invalidate(iconUrl: string): void {
    const request = this.requests.get(iconUrl);
    if (request) {
      clearTimeout(request.timeout);
      request.controller.abort();
      this.requests.delete(iconUrl);
    }
    const blobUrl = this.urls[iconUrl];
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
    }
    const nextUrls = { ...this.urls };
    delete nextUrls[iconUrl];
    this.publish(nextUrls);
    this.misses.add(iconUrl);
  }

  reset(): void {
    for (const request of this.requests.values()) {
      clearTimeout(request.timeout);
      request.controller.abort();
    }
    for (const blobUrl of Object.values(this.urls)) {
      URL.revokeObjectURL(blobUrl);
    }
    this.requests.clear();
    this.misses.clear();
    this.publish({});
  }

  private fetch(iconUrl: string): void {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException("catalog icon fetch timed out", "TimeoutError")),
      10_000,
    );
    const request = { controller, timeout };
    this.requests.set(iconUrl, request);
    const context = this.getContext();
    void fetchCatalogIconBlobUrl({
      iconUrl,
      basePath: context.basePath,
      gatewayUrl: context.gateway.connection.gatewayUrl,
      auth: {
        hello: context.gateway.snapshot.hello,
        settings: { token: context.gateway.connection.token },
        password: context.gateway.connection.password,
      },
      signal: controller.signal,
    })
      .then((blobUrl) => {
        if (
          this.requests.get(iconUrl) !== request ||
          this.getContext().gateway.snapshot.phase !== "connected" ||
          !this.isEligible(iconUrl)
        ) {
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
        if (this.requests.get(iconUrl) === request) {
          this.misses.add(iconUrl);
        }
      })
      .finally(() => {
        clearTimeout(timeout);
        if (this.requests.get(iconUrl) === request) {
          this.requests.delete(iconUrl);
        }
      });
  }

  private publish(urls: Record<string, string>): void {
    this.urls = urls;
    this.onChange(urls);
  }
}
