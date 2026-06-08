// Shared doctor dispatcher for channel plugin repair, warning, and compatibility adapters.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  getBundledChannelPlugin,
  getBundledChannelSetupPlugin,
} from "../../../channels/plugins/bundled.js";
import { resolveReadOnlyChannelPluginsForConfig } from "../../../channels/plugins/read-only.js";
import { getLoadedChannelPlugin } from "../../../channels/plugins/registry.js";
import type {
  ChannelDoctorAdapter,
  ChannelDoctorConfigMutation,
  ChannelDoctorEmptyAllowlistAccountContext,
  ChannelDoctorSequenceResult,
} from "../../../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

type ChannelDoctorEntry = {
  doctor: ChannelDoctorAdapter;
};

type ChannelDoctorPluginCandidate = {
  id: string;
  doctor?: ChannelDoctorAdapter;
};

type ChannelDoctorLookupContext = {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

type ChannelDoctorEmptyAllowlistLookupParams = ChannelDoctorEmptyAllowlistAccountContext & {
  cfg?: OpenClawConfig;
};

const channelDoctorFunctionKeys = new Set<keyof ChannelDoctorAdapter>([
  "normalizeCompatibilityConfig",
  "collectPreviewWarnings",
  "collectMutableAllowlistWarnings",
  "repairConfig",
  "runConfigSequence",
  "cleanStaleConfig",
  "collectEmptyAllowlistExtraWarnings",
  "shouldSkipDefaultEmptyGroupAllowlistWarning",
]);

const channelDoctorBooleanKeys = new Set<keyof ChannelDoctorAdapter>([
  "groupAllowFromFallbackToAllowFrom",
  "warnOnEmptyGroupSenderAllowlist",
]);

const channelDoctorEnumValues: Partial<Record<keyof ChannelDoctorAdapter, ReadonlySet<string>>> = {
  dmAllowFromMode: new Set(["topOnly", "topOrNested", "nestedOnly"]),
  groupModel: new Set(["sender", "route", "hybrid"]),
};

export type ChannelDoctorEmptyAllowlistPolicyHooks = {
  /** Collect plugin-specific warning lines for a configured channel/account allowlist. */
  extraWarningsForAccount: (params: ChannelDoctorEmptyAllowlistAccountContext) => string[];
  /** Let a channel doctor suppress the generic empty group-allowlist warning. */
  shouldSkipDefaultEmptyGroupAllowlistWarning: (
    params: ChannelDoctorEmptyAllowlistAccountContext,
  ) => boolean;
};

function collectConfiguredChannelIds(cfg: OpenClawConfig): string[] {
  if (cfg.plugins?.enabled === false) {
    return [];
  }
  const channels =
    cfg.channels && typeof cfg.channels === "object" && !Array.isArray(cfg.channels)
      ? cfg.channels
      : null;
  if (!channels) {
    return [];
  }
  const channelEntries = channels as Record<string, unknown>;
  return Object.keys(channels)
    .filter((channelId) => {
      if (channelId === "defaults") {
        return false;
      }
      if (isChannelDoctorBlockedByConfig(channelId, cfg)) {
        return false;
      }
      const entry = channelEntries[channelId];
      return (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        (entry as { enabled?: unknown }).enabled !== false
      );
    })
    .toSorted();
}

function isChannelDoctorBlockedByConfig(channelId: string, cfg: OpenClawConfig): boolean {
  if (cfg.plugins?.enabled === false) {
    return true;
  }
  const normalizedChannelId = normalizeOptionalLowercaseString(channelId) ?? channelId;
  if (cfg.plugins?.entries?.[normalizedChannelId]?.enabled === false) {
    return true;
  }
  const channelEntry = (cfg.channels as Record<string, unknown> | undefined)?.[normalizedChannelId];
  return (
    Boolean(channelEntry && typeof channelEntry === "object" && !Array.isArray(channelEntry)) &&
    (channelEntry as { enabled?: unknown }).enabled === false
  );
}

function safeGetLoadedChannelPlugin(id: string) {
  try {
    return getLoadedChannelPlugin(id);
  } catch {
    return undefined;
  }
}

function safeGetBundledChannelSetupPlugin(id: string) {
  try {
    return getBundledChannelSetupPlugin(id);
  } catch {
    return undefined;
  }
}

function safeGetBundledChannelPlugin(id: string) {
  try {
    return getBundledChannelPlugin(id);
  } catch {
    return undefined;
  }
}

function safeListReadOnlyChannelPlugins(context: ChannelDoctorLookupContext) {
  try {
    return resolveReadOnlyChannelPluginsForConfig(context.cfg, {
      ...(context.env ? { env: context.env } : {}),
      includePersistedAuthState: false,
      includeSetupFallbackPlugins: true,
    }).plugins;
  } catch {
    return [];
  }
}

function listReadOnlyChannelPluginsById(
  context: ChannelDoctorLookupContext,
): Map<string, ChannelDoctorPluginCandidate> {
  return new Map(safeListReadOnlyChannelPlugins(context).map((plugin) => [plugin.id, plugin]));
}

function mergeDoctorAdapters(
  adapters: Array<ChannelDoctorAdapter | undefined>,
): ChannelDoctorAdapter | undefined {
  const merged: Partial<Record<keyof ChannelDoctorAdapter, unknown>> = {};
  for (const adapter of adapters) {
    if (!adapter) {
      continue;
    }
    for (const [key, value] of Object.entries(adapter) as Array<
      [keyof ChannelDoctorAdapter, unknown]
    >) {
      // Earlier adapters win so read-only installed plugins can override bundled fallbacks.
      if (merged[key] !== undefined) {
        continue;
      }
      if (!isValidChannelDoctorAdapterValue(key, value)) {
        continue;
      }
      merged[key] = value;
    }
  }
  return Object.keys(merged).length > 0 ? (merged as ChannelDoctorAdapter) : undefined;
}

function isValidChannelDoctorAdapterValue(
  key: keyof ChannelDoctorAdapter,
  value: unknown,
): boolean {
  if (value == null) {
    return false;
  }
  if (channelDoctorFunctionKeys.has(key)) {
    return typeof value === "function";
  }
  if (channelDoctorBooleanKeys.has(key)) {
    return typeof value === "boolean";
  }
  const enumValues = channelDoctorEnumValues[key];
  if (enumValues) {
    return typeof value === "string" && enumValues.has(value);
  }
  if (key === "legacyConfigRules") {
    return Array.isArray(value);
  }
  return false;
}

function listChannelDoctorEntries(
  channelIds: readonly string[],
  context: ChannelDoctorLookupContext,
  options: {
    readOnlyPluginsById?: ReadonlyMap<string, ChannelDoctorPluginCandidate>;
  } = {},
): ChannelDoctorEntry[] {
  if (channelIds.length === 0) {
    return [];
  }
  const selectedIds = new Set(
    channelIds.filter((id) => !isChannelDoctorBlockedByConfig(id, context.cfg)),
  );
  if (selectedIds.size === 0) {
    return [];
  }
  const readOnlyPluginsById =
    options.readOnlyPluginsById ?? listReadOnlyChannelPluginsById(context);

  const entries: ChannelDoctorEntry[] = [];
  for (const id of selectedIds) {
    const doctor = mergeDoctorAdapters([
      readOnlyPluginsById.get(id)?.doctor,
      safeGetLoadedChannelPlugin(id)?.doctor,
      safeGetBundledChannelSetupPlugin(id)?.doctor,
      safeGetBundledChannelPlugin(id)?.doctor,
    ]);
    if (!doctor) {
      continue;
    }
    entries.push({ doctor });
  }
  return entries;
}

function toPluginEmptyAllowlistContext({
  cfg: _cfg,
  ...params
}: ChannelDoctorEmptyAllowlistLookupParams): ChannelDoctorEmptyAllowlistAccountContext {
  return params;
}

function collectEmptyAllowlistExtraWarningsForEntries(
  entries: readonly ChannelDoctorEntry[],
  params: ChannelDoctorEmptyAllowlistLookupParams,
): string[] {
  const warnings: string[] = [];
  const pluginParams = toPluginEmptyAllowlistContext(params);
  for (const entry of entries) {
    const lines = entry.doctor.collectEmptyAllowlistExtraWarnings?.(pluginParams);
    if (lines?.length) {
      warnings.push(...lines);
    }
  }
  return warnings;
}

function shouldSkipDefaultEmptyGroupAllowlistWarningForEntries(
  entries: readonly ChannelDoctorEntry[],
  params: ChannelDoctorEmptyAllowlistLookupParams,
): boolean {
  const pluginParams = toPluginEmptyAllowlistContext(params);
  return entries.some(
    (entry) => entry.doctor.shouldSkipDefaultEmptyGroupAllowlistWarning?.(pluginParams) === true,
  );
}

/** Build cached empty-allowlist hooks backed by channel doctor adapters. */
export function createChannelDoctorEmptyAllowlistPolicyHooks(
  context: ChannelDoctorLookupContext,
): ChannelDoctorEmptyAllowlistPolicyHooks {
  const readOnlyPluginsById = listReadOnlyChannelPluginsById(context);
  const entriesByChannel = new Map<string, ChannelDoctorEntry[]>();
  const entriesForChannel = (channelName: string) => {
    const existing = entriesByChannel.get(channelName);
    if (existing) {
      return existing;
    }
    const entries = listChannelDoctorEntries([channelName], context, { readOnlyPluginsById });
    entriesByChannel.set(channelName, entries);
    return entries;
  };
  return {
    extraWarningsForAccount: (params) =>
      collectEmptyAllowlistExtraWarningsForEntries(entriesForChannel(params.channelName), params),
    shouldSkipDefaultEmptyGroupAllowlistWarning: (params) =>
      shouldSkipDefaultEmptyGroupAllowlistWarningForEntries(
        entriesForChannel(params.channelName),
        params,
      ),
  };
}

/** Run interactive/non-interactive channel setup repair sequences and collect notes. */
export async function runChannelDoctorConfigSequences(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  shouldRepair: boolean;
}): Promise<ChannelDoctorSequenceResult> {
  const changeNotes: string[] = [];
  const warningNotes: string[] = [];
  for (const entry of listChannelDoctorEntries(collectConfiguredChannelIds(params.cfg), {
    cfg: params.cfg,
    env: params.env,
  })) {
    const result = await entry.doctor.runConfigSequence?.(params);
    if (!result) {
      continue;
    }
    changeNotes.push(...result.changeNotes);
    warningNotes.push(...result.warningNotes);
  }
  return { changeNotes, warningNotes };
}

/** Collect compatibility migrations from configured channel doctor adapters in order. */
export function collectChannelDoctorCompatibilityMutations(
  cfg: OpenClawConfig,
  options: { env?: NodeJS.ProcessEnv } = {},
): ChannelDoctorConfigMutation[] {
  const channelIds = collectConfiguredChannelIds(cfg);
  if (channelIds.length === 0) {
    return [];
  }
  const mutations: ChannelDoctorConfigMutation[] = [];
  let nextCfg = cfg;
  for (const entry of listChannelDoctorEntries(channelIds, { cfg, env: options.env })) {
    const mutation = entry.doctor.normalizeCompatibilityConfig?.({ cfg: nextCfg });
    if (!mutation || mutation.changes.length === 0) {
      continue;
    }
    mutations.push(mutation);
    nextCfg = mutation.config;
  }
  return mutations;
}

/** Collect stale channel config cleanup mutations from configured channel doctor adapters. */
export async function collectChannelDoctorStaleConfigMutations(
  cfg: OpenClawConfig,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<ChannelDoctorConfigMutation[]> {
  const mutations: ChannelDoctorConfigMutation[] = [];
  let nextCfg = cfg;
  for (const entry of listChannelDoctorEntries(collectConfiguredChannelIds(cfg), {
    cfg,
    env: options.env,
  })) {
    const mutation = await entry.doctor.cleanStaleConfig?.({ cfg: nextCfg });
    if (!mutation || mutation.changes.length === 0) {
      continue;
    }
    mutations.push(mutation);
    nextCfg = mutation.config;
  }
  return mutations;
}

/** Collect channel-specific doctor preview warnings for configured channels. */
export async function collectChannelDoctorPreviewWarnings(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const warnings: string[] = [];
  for (const entry of listChannelDoctorEntries(collectConfiguredChannelIds(params.cfg), {
    cfg: params.cfg,
    env: params.env,
  })) {
    const lines = await entry.doctor.collectPreviewWarnings?.(params);
    if (lines?.length) {
      warnings.push(...lines);
    }
  }
  return warnings;
}

/** Collect warnings for mutable channel allowlists that doctor cannot safely edit. */
export async function collectChannelDoctorMutableAllowlistWarnings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const warnings: string[] = [];
  for (const entry of listChannelDoctorEntries(collectConfiguredChannelIds(params.cfg), {
    cfg: params.cfg,
    env: params.env,
  })) {
    const lines = await entry.doctor.collectMutableAllowlistWarnings?.(params);
    if (lines?.length) {
      warnings.push(...lines);
    }
  }
  return warnings;
}

/** Collect channel repair mutations and warning-only repair results from doctor adapters. */
export async function collectChannelDoctorRepairMutations(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ChannelDoctorConfigMutation[]> {
  const mutations: ChannelDoctorConfigMutation[] = [];
  let nextCfg = params.cfg;
  for (const entry of listChannelDoctorEntries(collectConfiguredChannelIds(params.cfg), {
    cfg: params.cfg,
    env: params.env,
  })) {
    const mutation = await entry.doctor.repairConfig?.({
      cfg: nextCfg,
      doctorFixCommand: params.doctorFixCommand,
      ...(params.env ? { env: params.env } : {}),
    });
    if (!mutation || mutation.changes.length === 0) {
      if (mutation?.warnings?.length) {
        mutations.push({ config: nextCfg, changes: [], warnings: mutation.warnings });
      }
      continue;
    }
    mutations.push(mutation);
    nextCfg = mutation.config;
  }
  return mutations;
}

/** Collect plugin-provided empty allowlist warning lines for one channel/account context. */
export function collectChannelDoctorEmptyAllowlistExtraWarnings(
  params: ChannelDoctorEmptyAllowlistLookupParams,
): string[] {
  return collectEmptyAllowlistExtraWarningsForEntries(
    listChannelDoctorEntries([params.channelName], {
      cfg: params.cfg ?? {},
    }),
    params,
  );
}

/** Return true when a channel doctor owns empty group-allowlist warning behavior. */
export function shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning(
  params: ChannelDoctorEmptyAllowlistLookupParams,
): boolean {
  return shouldSkipDefaultEmptyGroupAllowlistWarningForEntries(
    listChannelDoctorEntries([params.channelName], {
      cfg: params.cfg ?? {},
    }),
    params,
  );
}
