/**
 * Bundled channel catalog reader.
 *
 * Loads channel metadata from generated package catalogs and bundled plugin package manifests.
 */
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import type { PluginPackageChannel } from "../plugins/manifest.js";
import { BUNDLED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_ENTRIES } from "../plugins/official-external-plugin-bundled-catalogs.js";
import {
  readPluginCacheDirectory,
  readPluginCacheJsonFile,
} from "../plugins/plugin-cache-files.js";
import { getPluginCache } from "../plugins/plugin-cache.js";
import type { BundledChannelCatalogEntry } from "./bundled-channel-catalog.types.js";

type ChannelCatalogEntryLike = {
  openclaw?: {
    channel?: PluginPackageChannel;
  };
};

const OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH = path.join("dist", "channel-catalog.json");

function listPackageRoots(): string[] {
  // Source checkouts and packaged installs can resolve OpenClaw from different roots; scan both
  // once so channel metadata works in dev, linked packages, and published CLI layouts.
  return uniqueStrings(
    [
      resolveOpenClawPackageRootSync({ cwd: process.cwd() }),
      resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url }),
    ].filter((entry): entry is string => Boolean(entry)),
  );
}

function readBundledExtensionCatalogEntriesSync(
  pluginsDir: string | undefined,
): ChannelCatalogEntryLike[] {
  if (!pluginsDir) {
    return [];
  }
  try {
    return readPluginCacheDirectory(pluginsDir)
      .filter((entry) => entry.isDirectory())
      .flatMap((entry): ChannelCatalogEntryLike[] => {
        const packageJsonPath = path.join(pluginsDir, entry.name, "package.json");
        const parsed = readPluginCacheJsonFile(packageJsonPath);
        return parsed.ok && isRecord(parsed.value) ? [parsed.value] : [];
      });
  } catch {
    return [];
  }
}

function readOfficialCatalogFileSync(): ChannelCatalogEntryLike[] {
  const bundledExternalEntries = BUNDLED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_ENTRIES.filter(
    (entry): entry is ChannelCatalogEntryLike => typeof entry === "object" && entry !== null,
  );
  for (const packageRoot of listPackageRoots()) {
    const candidate = path.join(packageRoot, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH);
    const payload = readPluginCacheJsonFile(candidate);
    if (payload.ok && isRecord(payload.value)) {
      const entries = Array.isArray(payload.value.entries)
        ? payload.value.entries.filter((entry): entry is ChannelCatalogEntryLike => isRecord(entry))
        : [];
      // The source catalog is available before dist/channel-catalog.json exists and carries
      // promotion metadata for external channels. Keep it first so a stale local dist artifact
      // cannot hide current metadata; the generated dist catalog still contributes bundled rows.
      return [...bundledExternalEntries, ...entries];
    }
  }
  return bundledExternalEntries;
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

/**
 * Lists bundled channel catalog entries from package manifests and generated catalog files.
 */
export function listBundledChannelCatalogEntries(): BundledChannelCatalogEntry[] {
  const pluginsDir = resolveBundledPluginsDir();
  const catalogs = getPluginCache().metadata.bundledChannelCatalogs;
  const key = JSON.stringify([process.cwd(), pluginsDir]);
  const cached = catalogs.get(key);
  if (cached) {
    return cached;
  }
  const entries = new Map<string, BundledChannelCatalogEntry>();
  for (const entry of readBundledExtensionCatalogEntriesSync(pluginsDir)) {
    const channelEntry = toBundledChannelEntry(entry);
    if (channelEntry) {
      entries.set(channelEntry.id, channelEntry);
    }
  }
  for (const entry of readOfficialCatalogFileSync()) {
    const channelEntry = toBundledChannelEntry(entry);
    if (channelEntry) {
      // Package manifests win over the generated catalog when both describe the same id.
      entries.set(channelEntry.id, entries.get(channelEntry.id) ?? channelEntry);
    }
  }
  const catalog = Array.from(entries.values()).toSorted(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
  catalogs.set(key, catalog);
  return catalog;
}

/** Finds bundled or generated channel metadata by id or alias. */
export function findBundledChannelCatalogMetadata(
  channelId: string,
): PluginPackageChannel | undefined {
  const normalized = normalizeOptionalLowercaseString(channelId);
  if (!normalized) {
    return undefined;
  }
  return listBundledChannelCatalogEntries().find(
    (entry) => entry.id === normalized || entry.aliases.includes(normalized),
  )?.channel;
}
