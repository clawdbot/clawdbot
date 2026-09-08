import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import {
  validateAndSanitizeRemoteModelCatalogBundle,
  type RemoteModelCatalogBundle,
  type RemoteModelCatalogPricing,
} from "@openclaw/model-catalog-core";
import type { ModelCatalogProvider } from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { compareOpenClawVersions } from "../config/version.js";
import { VERSION } from "../version.js";
import { bundledCatalogGeneratedAt } from "./bundled-catalog-stamp.js";
import { isRemoteModelCatalogRefreshEnabled, resolveRemoteCatalogUrl } from "./remote-config.js";
import { readRemoteModelCatalog } from "./remote-store.js";

type RemoteModelCatalogOverlay = Readonly<Record<string, ModelCatalogProvider>>;
type ActiveRemoteModelCatalog = {
  sourceUrl: string;
  generatedAt: number;
  providers: RemoteModelCatalogOverlay;
  pricing?: Readonly<Record<string, RemoteModelCatalogPricing>>;
};

const STARTUP_SNAPSHOT_KEY = "openclaw.remoteModelCatalogStartupSnapshot";
let readBundledGeneratedAt = bundledCatalogGeneratedAt;
let readStoredCatalog = readRemoteModelCatalog;

function isCompatible(bundle: RemoteModelCatalogBundle): boolean {
  if (!bundle.minVersion) {
    return true;
  }
  const comparison = compareOpenClawVersions(VERSION, bundle.minVersion);
  return comparison !== null && comparison >= 0;
}

function readCompatibleRemoteModelCatalog(): ActiveRemoteModelCatalog | null {
  const bundledGeneratedAt = readBundledGeneratedAt();
  if (bundledGeneratedAt === undefined) {
    return null;
  }
  const stored = readStoredCatalog();
  if (!stored) {
    return null;
  }
  const bundle = validateAndSanitizeRemoteModelCatalogBundle(JSON.parse(stored.bundle_json));
  if (bundle.generatedAt <= bundledGeneratedAt || !isCompatible(bundle)) {
    return null;
  }
  return {
    sourceUrl: stored.source_url,
    generatedAt: bundle.generatedAt,
    providers: bundle.providers,
    ...(bundle.pricing ? { pricing: bundle.pricing } : {}),
  };
}

export function captureRemoteModelCatalogStartupSnapshot(): ActiveRemoteModelCatalog | null {
  // SAFETY: This module alone sets the key to a record containing a validated snapshot or null.
  const inherited = getEnvironmentData(STARTUP_SNAPSHOT_KEY) as
    | { catalog: ActiveRemoteModelCatalog | null }
    | undefined;
  if (inherited !== undefined) {
    return inherited.catalog;
  }
  // New workers inherit the startup pair, including absence, rather than later downloads.
  let snapshot: ActiveRemoteModelCatalog | null;
  try {
    snapshot = readCompatibleRemoteModelCatalog();
  } catch {
    snapshot = null;
  }
  setEnvironmentData(STARTUP_SNAPSHOT_KEY, { catalog: snapshot });
  return snapshot;
}

function getActiveRemoteModelCatalog(config: OpenClawConfig): ActiveRemoteModelCatalog | undefined {
  if (!isRemoteModelCatalogRefreshEnabled(config)) {
    return undefined;
  }
  const snapshot = captureRemoteModelCatalogStartupSnapshot();
  return snapshot?.sourceUrl === resolveRemoteCatalogUrl(config) ? snapshot : undefined;
}

/** Inspects a completed check without activating its download or replacing the startup pair. */
export function checkRemoteModelCatalogUpdate(
  config: OpenClawConfig,
  expected: { sourceUrl: string; generatedAt: number },
): "restart-required" | "unchanged" | "superseded" {
  if (
    !isRemoteModelCatalogRefreshEnabled(config) ||
    resolveRemoteCatalogUrl(config) !== expected.sourceUrl
  ) {
    return "superseded";
  }
  if (getActiveRemoteModelCatalog(config)?.generatedAt === expected.generatedAt) {
    return "unchanged";
  }
  const stored = readCompatibleRemoteModelCatalog();
  if (!stored) {
    return "unchanged";
  }
  return stored.sourceUrl === expected.sourceUrl && stored.generatedAt === expected.generatedAt
    ? "restart-required"
    : "superseded";
}

export function getRemoteModelCatalogProviderOverlay(
  config: OpenClawConfig,
  provider: string,
): ModelCatalogProvider | undefined {
  const providerId = normalizeProviderId(provider);
  return providerId ? getActiveRemoteModelCatalog(config)?.providers[providerId] : undefined;
}

export function getRemoteModelCatalogPricing(
  config: OpenClawConfig,
): Readonly<Record<string, RemoteModelCatalogPricing>> | undefined {
  return getActiveRemoteModelCatalog(config)?.pricing;
}

function setRemoteModelCatalogOverlaySourcesForTest(sources?: {
  bundledGeneratedAt?: typeof bundledCatalogGeneratedAt;
  readStoredCatalog?: typeof readRemoteModelCatalog;
}): void {
  setEnvironmentData(STARTUP_SNAPSHOT_KEY, undefined);
  readBundledGeneratedAt = sources?.bundledGeneratedAt ?? bundledCatalogGeneratedAt;
  readStoredCatalog = sources?.readStoredCatalog ?? readRemoteModelCatalog;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.remoteModelCatalogOverlayTestApi")
  ] = {
    setRemoteModelCatalogOverlaySourcesForTest,
  };
}
