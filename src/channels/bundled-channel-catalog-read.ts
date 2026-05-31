import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { tryReadJsonSync } from "../infra/json-files.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import type { PluginPackageChannel } from "../plugins/manifest.js";

type ChannelCatalogEntryLike = {
  openclaw?: {
    channel?: PluginPackageChannel;
  };
};

type BundledChannelCatalogEntry = {
  id: string;
  channel: PluginPackageChannel;
  aliases: readonly string[];
  order: number;
};

const OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH = path.join("dist", "channel-catalog.json");
const officialCatalogFileCache = new Map<string, ChannelCatalogEntryLike[] | null>();
const bundledPackageCatalogCache = new Map<string, ChannelCatalogEntryLike[] | null>();

function listPackageRoots(): string[] {
  return uniqueStrings(
    [
      resolveOpenClawPackageRootSync({ cwd: process.cwd() }),
      resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url }),
    ].filter((entry): entry is string => Boolean(entry)),
  );
}

function readBundledExtensionCatalogEntriesSync(): ChannelCatalogEntryLike[] {
  const pluginsDir = resolveBundledPluginsDir();
  if (!pluginsDir) {
    return [];
  }
  const cached = bundledPackageCatalogCache.get(pluginsDir);
  if (cached !== undefined) {
    return cached ?? [];
  }
  try {
    const entries = fs
      .readdirSync(pluginsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry): ChannelCatalogEntryLike[] => {
        const packageJsonPath = path.join(pluginsDir, entry.name, "package.json");
        const parsed = tryReadJsonSync<ChannelCatalogEntryLike>(packageJsonPath);
        return parsed ? [parsed] : [];
      });
    bundledPackageCatalogCache.set(pluginsDir, entries);
    return entries;
  } catch {
    bundledPackageCatalogCache.set(pluginsDir, null);
    return [];
  }
}

function readOfficialCatalogFileSync(): ChannelCatalogEntryLike[] {
  for (const packageRoot of listPackageRoots()) {
    const candidate = path.join(packageRoot, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH);
    const cached = officialCatalogFileCache.get(candidate);
    if (cached !== undefined) {
      if (cached) {
        return cached;
      }
      continue;
    }
    if (!fs.existsSync(candidate)) {
      officialCatalogFileCache.set(candidate, null);
      continue;
    }
    const payload = tryReadJsonSync<{ entries?: unknown }>(candidate);
    if (payload) {
      const entries = Array.isArray(payload.entries)
        ? (payload.entries as ChannelCatalogEntryLike[])
        : [];
      officialCatalogFileCache.set(candidate, entries);
      return entries;
    }
    officialCatalogFileCache.set(candidate, null);
  }
  return [];
}

function isChannelCatalogEntryLike(
  entry: ChannelCatalogEntryLike | PluginPackageChannel,
): entry is ChannelCatalogEntryLike {
  return "openclaw" in entry;
}

function toBundledChannelEntry(
  entry: ChannelCatalogEntryLike | PluginPackageChannel,
): BundledChannelCatalogEntry | null {
  const channel: PluginPackageChannel | undefined = isChannelCatalogEntryLike(entry)
    ? entry.openclaw?.channel
    : entry;
  const id = normalizeOptionalLowercaseString(channel?.id);
  if (!id || !channel) {
    return null;
  }
  const aliases = Array.isArray(channel.aliases)
    ? channel.aliases
        .map((alias) => normalizeOptionalLowercaseString(alias))
        .filter((alias): alias is string => Boolean(alias))
    : [];
  const order =
    typeof channel.order === "number" && Number.isFinite(channel.order)
      ? channel.order
      : Number.MAX_SAFE_INTEGER;
  return {
    id,
    channel,
    aliases,
    order,
  };
}

export function listBundledChannelCatalogEntries(): BundledChannelCatalogEntry[] {
  const entries = new Map<string, BundledChannelCatalogEntry>();
  for (const entry of readBundledExtensionCatalogEntriesSync()) {
    const channelEntry = toBundledChannelEntry(entry);
    if (channelEntry) {
      entries.set(channelEntry.id, channelEntry);
    }
  }
  for (const entry of readOfficialCatalogFileSync()) {
    const channelEntry = toBundledChannelEntry(entry);
    if (channelEntry) {
      entries.set(channelEntry.id, entries.get(channelEntry.id) ?? channelEntry);
    }
  }
  if (entries.size === 0) {
    return [];
  }
  return Array.from(entries.values()).toSorted(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
}
