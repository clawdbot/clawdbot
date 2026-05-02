import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
export { isSafeChannelEnvVarTriggerName } from "./channel-env-var-names.js";

type ChannelEnvVarLookupParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

function appendUniqueEnvVarCandidates(
  target: Record<string, string[]>,
  channelId: string,
  keys: readonly string[],
) {
  const normalizedChannelId = channelId.trim();
  if (!normalizedChannelId || keys.length === 0) {
    return;
  }
  const bucket = (target[normalizedChannelId] ??= []);
  const seen = new Set(bucket);
  for (const key of keys) {
    const normalizedKey = key.trim();
    if (!normalizedKey || seen.has(normalizedKey)) {
      continue;
    }
    seen.add(normalizedKey);
    bucket.push(normalizedKey);
  }
}

export function resolveChannelEnvVars(
  params?: ChannelEnvVarLookupParams,
): Record<string, readonly string[]> {
  const snapshot = loadPluginMetadataSnapshot({
    config: params?.config ?? {},
    workspaceDir: params?.workspaceDir,
    env: params?.env ?? process.env,
  });
  const candidates: Record<string, string[]> = {};
  for (const plugin of snapshot.plugins) {
    if (!plugin.channelEnvVars) {
      continue;
    }
    for (const [channelId, keys] of Object.entries(plugin.channelEnvVars).toSorted(
      ([left], [right]) => left.localeCompare(right),
    )) {
      appendUniqueEnvVarCandidates(candidates, channelId, keys);
    }
  }
  return candidates;
}

export function getChannelEnvVars(channelId: string, params?: ChannelEnvVarLookupParams): string[] {
  const channelEnvVars = resolveChannelEnvVars(params);
  const envVars = Object.hasOwn(channelEnvVars, channelId) ? channelEnvVars[channelId] : undefined;
  return Array.isArray(envVars) ? [...envVars] : [];
}

export function listKnownChannelEnvVarNames(params?: ChannelEnvVarLookupParams): string[] {
  return [...new Set(Object.values(resolveChannelEnvVars(params)).flatMap((keys) => keys))];
}
