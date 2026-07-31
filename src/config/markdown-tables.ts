// Normalizes markdown table configuration by channel and rendering mode.
import { normalizeChannelId } from "../channels/plugins/index.js";
import { listChannelPlugins } from "../channels/plugins/registry.js";
import { getActivePluginChannelRegistryVersion } from "../plugins/runtime.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { ResolveMarkdownTableModeParams } from "./markdown-tables.types.js";
import type { MarkdownTableMode } from "./types.base.js";

type MarkdownConfigEntry = {
  markdown?: {
    tables?: MarkdownTableMode;
  };
};

type MarkdownConfigSection = MarkdownConfigEntry & {
  accounts?: Record<string, MarkdownConfigEntry>;
};

function buildDefaultTableModes(): Map<string, MarkdownTableMode> {
  return new Map(
    listChannelPlugins()
      .flatMap((plugin) => {
        const defaultMarkdownTableMode = plugin.messaging?.defaultMarkdownTableMode;
        return defaultMarkdownTableMode ? [[plugin.id, defaultMarkdownTableMode] as const] : [];
      })
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

let cachedDefaultTableModes: Map<string, MarkdownTableMode> | null = null;
let cachedDefaultTableModesRegistryVersion: number | null = null;

function getDefaultTableModes(): Map<string, MarkdownTableMode> {
  const registryVersion = getActivePluginChannelRegistryVersion();
  if (!cachedDefaultTableModes || cachedDefaultTableModesRegistryVersion !== registryVersion) {
    cachedDefaultTableModes = buildDefaultTableModes();
    cachedDefaultTableModesRegistryVersion = registryVersion;
  }
  return cachedDefaultTableModes;
}

const isMarkdownTableMode = (value: unknown): value is MarkdownTableMode =>
  value === "off" || value === "bullets" || value === "code" || value === "block";

function resolveMarkdownModeFromSection(
  section: MarkdownConfigSection | undefined,
  accountId?: string | null,
): MarkdownTableMode | undefined {
  if (!section) {
    return undefined;
  }
  const normalizedAccountId = normalizeAccountId(accountId);
  const accounts = section.accounts;
  if (accounts && typeof accounts === "object") {
    const match = resolveAccountEntry(accounts, normalizedAccountId);
    const matchMode = match?.markdown?.tables;
    if (isMarkdownTableMode(matchMode)) {
      return matchMode;
    }
  }
  const sectionMode = section.markdown?.tables;
  return isMarkdownTableMode(sectionMode) ? sectionMode : undefined;
}

export function resolveMarkdownTableMode(
  params: ResolveMarkdownTableModeParams,
): MarkdownTableMode {
  const channel = normalizeChannelId(params.channel);
  const defaultMode = channel ? (getDefaultTableModes().get(channel) ?? "code") : "code";
  let resolved = defaultMode;
  if (channel && params.cfg) {
    const channelsConfig = params.cfg.channels as Record<string, unknown> | undefined;
    const rootConfig = params.cfg as Record<string, unknown>;
    const section = (channelsConfig?.[channel] ?? rootConfig[channel]) as
      | MarkdownConfigSection
      | undefined;
    resolved = resolveMarkdownModeFromSection(section, params.accountId) ?? defaultMode;
  }
  return resolved === "block" && !params.supportsBlockTables ? "code" : resolved;
}
