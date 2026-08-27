/**
 * Channel plugin catalog builder.
 *
 * Combines bundled, installed, and official external channel metadata for UI/setup surfaces.
 */
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeStringEntries,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { MANIFEST_KEY } from "../../compat/legacy-names.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { tryReadJsonSync } from "../../infra/json-files.js";
import { isPrereleaseSemverVersion, parseRegistryNpmSpec } from "../../infra/npm-registry-spec.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { listChannelCatalogEntries } from "../../plugins/channel-catalog-registry.js";
import type { PluginDiscoveryResult } from "../../plugins/discovery.js";
import {
  describePluginInstallSource,
  type PluginInstallSourceInfo,
} from "../../plugins/install-source-info.js";
import type {
  OpenClawPackageManifest,
  PluginPackageChannel,
  PluginPackageInstall,
} from "../../plugins/manifest.js";
import { listOfficialExternalChannelCatalogEntries } from "../../plugins/official-external-plugin-catalog.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../../plugins/plugin-metadata-lifecycle.js";
import type { PluginOrigin } from "../../plugins/plugin-origin.types.js";
import { isRecord, resolveConfigDir, resolveUserPath } from "../../utils.js";
import { buildManifestChannelMeta } from "./channel-meta.js";
import type { ChannelMeta } from "./types.public.js";

export type ChannelUiMetaEntry = {
  id: string;
  label: string;
  detailLabel: string;
  systemImage?: string;
};

export type ChannelUiCatalog = {
  entries: ChannelUiMetaEntry[];
  order: string[];
  labels: Record<string, string>;
  detailLabels: Record<string, string>;
  systemImages: Record<string, string>;
  byId: Record<string, ChannelUiMetaEntry>;
};

export type ChannelPluginCatalogInstall = PluginPackageInstall &
  ({ clawhubSpec: string } | { npmSpec: string });

export type ChannelPluginCatalogEntry = {
  id: string;
  pluginId?: string;
  origin?: PluginOrigin;
  trustedSourceLinkedOfficialInstall?: boolean;
  channel?: PluginPackageChannel;
  meta: ChannelMeta;
  install: ChannelPluginCatalogInstall;
  installSource?: PluginInstallSourceInfo;
};

type CatalogOptions = {
  workspaceDir?: string;
  catalogPaths?: string[];
  officialCatalogPaths?: string[];
  env?: NodeJS.ProcessEnv;
  extraPaths?: string[];
  excludeWorkspace?: boolean;
  excludeOrigins?: PluginOrigin[];
  excludePluginRefs?: Array<{ pluginId: string; origin?: PluginOrigin }>;
  installRecords?: Record<string, PluginInstallRecord>;
  discovery?: PluginDiscoveryResult;
};

const ORIGIN_PRIORITY: Record<PluginOrigin, number> = {
  config: 0,
  workspace: 1,
  global: 2,
  bundled: 3,
};

function shouldExcludeCatalogEntry(
  options: CatalogOptions,
  pluginId?: string,
  origin?: PluginOrigin,
): boolean {
  const normalizedPluginId = normalizeOptionalString(pluginId);
  return (
    (options.excludeWorkspace === true && origin === "workspace") ||
    (origin !== undefined && (options.excludeOrigins?.includes(origin) ?? false)) ||
    Boolean(
      normalizedPluginId &&
      options.excludePluginRefs?.some(
        (entry) =>
          entry.pluginId === normalizedPluginId &&
          (entry.origin === undefined || entry.origin === origin),
      ),
    )
  );
}

const EXTERNAL_CATALOG_PRIORITY = ORIGIN_PRIORITY.bundled + 1;
const FALLBACK_CATALOG_PRIORITY = EXTERNAL_CATALOG_PRIORITY + 1;

type ExternalCatalogEntry = {
  name?: string;
  version?: string;
  description?: string;
} & Partial<Record<ManifestKey, OpenClawPackageManifest>>;

const ENV_CATALOG_PATHS = ["OPENCLAW_PLUGIN_CATALOG_PATHS", "OPENCLAW_MPM_CATALOG_PATHS"];
const OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH = path.join("dist", "channel-catalog.json");
const catalogEntriesByPath = new Map<string, ExternalCatalogEntry[] | null>();

registerPluginMetadataProcessMemoLifecycleClear(() => catalogEntriesByPath.clear());

type ManifestKey = typeof MANIFEST_KEY;

function parseCatalogEntries(raw: unknown): ExternalCatalogEntry[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw)
      ? (raw.entries ?? raw.packages ?? raw.plugins)
      : undefined;
  return Array.isArray(list)
    ? list.filter((entry): entry is ExternalCatalogEntry => isRecord(entry))
    : [];
}

function resolveExternalCatalogPaths(options: CatalogOptions): string[] {
  if (options.catalogPaths && options.catalogPaths.length > 0) {
    return normalizeStringEntries(options.catalogPaths);
  }
  const env = options.env ?? process.env;
  for (const key of ENV_CATALOG_PATHS) {
    const raw = env[key];
    if (raw?.trim()) {
      return normalizeStringEntries(
        raw.split(/[;,]/g).flatMap((chunk) => chunk.split(path.delimiter)),
      );
    }
  }
  const configDir = resolveConfigDir(env);
  return ["mpm/plugins.json", "mpm/catalog.json", "plugins/catalog.json"].map((relativePath) =>
    path.join(configDir, relativePath),
  );
}

function loadCatalogEntriesFromPaths(
  paths: Iterable<string>,
  cache?: Map<string, ExternalCatalogEntry[] | null>,
): ExternalCatalogEntry[] {
  const entries: ExternalCatalogEntry[] = [];
  for (const resolvedPath of paths) {
    let parsed = cache?.get(resolvedPath);
    if (parsed === undefined) {
      const payload = tryReadJsonSync(resolvedPath);
      parsed = payload === null ? null : parseCatalogEntries(payload);
      cache?.set(resolvedPath, parsed);
    }
    if (parsed !== null) {
      entries.push(...parsed);
    }
  }
  return entries;
}

function resolveOfficialCatalogPaths(options: CatalogOptions): string[] {
  if (options.officialCatalogPaths && options.officialCatalogPaths.length > 0) {
    return normalizeStringEntries(options.officialCatalogPaths);
  }

  const packageRoots = uniqueStrings(
    [
      resolveOpenClawPackageRootSync({ cwd: process.cwd() }),
      resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url }),
    ].filter((entry): entry is string => Boolean(entry)),
  );

  const candidates = packageRoots.map((packageRoot) =>
    path.join(packageRoot, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH),
  );

  if (process.execPath) {
    const execDir = path.dirname(process.execPath);
    candidates.push(path.join(execDir, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH));
    candidates.push(path.join(execDir, "channel-catalog.json"));
  }

  return uniqueStrings(candidates);
}

function resolveInstallInfo(params: {
  install?: PluginPackageInstall;
  packageName?: string;
  packageVersion?: string;
  packageDir?: string;
  workspaceDir?: string;
}): ChannelPluginCatalogEntry["install"] | null {
  const clawhubSpec = normalizeOptionalString(params.install?.clawhubSpec);
  let npmSpec =
    normalizeOptionalString(params.install?.npmSpec) ?? normalizeOptionalString(params.packageName);
  const packageVersion = normalizeOptionalString(params.packageVersion);
  const parsedNpmSpec = npmSpec ? parseRegistryNpmSpec(npmSpec) : null;
  const expectedPackageName = normalizeOptionalString(params.packageName);
  const parsedPackageName = expectedPackageName ? parseRegistryNpmSpec(expectedPackageName) : null;
  if (
    npmSpec &&
    packageVersion &&
    isPrereleaseSemverVersion(packageVersion) &&
    parsedNpmSpec?.selectorKind === "none" &&
    (!parsedPackageName || parsedNpmSpec.name === parsedPackageName.name)
  ) {
    npmSpec = `${parsedNpmSpec.name}@${packageVersion}`;
  }
  if (!clawhubSpec && !npmSpec) {
    return null;
  }
  let localPath = normalizeOptionalString(params.install?.localPath);
  if (!localPath && params.workspaceDir && params.packageDir) {
    localPath = path.relative(params.workspaceDir, params.packageDir) || undefined;
  }
  const requestedDefaultChoice = params.install?.defaultChoice;
  const availableChoices = { clawhub: clawhubSpec, npm: npmSpec, local: localPath };
  const defaultChoice: NonNullable<PluginPackageInstall["defaultChoice"]> =
    requestedDefaultChoice &&
    Object.hasOwn(availableChoices, requestedDefaultChoice) &&
    availableChoices[requestedDefaultChoice]
      ? requestedDefaultChoice
      : clawhubSpec
        ? "clawhub"
        : localPath
          ? "local"
          : "npm";
  const install = {
    ...(localPath ? { localPath } : {}),
    defaultChoice,
    ...(params.install?.minHostVersion ? { minHostVersion: params.install.minHostVersion } : {}),
    ...(params.install?.expectedIntegrity
      ? { expectedIntegrity: params.install.expectedIntegrity }
      : {}),
    ...(params.install?.allowInvalidConfigRecovery === true
      ? { allowInvalidConfigRecovery: true }
      : {}),
  };
  if (clawhubSpec) {
    return {
      clawhubSpec,
      ...(npmSpec ? { npmSpec } : {}),
      ...install,
    };
  }
  if (!npmSpec) {
    return null;
  }
  return {
    npmSpec,
    ...install,
  };
}

function buildCatalogEntryFromManifest(params: {
  pluginId?: string;
  packageName?: string;
  packageVersion?: string;
  packageDir?: string;
  origin?: PluginOrigin;
  trustedSourceLinkedOfficialInstall?: boolean;
  workspaceDir?: string;
  channel?: PluginPackageChannel;
  install?: PluginPackageInstall;
}): ChannelPluginCatalogEntry | null {
  const channel = params.channel;
  const id = channel?.id?.trim();
  const label = channel?.label?.trim();
  if (!channel || !id || !label) {
    return null;
  }
  const install = resolveInstallInfo(params);
  if (!install) {
    return null;
  }
  const pluginId = normalizeOptionalString(params.pluginId);
  const systemImage = channel.systemImage?.trim();
  return {
    id,
    ...(pluginId ? { pluginId } : {}),
    ...(params.origin ? { origin: params.origin } : {}),
    ...(params.trustedSourceLinkedOfficialInstall
      ? { trustedSourceLinkedOfficialInstall: true }
      : {}),
    channel,
    meta: buildManifestChannelMeta({
      id,
      channel,
      label,
      selectionLabel: channel.selectionLabel?.trim() || label,
      docsPath: channel.docsPath?.trim() || `/channels/${id}`,
      docsLabel: normalizeOptionalString(channel.docsLabel),
      blurb: channel.blurb?.trim() || "",
      detailLabel: channel.detailLabel?.trim(),
      ...(systemImage ? { systemImage } : {}),
      arrayFieldMode: "defined",
      selectionDocsPrefixMode: "truthy",
    }),
    install,
    installSource: describePluginInstallSource(install, {
      expectedPackageName: params.packageName,
    }),
  };
}

function buildExternalCatalogEntry(
  entry: ExternalCatalogEntry,
  trustedSourceLinkedOfficialInstall = false,
): ChannelPluginCatalogEntry | null {
  const manifest = entry[MANIFEST_KEY];
  return buildCatalogEntryFromManifest({
    pluginId: manifest?.plugin?.id,
    packageName: entry.name,
    packageVersion: entry.version,
    trustedSourceLinkedOfficialInstall,
    channel: manifest?.channel,
    install: manifest?.install,
  });
}

export function buildChannelUiCatalog(
  plugins: Array<{ id: string; meta: ChannelMeta }>,
): ChannelUiCatalog {
  const entries: ChannelUiMetaEntry[] = plugins.map((plugin) => {
    const detailLabel = plugin.meta.detailLabel ?? plugin.meta.selectionLabel ?? plugin.meta.label;
    return {
      id: plugin.id,
      label: plugin.meta.label,
      detailLabel,
      ...(plugin.meta.systemImage ? { systemImage: plugin.meta.systemImage } : {}),
    };
  });
  const order = entries.map((entry) => entry.id);
  const labels: Record<string, string> = {};
  const detailLabels: Record<string, string> = {};
  const systemImages: Record<string, string> = {};
  const byId: Record<string, ChannelUiMetaEntry> = {};
  for (const entry of entries) {
    labels[entry.id] = entry.label;
    detailLabels[entry.id] = entry.detailLabel;
    if (entry.systemImage) {
      systemImages[entry.id] = entry.systemImage;
    }
    byId[entry.id] = entry;
  }
  return { entries, order, labels, detailLabels, systemImages, byId };
}

/**
 * Raw catalog primitive. This may include untrusted workspace entries and
 * workspace shadows. Security-sensitive or execution-facing callers should
 * prefer `listTrustedChannelPluginCatalogEntries`; use this primitive only when
 * the caller immediately applies trust filtering or explicitly excludes
 * workspace entries.
 *
 * @internal
 */
export function listRawChannelPluginCatalogEntries(
  options: CatalogOptions = {},
): ChannelPluginCatalogEntry[] {
  const manifestEntries = listChannelCatalogEntries({
    workspaceDir: options.workspaceDir,
    env: options.env,
    extraPaths: options.extraPaths,
    installRecords: options.installRecords,
    discovery: options.discovery,
  });
  const resolved = new Map<string, { entry: ChannelPluginCatalogEntry; priority: number }>();
  const rememberCatalogEntry = (entry: ChannelPluginCatalogEntry, priority: number) => {
    const existing = resolved.get(entry.id);
    if (!existing || priority < existing.priority) {
      resolved.set(entry.id, { entry, priority });
    }
  };

  for (const candidate of manifestEntries) {
    if (shouldExcludeCatalogEntry(options, candidate.pluginId, candidate.origin)) {
      continue;
    }
    const entry = buildCatalogEntryFromManifest({
      pluginId: candidate.pluginId,
      packageName: candidate.packageName,
      packageDir: candidate.rootDir,
      origin: candidate.origin,
      workspaceDir: candidate.workspaceDir ?? options.workspaceDir,
      channel: candidate.channel,
      install: candidate.install,
    });
    if (!entry) {
      continue;
    }
    rememberCatalogEntry(entry, ORIGIN_PRIORITY[candidate.origin] ?? 99);
  }

  const rememberExternalCatalogEntries = (
    entries: ExternalCatalogEntry[],
    priority: number,
    trustedSourceLinkedOfficialInstall = false,
  ) => {
    for (const candidate of entries) {
      const entry = buildExternalCatalogEntry(candidate, trustedSourceLinkedOfficialInstall);
      if (entry) {
        rememberCatalogEntry(entry, priority);
      }
    }
  };
  const officialFileEntries = loadCatalogEntriesFromPaths(
    resolveOfficialCatalogPaths(options),
    options.officialCatalogPaths?.length ? undefined : catalogEntriesByPath,
  );
  rememberExternalCatalogEntries(
    [...listOfficialExternalChannelCatalogEntries(), ...officialFileEntries],
    FALLBACK_CATALOG_PRIORITY,
    true,
  );

  const externalCatalogPaths = resolveExternalCatalogPaths(options).map((rawPath) =>
    resolveUserPath(rawPath, options.env ?? process.env),
  );
  const externalEntries = loadCatalogEntriesFromPaths(externalCatalogPaths, catalogEntriesByPath);
  // External catalogs are the supported override seam for shipped fallback
  // metadata, but discovered plugins should still win when they are present.
  rememberExternalCatalogEntries(externalEntries, EXTERNAL_CATALOG_PRIORITY);

  return Array.from(resolved.values())
    .map(({ entry }) => entry)
    .toSorted((a, b) => {
      const orderA = a.meta.order ?? 999;
      const orderB = b.meta.order ?? 999;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      return a.meta.label.localeCompare(b.meta.label);
    });
}

export function getChannelPluginCatalogEntry(
  id: string,
  options: CatalogOptions = {},
): ChannelPluginCatalogEntry | undefined {
  const trimmed = id.trim();
  if (!trimmed) {
    return undefined;
  }
  return listRawChannelPluginCatalogEntries(options).find((entry) => entry.id === trimmed);
}
