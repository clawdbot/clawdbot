import type {
  DocumentExtractorPlugin,
  PluginDocumentExtractorEntry,
} from "./document-extractor-types.js";
import {
  loadBundledPluginPublicArtifactModuleSync,
  resolveBundledPluginPublicArtifactPath,
} from "./public-surface-loader.js";

const DOCUMENT_EXTRACTOR_ARTIFACT_CANDIDATES = [
  "document-extractor.js",
  "document-extractor-api.js",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDocumentExtractorPlugin(value: unknown): value is DocumentExtractorPlugin {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    Array.isArray(value.mimeTypes) &&
    value.mimeTypes.every((mimeType) => typeof mimeType === "string" && mimeType.trim()) &&
    (value.autoDetectOrder === undefined || typeof value.autoDetectOrder === "number") &&
    typeof value.extract === "function"
  );
}

function tryLoadBundledPublicArtifactModule(params: {
  dirName: string;
}): Record<string, unknown> | null {
  for (const artifactBasename of DOCUMENT_EXTRACTOR_ARTIFACT_CANDIDATES) {
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

function collectExtractorFactories(mod: Record<string, unknown>): {
  extractors: DocumentExtractorPlugin[];
  errors: unknown[];
} {
  const extractors: DocumentExtractorPlugin[] = [];
  const errors: unknown[] = [];
  for (const [name, exported] of Object.entries(mod).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      typeof exported !== "function" ||
      exported.length !== 0 ||
      !name.startsWith("create") ||
      !name.endsWith("DocumentExtractor")
    ) {
      continue;
    }
    let candidate: unknown;
    try {
      candidate = exported();
    } catch (error) {
      errors.push(error);
      continue;
    }
    if (isDocumentExtractorPlugin(candidate)) {
      extractors.push(candidate);
    }
  }
  return { extractors, errors };
}

export function loadBundledDocumentExtractorEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginDocumentExtractorEntry[] | null {
  const mod = tryLoadBundledPublicArtifactModule({ dirName: params.dirName });
  if (!mod) {
    return null;
  }
  const { extractors, errors } = collectExtractorFactories(mod);
  if (extractors.length === 0) {
    if (errors.length > 0) {
      throw new Error(`Unable to initialize document extractors for plugin ${params.pluginId}`, {
        cause: errors.length === 1 ? errors[0] : new AggregateError(errors),
      });
    }
    return null;
  }
  return extractors.map((extractor) => Object.assign({}, extractor, { pluginId: params.pluginId }));
}

export function hasBundledDocumentExtractorPublicArtifact(pluginId: string): boolean {
  return DOCUMENT_EXTRACTOR_ARTIFACT_CANDIDATES.some((artifactBasename) =>
    Boolean(resolveBundledPluginPublicArtifactPath({ dirName: pluginId, artifactBasename })),
  );
}
