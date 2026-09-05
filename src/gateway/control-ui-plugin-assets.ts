import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  PluginControlUiActivation,
  PluginControlUiDiagnostic,
  PluginControlUiModule,
  PluginsControlUiCatalog,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  readPluginControlUiAssets,
  type PluginControlUiAsset,
} from "../plugins/control-ui-assets.js";
import { loadPluginManifest, type PluginManifestControlUi } from "../plugins/manifest.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { capturePluginLifecycleAuthority } from "../plugins/registry-lifecycle.js";
import type { PluginRecord, PluginRegistry } from "../plugins/registry.js";
import { getPluginRegistryForContext } from "../plugins/runtime.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { respondNotFound } from "./control-ui-http-utils.js";
import {
  controlUiPluginAssetPrefix,
  controlUiPluginAssetRoot,
} from "./control-ui-plugin-assets-contract.js";
import {
  CUSTOM_PLUGIN_UI_DISABLED_MESSAGE,
  isControlUiPluginAllowed,
} from "./control-ui-plugin-policy.js";
import {
  authorizeControlUiPluginCookieRequest,
  authorizeControlUiReadRequestOrReply,
} from "./http-auth-utils.js";
import { sendGatewayAuthFailure, sendMethodNotAllowed } from "./http-common.js";
import { authorizeOperatorScopesForRequiredScope, READ_SCOPE } from "./method-scopes.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

const MAX_CONTROL_UI_PLUGINS = 64;
const MAX_CONTROL_UI_CATALOG_BYTES = 64 * 1024 * 1024;
const MAX_CONTROL_UI_CATALOG_REVISIONS = 256;

type BrowserBuild = {
  isCurrent: () => boolean;
  module: PluginControlUiModule;
  assets: ReadonlyMap<string, PluginControlUiAsset>;
  bytes: number;
};
type BrowserPluginState = {
  isCurrent: () => boolean;
  build?: BrowserBuild;
  revisions: Map<string, BrowserBuild>;
  diagnostic?: PluginControlUiDiagnostic;
  activations: WeakMap<object, PluginControlUiActivation>;
  initialized: boolean;
};

// Exact backend records retain advertised bytes and browser receipts across unrelated
// registry publications. Replaced records cannot inherit their predecessor's snapshots.
const browserPluginStates = new WeakMap<PluginRecord, BrowserPluginState>();
let pendingCatalogOperation: Promise<void> | undefined;

function getActiveBrowserRegistry(): PluginRegistry | null {
  const registry = getPluginRegistryForContext();
  return registry && capturePluginLifecycleAuthority(registry)?.() ? registry : null;
}

function pluginState(registry: PluginRegistry, record: PluginRecord): BrowserPluginState {
  let state = browserPluginStates.get(record);
  if (!state?.isCurrent()) {
    const isCurrent = capturePluginLifecycleAuthority(registry, record);
    if (!isCurrent?.()) {
      throw new Error("plugin is no longer active");
    }
    state = {
      isCurrent,
      revisions: new Map(),
      activations: new WeakMap(),
      initialized: false,
    };
    browserPluginStates.set(record, state);
  }
  return state;
}

function browserOwners(registry: PluginRegistry): PluginRecord[] {
  return registry.plugins
    .filter((record) => record.enabled && record.status === "loaded" && record.controlUi)
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

async function snapshotBrowserBuild(
  registry: PluginRegistry,
  record: PluginRecord,
  declaration = record.controlUi,
): Promise<BrowserBuild> {
  const authority = capturePluginLifecycleAuthority(registry, record);
  const isCurrent = () => authority?.() === true && isControlUiPluginAllowed(record);
  if (!declaration || !record.rootDir || !isCurrent()) {
    throw new Error("plugin is no longer active");
  }
  const { entryName, styles, assets, bytes } = await readPluginControlUiAssets(
    record.rootDir,
    declaration,
  );
  const digest = createHash("sha256").update(JSON.stringify(declaration));
  for (const [name, asset] of [...assets].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    digest.update(`${name}\0${asset.body.length}\0`).update(asset.body);
  }
  const revision = digest.digest("hex");
  const basePath = getRuntimeConfigSnapshot()?.gateway?.controlUi?.basePath;
  const prefix = `${controlUiPluginAssetPrefix(record.id, basePath)}${revision}/`;
  const assetUrl = (name: string) =>
    `${prefix}${name.split("/").map(encodeURIComponent).join("/")}`;
  if (!isCurrent()) {
    throw new Error("plugin was replaced while its browser assets loaded");
  }
  return {
    isCurrent,
    assets,
    bytes,
    module: {
      pluginId: record.id,
      name: record.name,
      revision,
      entryUrl: assetUrl(entryName),
      styles: styles.map(assetUrl),
    },
  };
}

async function refreshBrowserCatalog(
  registry: PluginRegistry,
  isCurrent: () => boolean,
  pluginId?: string,
  reloadManifest = false,
): Promise<void> {
  if (!isCurrent()) {
    throw new Error("plugin registry is no longer active");
  }
  const owners = browserOwners(registry);
  if (owners.length > MAX_CONTROL_UI_PLUGINS) {
    throw new Error(`Native Control UI supports at most ${MAX_CONTROL_UI_PLUGINS} active plugins`);
  }
  if (pluginId && !owners.some((record) => record.id === pluginId)) {
    throw new Error("No active Control UI entrypoint for this plugin");
  }
  for (const record of owners) {
    if (!isControlUiPluginAllowed(record)) {
      browserPluginStates.delete(record);
      continue;
    }
    const state = pluginState(registry, record);
    if (state.initialized && (!reloadManifest || (pluginId && record.id !== pluginId))) {
      continue;
    }
    try {
      let declaration: PluginManifestControlUi | undefined = record.controlUi;
      if (reloadManifest) {
        // Explicit UI reload owns a fresh metadata read without replacing the
        // backend's process-stable manifest, imports, or registration authority.
        const loaded = withPluginCache(createPluginCache(), () =>
          loadPluginManifest(record.rootDir!, true, record.rootDir),
        );
        if (!loaded.ok || loaded.manifest.id !== record.id || !loaded.manifest.controlUi) {
          throw new Error("active plugin browser declaration is missing or invalid");
        }
        declaration = loaded.manifest.controlUi;
      }
      const build = await snapshotBrowserBuild(registry, record, declaration);
      if (!isCurrent()) {
        throw new Error("plugin registry was replaced while its browser assets loaded");
      }
      const revisionKey = build.module.revision;
      if (!state.revisions.has(revisionKey)) {
        let bytes = build.bytes;
        let revisionCount = 0;
        for (const owner of owners) {
          const retained = browserPluginStates.get(owner);
          if (!isControlUiPluginAllowed(owner) || !retained?.isCurrent()) {
            continue;
          }
          revisionCount += retained.revisions.size;
          for (const retainedBuild of retained.revisions.values()) {
            bytes += retainedBuild.bytes;
          }
        }
        if (
          bytes > MAX_CONTROL_UI_CATALOG_BYTES ||
          revisionCount >= MAX_CONTROL_UI_CATALOG_REVISIONS
        ) {
          state.diagnostic = {
            pluginId: record.id,
            message:
              "Control UI revision cache is full. Reload this plugin's backend or restart the Gateway before loading another browser build.",
          };
          continue;
        }
      }
      // Publish complete immutable bytes at once; refused reloads preserve every advertised URL.
      state.revisions.set(revisionKey, build);
      state.build = build;
      delete state.diagnostic;
    } catch {
      if (!isCurrent()) {
        throw new Error("plugin registry was replaced while its browser assets loaded");
      }
      state.diagnostic = {
        pluginId: record.id,
        message: "Control UI assets could not be loaded. Build the plugin and reload its UI.",
      };
    } finally {
      if (isCurrent()) {
        state.initialized = true;
      }
    }
  }
}

function projectBrowserCatalog(registry: PluginRegistry | null): PluginsControlUiCatalog {
  const active = registry ? browserOwners(registry) : [];
  const plugins = active.flatMap((record) => {
    const build = browserPluginStates.get(record)?.build;
    return build?.isCurrent() ? [build.module] : [];
  });
  const diagnostics = active.flatMap((record): PluginControlUiDiagnostic[] => {
    if (!isControlUiPluginAllowed(record)) {
      return [
        {
          pluginId: record.id,
          code: "custom-plugin-ui-disabled",
          message: CUSTOM_PLUGIN_UI_DISABLED_MESSAGE,
        },
      ];
    }
    const diagnostic = browserPluginStates.get(record)?.diagnostic;
    return diagnostic ? [diagnostic] : [];
  });
  const revision = createHash("sha256")
    .update(JSON.stringify({ plugins, diagnostics }))
    .digest("hex");
  return { revision, plugins, diagnostics };
}

async function loadControlUiPluginCatalog(
  pluginId?: string,
  reloadManifest = false,
): Promise<PluginsControlUiCatalog> {
  const registry = getPluginRegistryForContext();
  if (!registry) {
    if (pluginId) {
      throw new Error("No active Control UI entrypoint for this plugin");
    }
    return projectBrowserCatalog(null);
  }
  const isCurrent = capturePluginLifecycleAuthority(registry);
  if (!isCurrent?.()) {
    throw new Error("plugin registry is no longer active");
  }
  const operation = (pendingCatalogOperation ?? Promise.resolve()).then(async () => {
    await refreshBrowserCatalog(registry, isCurrent, pluginId, reloadManifest);
    if (!isCurrent()) {
      throw new Error("plugin registry is no longer active");
    }
    return projectBrowserCatalog(registry);
  });
  // Serialize the shared byte budget and retained owners across registry publications.
  // Failed requests own their rejection; later readers wait only for settlement.
  const pending = operation.then(
    () => undefined,
    () => undefined,
  );
  pendingCatalogOperation = pending;
  try {
    return await operation;
  } finally {
    if (pendingCatalogOperation === pending) {
      pendingCatalogOperation = undefined;
    }
  }
}

/** Explicit UI-only refresh; never imports or replaces backend plugin code. */
export function reloadControlUiPluginCatalog(pluginId?: string): Promise<PluginsControlUiCatalog> {
  return loadControlUiPluginCatalog(pluginId, true);
}

export function listControlUiPluginCatalog(): Promise<PluginsControlUiCatalog> {
  return loadControlUiPluginCatalog();
}

/** A receipt is an observation by one live browser connection, never activation authority. */
export function reportControlUiPluginActivation(
  client: object,
  report: PluginControlUiActivation,
): boolean {
  const registry = getActiveBrowserRegistry();
  const owner = registry?.plugins.find((record) => record.id === report.pluginId);
  const state = owner && browserPluginStates.get(owner);
  const build = state?.build;
  if (!state || !build?.isCurrent() || build.module.revision !== report.revision) {
    return false;
  }
  state.activations.set(client, { ...report });
  return true;
}

export function listControlUiPluginActivations(
  client: object,
  pluginId?: string,
): PluginControlUiActivation[] {
  const registry = getActiveBrowserRegistry();
  return (registry ? browserOwners(registry) : []).flatMap((record) => {
    const state = browserPluginStates.get(record);
    const report = state?.activations.get(client);
    return report &&
      (!pluginId || pluginId === record.id) &&
      state?.build?.isCurrent() &&
      state.build.module.revision === report.revision
      ? [report]
      : [];
  });
}

/** Serves only snapshot bytes after scoped plugin-cookie or explicit read authentication. */
export async function handleControlUiPluginAssetRequest(
  req: IncomingMessage,
  res: ServerResponse,
  params: {
    auth: ResolvedGatewayAuth;
    basePath: string;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const assetRoot = controlUiPluginAssetRoot(params.basePath);
  if (!pathname.startsWith(assetRoot)) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }
  let segments: string[];
  try {
    segments = pathname.slice(assetRoot.length).split("/").map(decodeURIComponent);
  } catch {
    respondNotFound(res);
    return true;
  }
  const [pluginId, revision = "", ...fileParts] = segments;
  if (
    !pluginId ||
    !/^[a-f0-9]{64}$/u.test(revision) ||
    fileParts.length === 0 ||
    fileParts.some((part) => !part || part === "." || part === ".." || /[\\/\0]/u.test(part))
  ) {
    respondNotFound(res);
    return true;
  }
  const cookieAuth = authorizeControlUiPluginCookieRequest(req, {
    requestPath: pathname,
    authGeneration: resolveSharedGatewaySessionGeneration(params.auth, params.trustedProxies),
  });
  if (cookieAuth) {
    const grant = cookieAuth.requestAuth.controlUiPluginGrants?.find(
      (candidate) =>
        candidate.pluginId === pluginId &&
        authorizeOperatorScopesForRequiredScope(READ_SCOPE, candidate.scopes).allowed,
    );
    if (!grant) {
      sendGatewayAuthFailure(res, { ok: false, reason: "unauthorized" });
      return true;
    }
  } else if (!(await authorizeControlUiReadRequestOrReply({ req, res, ...params }))) {
    return true;
  }
  const registry = getActiveBrowserRegistry();
  const owner = registry?.plugins.find((record) => record.id === pluginId);
  const build = owner && browserPluginStates.get(owner)?.revisions.get(revision);
  const asset =
    build && build.module.revision === revision && build.isCurrent()
      ? build.assets.get(fileParts.join("/"))
      : undefined;
  if (!asset) {
    respondNotFound(res);
    return true;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", asset.contentType);
  res.setHeader("Content-Length", asset.body.length);
  res.setHeader("Cache-Control", "private, no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(req.method === "HEAD" ? undefined : asset.body);
  return true;
}
