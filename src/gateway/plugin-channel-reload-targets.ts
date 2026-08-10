// Gateway channel plugin reload targeting.
// Maps channel/plugin ids and aliases to config path prefixes for hot reload.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelId } from "../channels/plugins/index.js";
import type { ChannelRuntimeSnapshot } from "./server-channel-runtime.types.js";

type ChannelPluginReloadTarget = {
  channelId: ChannelId;
  pluginId?: string | null;
  aliases?: readonly string[] | null;
};

function addNormalizedTarget(targets: Set<string>, value: string | null | undefined): void {
  const normalized = normalizeOptionalString(value);
  if (normalized) {
    targets.add(normalized);
  }
}

/** Lists all config ids that should trigger reload for a channel plugin target. */
export function listChannelPluginConfigTargetIds(
  target: ChannelPluginReloadTarget,
): ReadonlySet<string> {
  const targets = new Set<string>();
  addNormalizedTarget(targets, target.channelId);
  addNormalizedTarget(targets, target.pluginId);
  for (const alias of target.aliases ?? []) {
    addNormalizedTarget(targets, alias);
  }
  return targets;
}

/** Returns true when changed config paths affect any target plugin/channel id. */
export function pluginConfigTargetsChanged(
  targetIds: Iterable<string>,
  changedPaths: readonly string[],
): boolean {
  const prefixes = Array.from(targetIds, (id) => [
    `plugins.entries.${id}`,
    `plugins.installs.${id}`,
  ]).flat();
  return changedPaths.some((path) =>
    prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}.`)),
  );
}

/** Lists running channels whose native command catalog retains registry-bound handlers. */
export function listRunningCommandCatalogChannelIds(
  plugins: readonly { id: ChannelId; commands?: object }[],
  snapshot: ChannelRuntimeSnapshot,
): Set<ChannelId> {
  return new Set(
    plugins
      .filter(
        (plugin) =>
          plugin.commands !== undefined &&
          Object.values(snapshot.channelAccounts[plugin.id] ?? {}).some(
            (account) => account.running === true,
          ),
      )
      .map((plugin) => plugin.id),
  );
}
