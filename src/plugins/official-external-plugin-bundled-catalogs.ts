// One generated source inventory shared by catalog queries and conservative repair checks.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import channelCatalog from "../../scripts/lib/official-external-channel-catalog.json" with { type: "json" };
import pluginCatalog from "../../scripts/lib/official-external-plugin-catalog.json" with { type: "json" };
import providerCatalog from "../../scripts/lib/official-external-provider-catalog.json" with { type: "json" };
import type { OfficialExternalPluginCatalogEntry } from "./official-external-plugin-catalog.types.js";

export const BUNDLED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_ENTRIES: readonly OfficialExternalPluginCatalogEntry[] =
  [channelCatalog, providerCatalog, pluginCatalog].flatMap((source: { entries: unknown[] }) =>
    source.entries.filter((entry): entry is OfficialExternalPluginCatalogEntry => isRecord(entry)),
  );
