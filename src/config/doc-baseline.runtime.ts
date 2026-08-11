// Collects runtime data needed to generate config documentation baselines.
import { collectBundledChannelConfigsCore } from "../plugins/bundled-channel-config-metadata.js";
import { loadPluginManifestRegistry as loadPluginManifestRegistryImpl } from "../plugins/manifest-registry.js";
import {
  collectChannelSchemaMetadataCore,
  collectPluginSchemaMetadataCore,
} from "./channel-config-metadata.js";
import { buildConfigSchemaCore } from "./schema.js";

/** Runtime facade used by docs baseline generation to keep imports narrow. */
export const loadPluginManifestRegistry = loadPluginManifestRegistryImpl;
export const collectBundledChannelConfigs = collectBundledChannelConfigsCore;
export const collectChannelSchemaMetadata = collectChannelSchemaMetadataCore;
export const collectPluginSchemaMetadata = collectPluginSchemaMetadataCore;
export const buildConfigSchema = buildConfigSchemaCore;
