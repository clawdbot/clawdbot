/** Discovers plugin-declared environment variable names for channel credential setup. */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
export { isSafeChannelEnvVarTriggerName } from "./channel-env-var-names.js";

type ChannelEnvVarLookupParams = {
  /** Config snapshot used to discover enabled/installed plugin manifests. */
  config?: OpenClawConfig;
  /** Workspace root used for local plugin metadata discovery. */
  workspaceDir?: string;
  /** Env snapshot used by metadata loading; defaults to process env. */
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

/**
 * Resolves plugin-declared channel environment variable names keyed by channel id.
 * The result is deterministic so env-shell docs and prompt snapshots stay stable.
 */
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
    // Sort channel ids before merging so prompt/test snapshots do not depend on manifest order.
    for (const [channelId, keys] of Object.entries(plugin.channelEnvVars).toSorted(
      ([left], [right]) => left.localeCompare(right),
    )) {
      appendUniqueEnvVarCandidates(candidates, channelId, keys);
    }
  }
  return candidates;
}

/**
 * Returns the declared env var names for one channel id.
 */
export function getChannelEnvVars(channelId: string, params?: ChannelEnvVarLookupParams): string[] {
  const channelEnvVars = resolveChannelEnvVars(params);
  const envVars = Object.hasOwn(channelEnvVars, channelId) ? channelEnvVars[channelId] : undefined;
  return Array.isArray(envVars) ? [...envVars] : [];
}

/**
 * Lists every known channel env var name across installed plugin metadata.
 */
export function listKnownChannelEnvVarNames(params?: ChannelEnvVarLookupParams): string[] {
  return uniqueStrings(Object.values(resolveChannelEnvVars(params)).flat());
}
