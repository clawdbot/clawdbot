import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import {
  hasProviderBrandIcon,
  renderProviderBrandIcon,
  renderProviderFallbackIcon,
} from "../../components/provider-icon.ts";
import { fetchCatalogIconBlobUrl } from "../plugins/icon-loader.ts";
import type { ModelSetupPageState } from "./state.ts";

type SetupIconEntry = {
  brandId?: string;
  label: string;
  icon?: string;
};

function resolveSetupBrandIcon(entry: SetupIconEntry): string | null {
  // Brand identity comes from the Gateway; never infer it from a display label.
  return entry.brandId && hasProviderBrandIcon(entry.brandId) ? entry.brandId : null;
}

export function renderProviderIcon(
  props: { iconUrls: Readonly<Record<string, string>>; onIconError: (url: string) => void },
  entry: SetupIconEntry,
  className = "",
) {
  const localBrand = resolveSetupBrandIcon(entry);
  if (localBrand) {
    return renderProviderBrandIcon(localBrand, {
      className: `model-setup__icon ${className}`.trim(),
    });
  }
  const blobUrl = entry.icon ? props.iconUrls[entry.icon] : undefined;
  if (!entry.icon || !blobUrl) {
    return renderProviderFallbackIcon(entry.label, {
      className: `model-setup__icon ${className}`.trim(),
    });
  }
  return html`<img
    class=${`model-setup__icon ${className}`.trim()}
    src=${blobUrl}
    alt=${entry.label}
    width="24"
    height="24"
    @error=${() => props.onIconError(entry.icon!)}
  />`;
}

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
    private readonly getPageState: () => ModelSetupPageState,
    private readonly onChange: (urls: Record<string, string>) => void,
  ) {}

  reconcile(): void {
    const eligible = this.currentIconUrls();
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

  private currentIconUrls(): Set<string> {
    const pageState = this.getPageState();
    if (pageState.phase !== "ready") {
      return new Set();
    }
    const result = pageState.result;
    return new Set(
      [
        ...result.candidates,
        ...(result.unavailableCandidates ?? []),
        ...result.manualProviders,
        ...(result.authOptions ?? []),
        ...(result.prepareOptions ?? []),
        ...(result.recommendedInstalls ?? []),
      ].flatMap((entry) => (entry.icon && !resolveSetupBrandIcon(entry) ? [entry.icon] : [])),
    );
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
      resourceBasePath: context.resourceBasePath,
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
          !this.currentIconUrls().has(iconUrl)
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
