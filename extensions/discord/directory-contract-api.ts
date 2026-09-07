// Discord API module exposes the plugin public contract.
import {
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
} from "./src/directory-config.js";

export { listDiscordDirectoryGroupsFromConfig, listDiscordDirectoryPeersFromConfig };

export const discordDirectoryContractPlugin = {
  id: "discord",
  directory: {
    listPeers: listDiscordDirectoryPeersFromConfig,
    listGroups: listDiscordDirectoryGroupsFromConfig,
  },
};
