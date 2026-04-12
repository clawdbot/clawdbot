import {
  getBundledChannelPlugin,
  listBundledChannelPlugins,
} from "../../../channels/plugins/bundled.js";
import { getChannelPlugin, listChannelPlugins } from "../../../channels/plugins/registry.js";
import type {
  ChannelDoctorAdapter,
  ChannelDoctorConfigMutation,
  ChannelDoctorEmptyAllowlistAccountContext,
  ChannelDoctorSequenceResult,
} from "../../../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

type ChannelDoctorEntry = {
  channelId: string;
  doctor: ChannelDoctorAdapter;
};

function collectConfiguredChannelIds(cfg: OpenClawConfig): string[] {
  const channels =
    cfg.channels && typeof cfg.channels === "object" && !Array.isArray(cfg.channels)
      ? cfg.channels
      : null;
  if (!channels) {
    return [];
  }
  return Object.keys(channels)
    .filter((channelId) => channelId !== "defaults")
    .toSorted();
}

function safeListActiveChannelPlugins() {
  try {
    return listChannelPlugins();
  } catch {
    return [];
  }
}

function safeListBundledChannelPlugins() {
  try {
    return listBundledChannelPlugins();
  } catch {
    return [];
  }
}

function listChannelDoctorEntries(channelIds?: readonly string[]): ChannelDoctorEntry[] {
  const byId = new Map<string, ChannelDoctorEntry>();
  const selectedIds = channelIds ? new Set(channelIds) : null;
  const plugins = selectedIds
    ? [...selectedIds].flatMap((id) => {
        let activeOrBundledPlugin;
        try {
          activeOrBundledPlugin = getChannelPlugin(id);
        } catch {
          activeOrBundledPlugin = undefined;
        }
        if (activeOrBundledPlugin?.doctor) {
          return [activeOrBundledPlugin];
        }
        const bundledPlugin = getBundledChannelPlugin(id);
        return bundledPlugin ? [bundledPlugin] : [];
      })
    : [...safeListActiveChannelPlugins(), ...safeListBundledChannelPlugins()];
  for (const plugin of plugins) {
    if (!plugin.doctor) {
      continue;
    }
    const existing = byId.get(plugin.id);
    if (!existing) {
      byId.set(plugin.id, { channelId: plugin.id, doctor: plugin.doctor });
    }
  }
  return [...byId.values()];
}

export async function runChannelDoctorConfigSequences(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  shouldRepair: boolean;
}): Promise<ChannelDoctorSequenceResult> {
  const changeNotes: string[] = [];
  const warningNotes: string[] = [];
  for (const entry of listChannelDoctorEntries(collectConfiguredChannelIds(params.cfg))) {
    const result = await entry.doctor.runConfigSequence?.(params);
    if (!result) {
      continue;
    }
    changeNotes.push(...result.changeNotes);
    warningNotes.push(...result.warningNotes);
  }
  return { changeNotes, warningNotes };
}

export function collectChannelDoctorCompatibilityMutations(
  cfg: OpenClawConfig,
): ChannelDoctorConfigMutation[] {
  const channelIds = collectConfiguredChannelIds(cfg);
  if (channelIds.length === 0) {
    return [];
  }
  const mutations: ChannelDoctorConfigMutation[] = [];
  let nextCfg = cfg;
  for (const entry of listChannelDoctorEntries(channelIds)) {
    const mutation = entry.doctor.normalizeCompatibilityConfig?.({ cfg: nextCfg });
    if (!mutation || mutation.changes.length === 0) {
      continue;
    }
    mutations.push(mutation);
    nextCfg = mutation.config;
  }
  return mutations;
}

export async function collectChannelDoctorStaleConfigMutations(
  cfg: OpenClawConfig,
): Promise<ChannelDoctorConfigMutation[]> {
  const mutations: ChannelDoctorConfigMutation[] = [];
  let nextCfg = cfg;
  for (const entry of listChannelDoctorEntries(collectConfiguredChannelIds(cfg))) {
    const mutation = await entry.doctor.cleanStaleConfig?.({ cfg: nextCfg });
    if (!mutation || mutation.changes.length === 0) {
      continue;
    }
    mutations.push(mutation);
    nextCfg = mutation.config;
  }
  return mutations;
}

export async function collectChannelDoctorPreviewWarnings(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
}): Promise<string[]> {
  const warnings: string[] = [];
  for (const entry of listChannelDoctorEntries(collectConfiguredChannelIds(params.cfg))) {
    const lines = await entry.doctor.collectPreviewWarnings?.(params);
    if (lines?.length) {
      warnings.push(...lines);
    }
  }
  return warnings;
}

export async function collectChannelDoctorMutableAllowlistWarnings(params: {
  cfg: OpenClawConfig;
}): Promise<string[]> {
  const warnings: string[] = [];
  for (const entry of listChannelDoctorEntries(collectConfiguredChannelIds(params.cfg))) {
    const lines = await entry.doctor.collectMutableAllowlistWarnings?.(params);
    if (lines?.length) {
      warnings.push(...lines);
    }
  }
  return warnings;
}

export async function collectChannelDoctorRepairMutations(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
}): Promise<ChannelDoctorConfigMutation[]> {
  const mutations: ChannelDoctorConfigMutation[] = [];
  let nextCfg = params.cfg;
  for (const entry of listChannelDoctorEntries(collectConfiguredChannelIds(params.cfg))) {
    const mutation = await entry.doctor.repairConfig?.({
      cfg: nextCfg,
      doctorFixCommand: params.doctorFixCommand,
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

export function collectChannelDoctorEmptyAllowlistExtraWarnings(
  params: ChannelDoctorEmptyAllowlistAccountContext,
): string[] {
  const warnings: string[] = [];
  for (const entry of listChannelDoctorEntries([params.channelName])) {
    const lines = entry.doctor.collectEmptyAllowlistExtraWarnings?.(params);
    if (lines?.length) {
      warnings.push(...lines);
    }
  }
  return warnings;
}

export function shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning(
  params: ChannelDoctorEmptyAllowlistAccountContext,
): boolean {
  return listChannelDoctorEntries([params.channelName]).some(
    (entry) => entry.doctor.shouldSkipDefaultEmptyGroupAllowlistWarning?.(params) === true,
  );
}
