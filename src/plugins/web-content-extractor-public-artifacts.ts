import { loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader.js";
import type {
  PluginWebContentExtractorEntry,
  WebContentExtractorPlugin,
} from "./web-content-extractor-types.js";

const WEB_CONTENT_EXTRACTOR_ARTIFACT_CANDIDATES = [
  "web-content-extractor.js",
  "web-content-extractor-api.js",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWebContentExtractorPlugin(value: unknown): value is WebContentExtractorPlugin {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    (value.autoDetectOrder === undefined || typeof value.autoDetectOrder === "number") &&
    typeof value.extract === "function"
  );
}

function tryLoadBundledPublicArtifactModule(params: {
  dirName: string;
}): Record<string, unknown> | null {
  for (const artifactBasename of WEB_CONTENT_EXTRACTOR_ARTIFACT_CANDIDATES) {
    try {
      return loadBundledPluginPublicArtifactModuleSync<Record<string, unknown>>({
        dirName: params.dirName,
        artifactBasename,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      ) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

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

export function loadBundledWebContentExtractorEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginWebContentExtractorEntry[] | null {
  const mod = tryLoadBundledPublicArtifactModule({ dirName: params.dirName });
  if (!mod) {
    return null;
  }
  const extractors = collectExtractorFactories(mod);
  if (extractors.length === 0) {
    return null;
  }
  return extractors.map((extractor) => Object.assign({}, extractor, { pluginId: params.pluginId }));
}
