import {
  validateAndSanitizeRemoteModelCatalogBundle,
  type RemoteModelCatalogBundle,
  type RemoteModelCatalogPricing,
} from "@openclaw/model-catalog-core";
import type { ModelCatalogProvider } from "@openclaw/model-catalog-core/model-catalog-types";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { compareOpenClawVersions } from "../config/version.js";
import { VERSION } from "../version.js";
import { bundledCatalogGeneratedAt } from "./bundled-catalog-stamp.js";
import { isRemoteModelCatalogRefreshEnabled, resolveRemoteCatalogUrl } from "./remote-refresh.js";
import { readRemoteModelCatalog } from "./remote-store.js";

type RemoteModelCatalogOverlay = Readonly<Record<string, ModelCatalogProvider>>;
type ActiveRemoteModelCatalog = {
  providers: RemoteModelCatalogOverlay;
  pricing?: Readonly<Record<string, RemoteModelCatalogPricing>>;
};

let cachedOverlay: { sourceUrl: string; value: ActiveRemoteModelCatalog | null } | undefined;
let readBundledGeneratedAt = bundledCatalogGeneratedAt;
let readStoredCatalog = readRemoteModelCatalog;

function isCompatible(bundle: RemoteModelCatalogBundle): boolean {
  if (!bundle.minVersion) {
    return true;
  }
  const comparison = compareOpenClawVersions(VERSION, bundle.minVersion);
  return comparison !== null && comparison >= 0;
}

function getActiveRemoteModelCatalog(config: OpenClawConfig): ActiveRemoteModelCatalog | undefined {
  if (!isRemoteModelCatalogRefreshEnabled(config)) {
    return undefined;
  }
  try {
    const sourceUrl = resolveRemoteCatalogUrl(config);
    if (cachedOverlay?.sourceUrl === sourceUrl) {
      return cachedOverlay.value ?? undefined;
    }
    const bundledGeneratedAt = readBundledGeneratedAt();
    if (bundledGeneratedAt === undefined) {
      cachedOverlay = { sourceUrl, value: null };
      return undefined;
    }
    const stored = readStoredCatalog();
    if (!stored || stored.source_url !== sourceUrl) {
      cachedOverlay = { sourceUrl, value: null };
      return undefined;
    }
    const bundle = validateAndSanitizeRemoteModelCatalogBundle(JSON.parse(stored.bundle_json));
    if (bundle.generatedAt <= bundledGeneratedAt || !isCompatible(bundle)) {
      cachedOverlay = { sourceUrl, value: null };
      return undefined;
    }
    const value = {
      providers: bundle.providers,
      ...(bundle.pricing ? { pricing: bundle.pricing } : {}),
    };
    cachedOverlay = { sourceUrl, value };
    return value;
  } catch {
    cachedOverlay = undefined;
    return undefined;
  }
}

export function getRemoteModelCatalogOverlay(
  config: OpenClawConfig,
): RemoteModelCatalogOverlay | undefined {
  return getActiveRemoteModelCatalog(config)?.providers;
}

export function getRemoteModelCatalogPricing(
  config: OpenClawConfig,
): Readonly<Record<string, RemoteModelCatalogPricing>> | undefined {
  return getActiveRemoteModelCatalog(config)?.pricing;
}

function resetRemoteModelCatalogOverlayForTest(): void {
  cachedOverlay = undefined;
}

function setRemoteModelCatalogOverlaySourcesForTest(sources?: {
  bundledGeneratedAt?: typeof bundledCatalogGeneratedAt;
  readStoredCatalog?: typeof readRemoteModelCatalog;
}): void {
  cachedOverlay = undefined;
  readBundledGeneratedAt = sources?.bundledGeneratedAt ?? bundledCatalogGeneratedAt;
  readStoredCatalog = sources?.readStoredCatalog ?? readRemoteModelCatalog;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.remoteModelCatalogOverlayTestApi")
  ] = {
    resetRemoteModelCatalogOverlayForTest,
    setRemoteModelCatalogOverlaySourcesForTest,
  };
}
