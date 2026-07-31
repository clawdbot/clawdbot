/**
 * Lazy manifest-registry facade for runtime web tool secret discovery. Keeps
 * runtime tests able to replace manifest ownership without importing registry internals.
 */
export {
  resolveManifestContractOwnerPluginId,
  resolveManifestContractPluginIds,
} from "../plugins/plugin-registry.js";
