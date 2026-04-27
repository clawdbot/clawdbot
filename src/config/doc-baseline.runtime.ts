import { collectBundledChannelConfigs as collectBundledChannelConfigsImpl } from "../plugins/bundled-channel-config-metadata.js";
import { loadPluginManifestRegistry as loadPluginManifestRegistryImpl } from "../plugins/manifest-registry.js";
import {
  collectChannelSchemaMetadata as collectChannelSchemaMetadataImpl,
  collectPluginSchemaMetadata as collectPluginSchemaMetadataImpl,
} from "./channel-config-metadata.js";
import { buildConfigSchema as buildConfigSchemaImpl } from "./schema.js";

export const loadPluginManifestRegistry = loadPluginManifestRegistryImpl;
export const collectBundledChannelConfigs = collectBundledChannelConfigsImpl;
export const collectChannelSchemaMetadata = collectChannelSchemaMetadataImpl;
export const collectPluginSchemaMetadata = collectPluginSchemaMetadataImpl;
export const buildConfigSchema = buildConfigSchemaImpl;
