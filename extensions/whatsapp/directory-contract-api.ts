// Whatsapp API module exposes the plugin public contract.
import {
  listWhatsAppDirectoryGroupsFromConfig,
  listWhatsAppDirectoryPeersFromConfig,
} from "./src/directory-config.js";

export { listWhatsAppDirectoryGroupsFromConfig, listWhatsAppDirectoryPeersFromConfig };

export const whatsappDirectoryContractPlugin = {
  id: "whatsapp",
  directory: {
    listPeers: listWhatsAppDirectoryPeersFromConfig,
    listGroups: listWhatsAppDirectoryGroupsFromConfig,
  },
};
