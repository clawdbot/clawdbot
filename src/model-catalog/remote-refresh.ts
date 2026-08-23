import {
  validateAndSanitizeRemoteModelCatalogBundle,
  type RemoteModelCatalogBundle,
} from "@openclaw/model-catalog-core";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { compareOpenClawVersions } from "../config/version.js";
import { readResponseWithLimit } from "../infra/http-body.js";
import {
  fetchConfiguredLocalOriginWithSsrFGuard,
  fetchWithSsrFGuard,
} from "../infra/net/fetch-guard.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { VERSION } from "../version.js";
import { bundledCatalogGeneratedAt } from "./bundled-catalog-stamp.js";
import {
  markRemoteModelCatalogChecked,
  readRemoteModelCatalog,
  writeRemoteModelCatalog,
} from "./remote-store.js";

const DEFAULT_REMOTE_MODEL_CATALOG_URL = "https://catalog.openclaw.ai/models/v1/catalog.json";
export const REMOTE_MODEL_CATALOG_TTL_MS = 6 * 60 * 60_000;
const REMOTE_MODEL_CATALOG_TIMEOUT_MS = 15_000;
const REMOTE_MODEL_CATALOG_MAX_BYTES = 4 * 1024 * 1024;

type RefreshCounts = { providers: number; models: number };
type RemoteModelCatalogRefreshResult =
  | ({ status: "updated" | "unchanged"; generatedAt: number } & RefreshCounts)
  | ({ status: "fresh"; generatedAt: number; nextCheckInMs: number } & RefreshCounts)
  | { status: "disabled"; providers: 0; models: 0 }
  | { status: "error"; error: string; providers: 0; models: 0 };

export function isRemoteModelCatalogRefreshEnabled(config: OpenClawConfig): boolean {
  return config.models?.catalogRefresh?.enabled !== false;
}

export function resolveRemoteCatalogUrl(config: OpenClawConfig): string {
  return config.models?.catalogRefresh?.url?.trim() || DEFAULT_REMOTE_MODEL_CATALOG_URL;
}

function bundleCounts(bundle: RemoteModelCatalogBundle): RefreshCounts {
  const providers = Object.values(bundle.providers);
  return {
    providers: providers.length,
    models: providers.reduce((total, provider) => total + provider.models.length, 0),
  };
}

function storedCounts(bundleJson: string): RefreshCounts & { generatedAt: number } {
  const bundle = validateAndSanitizeRemoteModelCatalogBundle(JSON.parse(bundleJson));
  return { ...bundleCounts(bundle), generatedAt: bundle.generatedAt };
}

function assertCompatibleMinVersion(bundle: RemoteModelCatalogBundle): void {
  if (!bundle.minVersion) {
    return;
  }
  const comparison = compareOpenClawVersions(VERSION, bundle.minVersion);
  if (comparison === null) {
    throw new Error(`invalid remote catalog minVersion: ${bundle.minVersion}`);
  }
  if (comparison < 0) {
    throw new Error(
      `remote catalog requires OpenClaw ${bundle.minVersion} or newer (current ${VERSION})`,
    );
  }
}

function isExplicitLocalHttpUrl(config: OpenClawConfig, url: string): boolean {
  if (!config.models?.catalogRefresh?.url) {
    return false;
  }
  const parsed = new URL(url);
  return (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]")
  );
}

export async function refreshRemoteModelCatalog(params: {
  config: OpenClawConfig;
  force?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  databaseOptions?: OpenClawStateDatabaseOptions;
  now?: () => number;
  bundledGeneratedAt?: () => number | undefined;
}): Promise<RemoteModelCatalogRefreshResult> {
  if (!isRemoteModelCatalogRefreshEnabled(params.config)) {
    return { status: "disabled", providers: 0, models: 0 };
  }
  const databaseOptions = params.databaseOptions ?? {};
  const now = (params.now ?? Date.now)();
  try {
    const url = resolveRemoteCatalogUrl(params.config);
    const stored = readRemoteModelCatalog(databaseOptions);
    const activeStored = stored?.source_url === url ? stored : undefined;
    if (
      !params.force &&
      activeStored &&
      now - activeStored.checked_at < REMOTE_MODEL_CATALOG_TTL_MS
    ) {
      return {
        status: "fresh",
        nextCheckInMs: Math.max(0, REMOTE_MODEL_CATALOG_TTL_MS - (now - activeStored.checked_at)),
        ...storedCounts(activeStored.bundle_json),
      };
    }
    const headers = new Headers({ Accept: "application/json" });
    if (activeStored?.etag) {
      headers.set("If-None-Match", activeStored.etag);
    }
    if (activeStored?.last_modified) {
      headers.set("If-Modified-Since", activeStored.last_modified);
    }
    const fetchParams = {
      url,
      init: { headers },
      timeoutMs: REMOTE_MODEL_CATALOG_TIMEOUT_MS,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
      auditContext: "remote-model-catalog",
    } as const;
    const explicitOverride = Boolean(params.config.models?.catalogRefresh?.url);
    const localHttp = isExplicitLocalHttpUrl(params.config, url);
    let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
    if (explicitOverride) {
      const configuredOrigin = new URL(url).origin;
      guarded = await fetchConfiguredLocalOriginWithSsrFGuard({
        ...fetchParams,
        configuredLocalOriginBaseUrl: configuredOrigin,
        policy: { allowedOrigins: [configuredOrigin] },
        requireHttps: !localHttp,
      });
    } else {
      guarded = await fetchWithSsrFGuard({ ...fetchParams, requireHttps: true });
    }
    try {
      if (guarded.response.status === 304) {
        if (!activeStored) {
          throw new Error("remote catalog returned 304 without a stored bundle");
        }
        const marked = markRemoteModelCatalogChecked(
          now,
          {
            expected: activeStored,
            etag: guarded.response.headers.get("etag") ?? activeStored.etag,
            lastModified:
              guarded.response.headers.get("last-modified") ?? activeStored.last_modified,
          },
          databaseOptions,
        );
        const current = marked ? activeStored : readRemoteModelCatalog(databaseOptions);
        return {
          status: "unchanged",
          ...storedCounts(current?.bundle_json ?? activeStored.bundle_json),
        };
      }
      if (!guarded.response.ok) {
        throw new Error(`remote catalog request failed: HTTP ${guarded.response.status}`);
      }
      const body = await readResponseWithLimit(guarded.response, REMOTE_MODEL_CATALOG_MAX_BYTES, {
        chunkTimeoutMs: REMOTE_MODEL_CATALOG_TIMEOUT_MS,
      });
      const bundle = validateAndSanitizeRemoteModelCatalogBundle(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
      );
      assertCompatibleMinVersion(bundle);
      const bundleJson = JSON.stringify(bundle);
      const unchanged = activeStored?.bundle_json === bundleJson;
      const writeResult = writeRemoteModelCatalog(
        {
          bundle_json: bundleJson,
          generated_at: bundle.generatedAt,
          min_version: bundle.minVersion ?? null,
          source_url: url,
          etag: guarded.response.headers.get("etag"),
          last_modified: guarded.response.headers.get("last-modified"),
          checked_at: now,
        },
        databaseOptions,
      );
      if (writeResult.status === "retained-newer") {
        return { status: "unchanged", ...storedCounts(writeResult.row.bundle_json) };
      }
      const bundledGeneratedAt = (params.bundledGeneratedAt ?? bundledCatalogGeneratedAt)();
      return {
        status:
          unchanged || bundledGeneratedAt === undefined || bundle.generatedAt <= bundledGeneratedAt
            ? "unchanged"
            : "updated",
        generatedAt: bundle.generatedAt,
        ...bundleCounts(bundle),
      };
    } finally {
      await guarded.release();
    }
  } catch (error) {
    return { status: "error", error: String(error), providers: 0, models: 0 };
  }
}
