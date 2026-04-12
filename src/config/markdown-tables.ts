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

const EMPTY_DEFAULT_TABLE_MODES = new Map<string, MarkdownTableMode>();

function bindDefaultTableModesMethod<TValue>(value: TValue): TValue {
  if (typeof value !== "function") {
    return value;
  }
  return value.bind(getDefaultTableModes()) as TValue;
}

export const DEFAULT_TABLE_MODES: ReadonlyMap<string, MarkdownTableMode> = new Proxy(
  EMPTY_DEFAULT_TABLE_MODES,
  {
    get(_target, prop, _receiver) {
      return bindDefaultTableModesMethod(Reflect.get(getDefaultTableModes(), prop));
    },
  },
);

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

export type {
  ResolveMarkdownTableMode,
  ResolveMarkdownTableModeParams,
} from "./markdown-tables.types.js";

export function resolveMarkdownTableMode(
  params: ResolveMarkdownTableModeParams,
): MarkdownTableMode {
  const channel = normalizeChannelId(params.channel);
  const defaultMode = channel ? (getDefaultTableModes().get(channel) ?? "code") : "code";
  if (!channel || !params.cfg) {
    return defaultMode;
  }
  const channelsConfig = params.cfg.channels as Record<string, unknown> | undefined;
  const section = (channelsConfig?.[channel] ??
    (params.cfg as Record<string, unknown> | undefined)?.[channel]) as
    | MarkdownConfigSection
    | undefined;
  const resolved = resolveMarkdownModeFromSection(section, params.accountId) ?? defaultMode;
  // "block" stays schema-valid for the shared markdown seam, but this PR
  // keeps runtime delivery on safe text rendering until Slack send support lands.
  return resolved === "block" ? "code" : resolved;
}
