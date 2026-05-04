import fs from "node:fs";
import path from "node:path";
import { MANIFEST_KEY } from "../../compat/legacy-names.js";
import { isPrereleaseSemverVersion, parseRegistryNpmSpec } from "../../infra/npm-registry-spec.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { listChannelCatalogEntries } from "../../plugins/channel-catalog-registry.js";
import {
  describePluginInstallSource,
  type PluginInstallSourceInfo,
} from "../../plugins/install-source-info.js";
import type { OpenClawPackageManifest } from "../../plugins/manifest.js";
import type { PluginPackageChannel, PluginPackageInstall } from "../../plugins/manifest.js";
import { listOfficialExternalChannelCatalogEntries } from "../../plugins/official-external-plugin-catalog.js";
import type { PluginOrigin } from "../../plugins/plugin-origin.types.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
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
  meta: ChannelMeta;
  install: ChannelPluginCatalogInstall;
  installSource?: PluginInstallSourceInfo;
};

type CatalogOptions = {
  workspaceDir?: string;
  catalogPaths?: string[];
  officialCatalogPaths?: string[];
  env?: NodeJS.ProcessEnv;
  excludeWorkspace?: boolean;
};

const ORIGIN_PRIORITY: Record<PluginOrigin, number> = {
  config: 0,
  workspace: 1,
  global: 2,
  bundled: 3,
};

const EXTERNAL_CATALOG_PRIORITY = ORIGIN_PRIORITY.bundled + 1;
const FALLBACK_CATALOG_PRIORITY = EXTERNAL_CATALOG_PRIORITY + 1;

type ExternalCatalogEntry = {
  name?: string;
  version?: string;
  description?: string;
} & Partial<Record<ManifestKey, OpenClawPackageManifest>>;

const ENV_CATALOG_PATHS = ["OPENCLAW_PLUGIN_CATALOG_PATHS", "OPENCLAW_MPM_CATALOG_PATHS"];
const OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH = path.join("dist", "channel-catalog.json");
const officialCatalogEntriesByPath = new Map<string, ExternalCatalogEntry[] | null>();

type ManifestKey = typeof MANIFEST_KEY;

function parseCatalogEntries(raw: unknown): ExternalCatalogEntry[] {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is ExternalCatalogEntry => isRecord(entry));
  }
  if (!isRecord(raw)) {
    return [];
  }
  const list = raw.entries ?? raw.packages ?? raw.plugins;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((entry): entry is ExternalCatalogEntry => isRecord(entry));
}

function splitEnvPaths(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(/[;,]/g)
    .flatMap((chunk) => chunk.split(path.delimiter))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveDefaultCatalogPaths(env: NodeJS.ProcessEnv): string[] {
  const configDir = resolveConfigDir(env);
  return [
    path.join(configDir, "mpm", "plugins.json"),
    path.join(configDir, "mpm", "catalog.json"),
    path.join(configDir, "plugins", "catalog.json"),
  ];
}

function resolveExternalCatalogPaths(options: CatalogOptions): string[] {
  if (options.catalogPaths && options.catalogPaths.length > 0) {
    return options.catalogPaths.map((entry) => entry.trim()).filter(Boolean);
  }
  const env = options.env ?? process.env;
  for (const key of ENV_CATALOG_PATHS) {
    const raw = env[key];
    if (raw && raw.trim()) {
      return splitEnvPaths(raw);
    }
  }
  return resolveDefaultCatalogPaths(env);
}

function loadExternalCatalogEntries(options: CatalogOptions): ExternalCatalogEntry[] {
  const paths = resolveExternalCatalogPaths(options).map((rawPath) =>
    resolveUserPath(rawPath, options.env ?? process.env),
  );
  return loadCatalogEntriesFromPaths(paths);
}

function loadCatalogEntriesFromPaths(paths: Iterable<string>): ExternalCatalogEntry[] {
  const entries: ExternalCatalogEntry[] = [];
  for (const resolvedPath of paths) {
    if (!fs.existsSync(resolvedPath)) {
      continue;
    }
    try {
      const payload = JSON.parse(fs.readFileSync(resolvedPath, "utf-8")) as unknown;
      entries.push(...parseCatalogEntries(payload));
    } catch {
      // Ignore invalid catalog files.
    }
  }
  return entries;
}

function loadOfficialCatalogEntriesFromPaths(paths: Iterable<string>): ExternalCatalogEntry[] {
  const entries: ExternalCatalogEntry[] = [];
  for (const resolvedPath of paths) {
    const cached = officialCatalogEntriesByPath.get(resolvedPath);
    if (cached !== undefined) {
      if (cached) {
        entries.push(...cached);
      }
      continue;
    }
    if (!fs.existsSync(resolvedPath)) {
      officialCatalogEntriesByPath.set(resolvedPath, null);
      continue;
    }
    try {
      const payload = JSON.parse(fs.readFileSync(resolvedPath, "utf-8")) as unknown;
      const parsed = parseCatalogEntries(payload);
      officialCatalogEntriesByPath.set(resolvedPath, parsed);
      entries.push(...parsed);
    } catch {
      officialCatalogEntriesByPath.set(resolvedPath, null);
    }
  }
  return entries;
}

function resolveOfficialCatalogPaths(options: CatalogOptions): string[] {
  if (options.officialCatalogPaths && options.officialCatalogPaths.length > 0) {
    return options.officialCatalogPaths.map((entry) => entry.trim()).filter(Boolean);
  }

  const packageRoots = [
    resolveOpenClawPackageRootSync({ cwd: process.cwd() }),
    resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url }),
  ].filter((entry, index, all): entry is string => Boolean(entry) && all.indexOf(entry) === index);

  const candidates = packageRoots.map((packageRoot) =>
    path.join(packageRoot, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH),
  );

  if (process.execPath) {
    const execDir = path.dirname(process.execPath);
    candidates.push(path.join(execDir, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH));
    candidates.push(path.join(execDir, "channel-catalog.json"));
  }

  return candidates.filter((entry, index, all) => entry && all.indexOf(entry) === index);
}

function loadOfficialCatalogEntries(options: CatalogOptions): ChannelPluginCatalogEntry[] {
  const builtInEntries = listOfficialExternalChannelCatalogEntries();
  const officialPaths = resolveOfficialCatalogPaths(options);
  const fileEntries =
    options.officialCatalogPaths && options.officialCatalogPaths.length > 0
      ? loadCatalogEntriesFromPaths(officialPaths)
      : loadOfficialCatalogEntriesFromPaths(officialPaths);
  return [...builtInEntries, ...fileEntries]
    .map((entry) => buildExternalCatalogEntry(entry, { trustedSourceLinkedOfficialInstall: true }))
    .filter((entry): entry is ChannelPluginCatalogEntry => Boolean(entry));
}

function toChannelMeta(params: {
  channel: NonNullable<OpenClawPackageManifest["channel"]>;
  id: string;
}): ChannelMeta | null {
  const label = params.channel.label?.trim();
  if (!label) {
    return null;
  }
  const selectionLabel = params.channel.selectionLabel?.trim() || label;
  const detailLabel = params.channel.detailLabel?.trim();
  const docsPath = params.channel.docsPath?.trim() || `/channels/${params.id}`;
  const blurb = params.channel.blurb?.trim() || "";
  const systemImage = params.channel.systemImage?.trim();

  return buildManifestChannelMeta({
    id: params.id,
    channel: params.channel,
    label,
    selectionLabel,
    docsPath,
    docsLabel: normalizeOptionalString(params.channel.docsLabel),
    blurb,
    detailLabel,
    ...(systemImage ? { systemImage } : {}),
    arrayFieldMode: "defined",
    selectionDocsPrefixMode: "truthy",
  });
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
  const defaultChoice: NonNullable<PluginPackageInstall["defaultChoice"]> =
    requestedDefaultChoice === "clawhub" && clawhubSpec
      ? "clawhub"
      : requestedDefaultChoice === "npm" && npmSpec
        ? "npm"
        : requestedDefaultChoice === "local" && localPath
          ? "local"
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
  if (!params.channel) {
    return null;
  }
  const id = params.channel.id?.trim();
  if (!id) {
    return null;
  }
  const meta = toChannelMeta({ channel: params.channel, id });
  if (!meta) {
    return null;
  }
  const install = resolveInstallInfo({
    install: params.install,
    packageName: params.packageName,
    packageVersion: params.packageVersion,
    packageDir: params.packageDir,
    workspaceDir: params.workspaceDir,
  });
  if (!install) {
    return null;
  }
  const pluginId = normalizeOptionalString(params.pluginId);
  return {
    id,
    ...(pluginId ? { pluginId } : {}),
    ...(params.origin ? { origin: params.origin } : {}),
    ...(params.trustedSourceLinkedOfficialInstall
      ? { trustedSourceLinkedOfficialInstall: true }
      : {}),
    meta,
    install,
    installSource: describePluginInstallSource(install, {
      expectedPackageName: params.packageName,
    }),
  };
}

function buildExternalCatalogEntry(
  entry: ExternalCatalogEntry,
  options?: {
    trustedSourceLinkedOfficialInstall?: boolean;
  },
): ChannelPluginCatalogEntry | null {
  const manifest = entry[MANIFEST_KEY];
  return buildCatalogEntryFromManifest({
    pluginId: manifest?.plugin?.id,
    packageName: entry.name,
    packageVersion: entry.version,
    trustedSourceLinkedOfficialInstall: options?.trustedSourceLinkedOfficialInstall,
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

export function listChannelPluginCatalogEntries(
  options: CatalogOptions = {},
): ChannelPluginCatalogEntry[] {
  const manifestEntries = listChannelCatalogEntries({
    workspaceDir: options.workspaceDir,
    env: options.env,
  });
  const resolved = new Map<string, { entry: ChannelPluginCatalogEntry; priority: number }>();

  for (const candidate of manifestEntries) {
    if (options.excludeWorkspace && candidate.origin === "workspace") {
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
    const priority = ORIGIN_PRIORITY[candidate.origin] ?? 99;
    const existing = resolved.get(entry.id);
    if (!existing || priority < existing.priority) {
      resolved.set(entry.id, { entry, priority });
    }
  }

  for (const entry of loadOfficialCatalogEntries(options)) {
    const priority = FALLBACK_CATALOG_PRIORITY;
    const existing = resolved.get(entry.id);
    if (!existing || priority < existing.priority) {
      resolved.set(entry.id, { entry, priority });
    }
  }

  const externalEntries = loadExternalCatalogEntries(options)
    .map((entry) => buildExternalCatalogEntry(entry))
    .filter((entry): entry is ChannelPluginCatalogEntry => Boolean(entry));
  for (const entry of externalEntries) {
    // External catalogs are the supported override seam for shipped fallback
    // metadata, but discovered plugins should still win when they are present.
    const priority = EXTERNAL_CATALOG_PRIORITY;
    const existing = resolved.get(entry.id);
    if (!existing || priority < existing.priority) {
      resolved.set(entry.id, { entry, priority });
    }
  }

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
  return listChannelPluginCatalogEntries(options).find((entry) => entry.id === trimmed);
}
