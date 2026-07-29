// Extracts document extractor public artifacts from plugin manifests.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  DocumentExtractorPlugin,
  PluginDocumentExtractorEntry,
} from "./document-extractor-types.js";
import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "./public-surface-loader.js";

const DOCUMENT_EXTRACTOR_ARTIFACT_CANDIDATES = [
  "document-extractor.js",
  "document-extractor-api.js",
] as const;

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

/** Loads document extractor entries from a bundled plugin public artifact module. */
export function loadBundledDocumentExtractorEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginDocumentExtractorEntry[] | null {
  const mod = loadBundledPluginPublicArtifactModuleFromCandidatesSync<Record<string, unknown>>({
    dirName: params.dirName,
    artifactCandidates: DOCUMENT_EXTRACTOR_ARTIFACT_CANDIDATES,
  });
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
