// Googlechat API module exposes the plugin public contract.
import { googlechatDirectoryAdapter } from "./src/channel.adapters.js";

export const googlechatDirectoryContractPlugin = {
  id: "googlechat",
  directory: googlechatDirectoryAdapter,
};
