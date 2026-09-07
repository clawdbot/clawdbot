// Extracts web content public artifacts from plugin manifests.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { loadBundledPublicArtifactEntries } from "./public-artifact-factories.js";
import type {
  PluginWebContentExtractorEntry,
  WebContentExtractorPlugin,
} from "./web-content-extractor-types.js";

/** Checks public artifact exports before adding them to runtime extractor registration. */
function isWebContentExtractorPlugin(value: unknown): value is WebContentExtractorPlugin {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    (value.autoDetectOrder === undefined || typeof value.autoDetectOrder === "number") &&
    typeof value.extract === "function"
  );
}

/** Loads bundled web content extractor entries from public plugin artifacts. */
export function loadBundledWebContentExtractorEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginWebContentExtractorEntry[] | null {
  return loadBundledPublicArtifactEntries({
    ...params,
    artifactCandidates: ["web-content-extractor.js", "web-content-extractor-api.js"],
    suffix: "WebContentExtractor",
    isArtifact: isWebContentExtractorPlugin,
  });
}
