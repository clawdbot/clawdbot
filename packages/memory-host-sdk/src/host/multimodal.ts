// Memory Host SDK module implements multimodal behavior.
import { normalizeLowercaseStringOrEmpty } from "./string-utils.js";

// Multimodal memory settings and file classification helpers.

const MEMORY_MULTIMODAL_SPECS = {
  image: {
    labelPrefix: "Image file",
    extensions: [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"],
  },
  audio: {
    labelPrefix: "Audio file",
    extensions: [".mp3", ".wav", ".ogg", ".opus", ".m4a", ".aac", ".flac"],
  },
} as const;

/** Supported multimodal memory modality. */
export type MemoryMultimodalModality = keyof typeof MEMORY_MULTIMODAL_SPECS;
/** All supported multimodal memory modalities in stable config order. */
export const MEMORY_MULTIMODAL_MODALITIES = Object.keys(
  MEMORY_MULTIMODAL_SPECS,
) as MemoryMultimodalModality[];
/** User selection for one modality or all modalities. */
export type MemoryMultimodalSelection = MemoryMultimodalModality | "all";

/** Normalized multimodal memory ingestion settings. */
export type MemoryMultimodalSettings = {
  enabled: boolean;
  modalities: MemoryMultimodalModality[];
  maxFileBytes: number;
};

/** Default max bytes for one multimodal memory file. */
export const DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Normalize user modality selections to supported modalities. */
export function normalizeMemoryMultimodalModalities(
  raw: MemoryMultimodalSelection[] | undefined,
): MemoryMultimodalModality[] {
  if (raw === undefined || raw.includes("all")) {
    return [...MEMORY_MULTIMODAL_MODALITIES];
  }
  const normalized = new Set<MemoryMultimodalModality>();
  for (const value of raw) {
    if (value === "image" || value === "audio") {
      normalized.add(value);
    }
  }
  return Array.from(normalized);
}

/** Normalize user multimodal settings, including disabled-state empty modality list. */
export function normalizeMemoryMultimodalSettings(raw: {
  enabled?: boolean;
  modalities?: MemoryMultimodalSelection[];
  maxFileBytes?: number;
}): MemoryMultimodalSettings {
  const enabled = raw.enabled === true;
  const maxFileBytes =
    typeof raw.maxFileBytes === "number" && Number.isFinite(raw.maxFileBytes)
      ? Math.max(1, Math.floor(raw.maxFileBytes))
      : DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES;
  return {
    enabled,
    modalities: enabled ? normalizeMemoryMultimodalModalities(raw.modalities) : [],
    maxFileBytes,
  };
}

/** Return true when multimodal memory ingestion has at least one enabled modality. */
export function isMemoryMultimodalEnabled(settings: MemoryMultimodalSettings): boolean {
  return settings.enabled && settings.modalities.length > 0;
}

/** Return accepted file extensions for a modality. */
export function getMemoryMultimodalExtensions(
  modality: MemoryMultimodalModality,
): readonly string[] {
  return MEMORY_MULTIMODAL_SPECS[modality].extensions;
}

/** Build the text label that accompanies embedded multimodal file content. */
export function buildMemoryMultimodalLabel(
  modality: MemoryMultimodalModality,
  normalizedPath: string,
): string {
  return `${MEMORY_MULTIMODAL_SPECS[modality].labelPrefix}: ${normalizedPath}`;
}

/** Build a glob that matches an extension case-insensitively for QMD sources. */
export function buildCaseInsensitiveExtensionGlob(extension: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(extension).replace(/^\./, "");
  if (!normalized) {
    return "*";
  }
  const parts = Array.from(normalized, (char) => `[${char.toLowerCase()}${char.toUpperCase()}]`);
  return `*.${parts.join("")}`;
}

/** Classify a file path into a supported multimodal modality under current settings. */
export function classifyMemoryMultimodalPath(
  filePath: string,
  settings: MemoryMultimodalSettings,
): MemoryMultimodalModality | null {
  if (!isMemoryMultimodalEnabled(settings)) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(filePath);
  for (const modality of settings.modalities) {
    for (const extension of getMemoryMultimodalExtensions(modality)) {
      if (lower.endsWith(extension)) {
        return modality;
      }
    }
  }
  return null;
}
