import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import {
  hasProviderBrandIcon,
  renderProviderBrandIcon,
  renderProviderFallbackIcon,
} from "../../components/provider-icon.ts";
import { CatalogIconLoader } from "../plugins/catalog-icon-loader.ts";
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

function currentIconUrls(pageState: ModelSetupPageState): Set<string> {
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

export class ModelSetupIconLoader {
  private readonly loader: CatalogIconLoader;

  constructor(
    getContext: () => ApplicationContext,
    private readonly getPageState: () => ModelSetupPageState,
    onChange: (urls: Record<string, string>) => void,
  ) {
    this.loader = new CatalogIconLoader(
      getContext,
      (iconUrl) => currentIconUrls(this.getPageState()).has(iconUrl),
      onChange,
    );
  }

  reconcile(): void {
    this.loader.reconcile(currentIconUrls(this.getPageState()));
  }

  invalidate(iconUrl: string): void {
    this.loader.invalidate(iconUrl);
  }

  reset(): void {
    this.loader.reset();
  }
}
