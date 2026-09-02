// Extracts web content public artifacts from plugin manifests.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "./public-surface-loader.js";
import type {
  PluginWebContentExtractorEntry,
  WebContentExtractorPlugin,
} from "./web-content-extractor-types.js";

const WEB_CONTENT_EXTRACTOR_ARTIFACT_CANDIDATES = [
  "web-content-extractor.js",
  "web-content-extractor-api.js",
] as const;

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

/** Collects zero-arg factory exports in deterministic order for prompt-cache stability. */
function collectExtractorFactories(mod: Record<string, unknown>): WebContentExtractorPlugin[] {
  const extractors: WebContentExtractorPlugin[] = [];
  for (const [name, exported] of Object.entries(mod).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      typeof exported !== "function" ||
      exported.length !== 0 ||
      !name.startsWith("create") ||
      !name.endsWith("WebContentExtractor")
    ) {
      continue;
    }
    const candidate = exported();
    if (isWebContentExtractorPlugin(candidate)) {
      extractors.push(candidate);
    }
  }
  return extractors;
}

/** Loads bundled web content extractor entries from public plugin artifacts. */
export function loadBundledWebContentExtractorEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginWebContentExtractorEntry[] | null {
  const mod = loadBundledPluginPublicArtifactModuleFromCandidatesSync<Record<string, unknown>>({
    dirName: params.dirName,
    artifactCandidates: WEB_CONTENT_EXTRACTOR_ARTIFACT_CANDIDATES,
  });
  if (!mod) {
    return null;
  }
  const extractors = collectExtractorFactories(mod);
  if (extractors.length === 0) {
    return null;
  }
  return extractors.map((extractor) => Object.assign({}, extractor, { pluginId: params.pluginId }));
}
