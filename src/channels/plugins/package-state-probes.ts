import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  listChannelCatalogEntries,
  type PluginChannelCatalogEntry,
} from "../../plugins/channel-catalog-registry.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  isJavaScriptModulePath,
  loadChannelPluginModule,
  resolveExistingPluginModulePath,
} from "./module-loader.js";

type ChannelPackageStateChecker = (params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}) => boolean;

type ChannelPackageStateMetadata = {
  specifier?: string;
  exportName?: string;
};

export type ChannelPackageStateMetadataKey = "configuredState" | "persistedAuthState";

const log = createSubsystemLogger("channels");

function resolveChannelPackageStateMetadata(
  entry: PluginChannelCatalogEntry,
  metadataKey: ChannelPackageStateMetadataKey,
): ChannelPackageStateMetadata | null {
  const metadata = entry.channel[metadataKey];
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const specifier = normalizeOptionalString(metadata.specifier) ?? "";
  const exportName = normalizeOptionalString(metadata.exportName) ?? "";
  if (!specifier || !exportName) {
    return null;
  }
  return { specifier, exportName };
}

function listChannelPackageStateCatalog(
  metadataKey: ChannelPackageStateMetadataKey,
): PluginChannelCatalogEntry[] {
  return listChannelCatalogEntries({ origin: "bundled" }).filter((entry) =>
    Boolean(resolveChannelPackageStateMetadata(entry, metadataKey)),
  );
}

function resolveChannelPackageStateChecker(params: {
  entry: PluginChannelCatalogEntry;
  metadataKey: ChannelPackageStateMetadataKey;
}): ChannelPackageStateChecker | null {
  const metadata = resolveChannelPackageStateMetadata(params.entry, params.metadataKey);
  if (!metadata) {
    return null;
  }

  try {
    const moduleExport = loadChannelPluginModule({
      modulePath: resolveExistingPluginModulePath(params.entry.rootDir, metadata.specifier!),
      rootDir: params.entry.rootDir,
      shouldTryNativeRequire: isJavaScriptModulePath,
    }) as Record<string, unknown>;
    const checker = moduleExport[metadata.exportName!] as ChannelPackageStateChecker | undefined;
    if (typeof checker !== "function") {
      throw new Error(`missing ${params.metadataKey} export ${metadata.exportName}`);
    }
    return checker;
  } catch (error) {
    const detail = formatErrorMessage(error);
    log.warn(
      `[channels] failed to load ${params.metadataKey} checker for ${params.entry.pluginId}: ${detail}`,
    );
    return null;
  }
}

export function listBundledChannelIdsForPackageState(
  metadataKey: ChannelPackageStateMetadataKey,
): string[] {
  return listChannelPackageStateCatalog(metadataKey).map((entry) => entry.pluginId);
}

export function hasBundledChannelPackageState(params: {
  metadataKey: ChannelPackageStateMetadataKey;
  channelId: string;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const entry = listChannelPackageStateCatalog(params.metadataKey).find(
    (candidate) => candidate.pluginId === params.channelId,
  );
  if (!entry) {
    return false;
  }
  const checker = resolveChannelPackageStateChecker({
    entry,
    metadataKey: params.metadataKey,
  });
  return checker ? checker({ cfg: params.cfg, env: params.env }) : false;
}
