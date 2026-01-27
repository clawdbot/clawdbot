import fs from "node:fs";
import path from "node:path";

import { LEGACY_MANIFEST_KEY } from "../../compat/legacy-names.js";
import { discoverMoltbotPlugins } from "../../plugins/discovery.js";
import type { PluginOrigin } from "../../plugins/types.js";
import type { MoltbotPackageManifest } from "../../plugins/manifest.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import type { ChannelMeta } from "./types.js";

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

export type ChannelPluginCatalogEntry = {
  id: string;
  meta: ChannelMeta;
  install: {
    npmSpec: string;
    localPath?: string;
    defaultChoice?: "npm" | "local";
  };
};

type CatalogOptions = {
  workspaceDir?: string;
  catalogPaths?: string[];
};

const ORIGIN_PRIORITY: Record<PluginOrigin, number> = {
  config: 0,
  workspace: 1,
  global: 2,
  bundled: 3,
};

type ExternalCatalogEntry = {
  name?: string;
  version?: string;
  description?: string;
  moltbot?: MoltbotPackageManifest;
  [LEGACY_MANIFEST_KEY]?: MoltbotPackageManifest;
};

const DEFAULT_CATALOG_PATHS = [
  path.join(CONFIG_DIR, "mpm", "plugins.json"),
  path.join(CONFIG_DIR, "mpm", "catalog.json"),
  path.join(CONFIG_DIR, "plugins", "catalog.json"),
];

const ENV_CATALOG_PATHS = ["CLAWDBOT_PLUGIN_CATALOG_PATHS", "CLAWDBOT_MPM_CATALOG_PATHS"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseCatalogEntries(raw: unknown): ExternalCatalogEntry[] {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is ExternalCatalogEntry => isRecord(entry));
  }
  if (!isRecord(raw)) return [];
  const list = raw.entries ?? raw.packages ?? raw.plugins;
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is ExternalCatalogEntry => isRecord(entry));
}

function splitEnvPaths(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/[;,]/g)
    .flatMap((chunk) => chunk.split(path.delimiter))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveExternalCatalogPaths(options: CatalogOptions): string[] {
  if (options.catalogPaths && options.catalogPaths.length > 0) {
    return options.catalogPaths.map((entry) => entry.trim()).filter(Boolean);
  }
  for (const key of ENV_CATALOG_PATHS) {
    const raw = process.env[key];
    if (raw && raw.trim()) {
      return splitEnvPaths(raw);
    }
  }
  return DEFAULT_CATALOG_PATHS;
}

function loadExternalCatalogEntries(options: CatalogOptions): ExternalCatalogEntry[] {
  const paths = resolveExternalCatalogPaths(options);
  const entries: ExternalCatalogEntry[] = [];
  for (const rawPath of paths) {
    const resolved = resolveUserPath(rawPath);
    if (!fs.existsSync(resolved)) continue;
    try {
      const payload = JSON.parse(fs.readFileSync(resolved, "utf-8")) as unknown;
      entries.push(...parseCatalogEntries(payload));
    } catch {
      // Ignore invalid catalog files.
    }
  }
  return entries;
}

function toChannelMeta(params: {
  channel: NonNullable<MoltbotPackageManifest["channel"]>;
  id: string;
}): ChannelMeta | null {
  const label = params.channel.label?.trim();
  if (!label) return null;
  const selectionLabel = params.channel.selectionLabel?.trim() || label;
  const detailLabel = params.channel.detailLabel?.trim();
  const docsPath = params.channel.docsPath?.trim() || `/channels/${params.id}`;
  const blurb = params.channel.blurb?.trim() || "";
  const systemImage = params.channel.systemImage?.trim();

  return {
    id: params.id,
    label,
    selectionLabel,
    ...(detailLabel ? { detailLabel } : {}),
    docsPath,
    docsLabel: params.channel.docsLabel?.trim() || undefined,
    blurb,
    ...(params.channel.aliases ? { aliases: params.channel.aliases } : {}),
    ...(params.channel.preferOver ? { preferOver: params.channel.preferOver } : {}),
    ...(params.channel.order !== undefined ? { order: params.channel.order } : {}),
    ...(params.channel.selectionDocsPrefix
      ? { selectionDocsPrefix: params.channel.selectionDocsPrefix }
      : {}),
    ...(params.channel.selectionDocsOmitLabel !== undefined
      ? { selectionDocsOmitLabel: params.channel.selectionDocsOmitLabel }
      : {}),
    ...(params.channel.selectionExtras ? { selectionExtras: params.channel.selectionExtras } : {}),
    ...(systemImage ? { systemImage } : {}),
    ...(params.channel.showConfigured !== undefined
      ? { showConfigured: params.channel.showConfigured }
      : {}),
    ...(params.channel.quickstartAllowFrom !== undefined
      ? { quickstartAllowFrom: params.channel.quickstartAllowFrom }
      : {}),
    ...(params.channel.forceAccountBinding !== undefined
      ? { forceAccountBinding: params.channel.forceAccountBinding }
      : {}),
    ...(params.channel.preferSessionLookupForAnnounceTarget !== undefined
      ? {
          preferSessionLookupForAnnounceTarget: params.channel.preferSessionLookupForAnnounceTarget,
        }
      : {}),
  };
}

function resolveInstallInfo(params: {
  manifest: MoltbotPackageManifest;
  packageName?: string;
  packageDir?: string;
  workspaceDir?: string;
}): ChannelPluginCatalogEntry["install"] | null {
  const npmSpec = params.manifest.install?.npmSpec?.trim() ?? params.packageName?.trim();
  if (!npmSpec) return null;
  let localPath = params.manifest.install?.localPath?.trim() || undefined;
  if (!localPath && params.workspaceDir && params.packageDir) {
    localPath = path.relative(params.workspaceDir, params.packageDir) || undefined;
  }
  const defaultChoice = params.manifest.install?.defaultChoice ?? (localPath ? "local" : "npm");
  return {
    npmSpec,
    ...(localPath ? { localPath } : {}),
    ...(defaultChoice ? { defaultChoice } : {}),
  };
}

function buildCatalogEntry(candidate: {
  packageName?: string;
  packageDir?: string;
  workspaceDir?: string;
  packageMoltbot?: MoltbotPackageManifest;
}): ChannelPluginCatalogEntry | null {
  const manifest = candidate.packageMoltbot;
  if (!manifest?.channel) return null;
  const id = manifest.channel.id?.trim();
  if (!id) return null;
  const meta = toChannelMeta({ channel: manifest.channel, id });
  if (!meta) return null;
  const install = resolveInstallInfo({
    manifest,
    packageName: candidate.packageName,
    packageDir: candidate.packageDir,
    workspaceDir: candidate.workspaceDir,
  });
  if (!install) return null;
  return { id, meta, install };
}

function buildExternalCatalogEntry(entry: ExternalCatalogEntry): ChannelPluginCatalogEntry | null {
  const manifest = entry.moltbot ?? entry[LEGACY_MANIFEST_KEY];
  return buildCatalogEntry({
    packageName: entry.name,
    packageMoltbot: manifest,
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
  const discovery = discoverMoltbotPlugins({ workspaceDir: options.workspaceDir });
  const resolved = new Map<string, { entry: ChannelPluginCatalogEntry; priority: number }>();

  for (const candidate of discovery.candidates) {
    const entry = buildCatalogEntry(candidate);
    if (!entry) continue;
    const priority = ORIGIN_PRIORITY[candidate.origin] ?? 99;
    const existing = resolved.get(entry.id);
    if (!existing || priority < existing.priority) {
      resolved.set(entry.id, { entry, priority });
    }
  }

  const externalEntries = loadExternalCatalogEntries(options)
    .map((entry) => buildExternalCatalogEntry(entry))
    .filter((entry): entry is ChannelPluginCatalogEntry => Boolean(entry));
  for (const entry of externalEntries) {
    if (!resolved.has(entry.id)) {
      resolved.set(entry.id, { entry, priority: 99 });
    }
  }

  return Array.from(resolved.values())
    .map(({ entry }) => entry)
    .sort((a, b) => {
      const orderA = a.meta.order ?? 999;
      const orderB = b.meta.order ?? 999;
      if (orderA !== orderB) return orderA - orderB;
      return a.meta.label.localeCompare(b.meta.label);
    });
}

export function getChannelPluginCatalogEntry(
  id: string,
  options: CatalogOptions = {},
): ChannelPluginCatalogEntry | undefined {
  const trimmed = id.trim();
  if (!trimmed) return undefined;
  return listChannelPluginCatalogEntries(options).find((entry) => entry.id === trimmed);
}
