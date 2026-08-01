import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export const DISCORD_COMMAND_DEPLOY_HASH_NAMESPACE = "command-deploy-hashes";
export const DISCORD_COMMAND_DEPLOY_HASH_MAX_ENTRIES = 10_000;

export type DiscordCommandDeployHashStore = Pick<
  PluginStateKeyedStore<string>,
  "lookup" | "register"
>;

type OpenKeyedStore = <T>(options: {
  namespace: string;
  maxEntries: number;
  overflowPolicy: "evict-oldest";
}) => PluginStateKeyedStore<T>;

export function openDiscordCommandDeployHashStore(
  openKeyedStore: OpenKeyedStore,
): DiscordCommandDeployHashStore {
  return openKeyedStore<string>({
    namespace: DISCORD_COMMAND_DEPLOY_HASH_NAMESPACE,
    maxEntries: DISCORD_COMMAND_DEPLOY_HASH_MAX_ENTRIES,
    overflowPolicy: "evict-oldest",
  });
}
