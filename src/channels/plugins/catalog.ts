import path from "node:path";

import { discoverClawdbotPlugins } from "../../plugins/discovery.js";
import type { PluginOrigin } from "../../plugins/types.js";
import type { ClawdbotPackageManifest } from "../../plugins/manifest.js";
import type { ChannelMeta } from "./types.js";

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
};

const ORIGIN_PRIORITY: Record<PluginOrigin, number> = {
  config: 0,
  workspace: 1,
  global: 2,
  bundled: 3,
};

function toChannelMeta(params: {
  channel: NonNullable<ClawdbotPackageManifest["channel"]>;
  id: string;
}): ChannelMeta | null {
  const label = params.channel.label?.trim();
  if (!label) return null;
  const selectionLabel = params.channel.selectionLabel?.trim() || label;
  const docsPath = params.channel.docsPath?.trim() || `/channels/${params.id}`;
  const blurb = params.channel.blurb?.trim() || "";

  return {
    id: params.id,
    label,
    selectionLabel,
    docsPath,
    docsLabel: params.channel.docsLabel?.trim() || undefined,
    blurb,
    ...(params.channel.aliases ? { aliases: params.channel.aliases } : {}),
    ...(params.channel.order !== undefined ? { order: params.channel.order } : {}),
    ...(params.channel.selectionDocsPrefix
      ? { selectionDocsPrefix: params.channel.selectionDocsPrefix }
      : {}),
    ...(params.channel.selectionDocsOmitLabel !== undefined
      ? { selectionDocsOmitLabel: params.channel.selectionDocsOmitLabel }
      : {}),
    ...(params.channel.selectionExtras ? { selectionExtras: params.channel.selectionExtras } : {}),
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
  manifest: ClawdbotPackageManifest;
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
  packageClawdbot?: ClawdbotPackageManifest;
}): ChannelPluginCatalogEntry | null {
  const manifest = candidate.packageClawdbot;
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

export function listChannelPluginCatalogEntries(
  options: CatalogOptions = {},
): ChannelPluginCatalogEntry[] {
  const discovery = discoverClawdbotPlugins({ workspaceDir: options.workspaceDir });
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
