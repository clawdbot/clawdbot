import {
  normalizeOptionalLowercaseString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeCsvOrLooseStringList } from "@openclaw/normalization-core/string-normalization";
import JSON5 from "json5";
import { LEGACY_MANIFEST_KEYS, MANIFEST_KEY } from "../compat/legacy-names.js";
import { parseBooleanValue } from "../utils/boolean.js";

/** Normalizes comma-delimited or loose array metadata fields into string lists. */
export function normalizeStringList(input: unknown): string[] {
  return normalizeCsvOrLooseStringList(input);
}

/** Reads a frontmatter field only when it is represented as a string value. */
export function getFrontmatterString(
  frontmatter: Record<string, unknown>,
  key: string,
): string | undefined {
  return readStringValue(frontmatter[key]);
}

/** Parses boolean frontmatter strings while preserving the caller's default for missing values. */
export function parseFrontmatterBool(value: string | undefined, fallback: boolean): boolean {
  const parsed = parseBooleanValue(value);
  return parsed === undefined ? fallback : parsed;
}

/** Parses the JSON5 OpenClaw manifest block embedded inside a string frontmatter field. */
export function resolveOpenClawManifestBlock(params: {
  frontmatter: Record<string, unknown>;
  key?: string;
}): Record<string, unknown> | undefined {
  const raw = getFrontmatterString(params.frontmatter, params.key ?? "metadata");
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON5.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }

    const manifestKeys = [MANIFEST_KEY, ...LEGACY_MANIFEST_KEYS];
    // Prefer the current manifest key, but still read legacy names for existing skill/hook files.
    for (const key of manifestKeys) {
      const candidate = (parsed as Record<string, unknown>)[key];
      if (candidate && typeof candidate === "object") {
        return candidate as Record<string, unknown>;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export type OpenClawManifestRequires = {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
};

/** Extracts normalized runtime requirement lists from an OpenClaw manifest block. */
export function resolveOpenClawManifestRequires(
  metadataObj: Record<string, unknown>,
): OpenClawManifestRequires | undefined {
  const requiresRaw =
    typeof metadataObj.requires === "object" && metadataObj.requires !== null
      ? (metadataObj.requires as Record<string, unknown>)
      : undefined;
  if (!requiresRaw) {
    return undefined;
  }
  return {
    bins: normalizeStringList(requiresRaw.bins),
    anyBins: normalizeStringList(requiresRaw.anyBins),
    env: normalizeStringList(requiresRaw.env),
    config: normalizeStringList(requiresRaw.config),
  };
}

/** Parses manifest install entries with a caller-owned parser and drops unsupported specs. */
export function resolveOpenClawManifestInstall<T>(
  metadataObj: Record<string, unknown>,
  parseInstallSpec: (input: unknown) => T | undefined,
): T[] {
  const installRaw = Array.isArray(metadataObj.install) ? (metadataObj.install as unknown[]) : [];
  return installRaw
    .map((entry) => parseInstallSpec(entry))
    .filter((entry): entry is T => Boolean(entry));
}

/** Extracts normalized OS allowlist entries from an OpenClaw manifest block. */
export function resolveOpenClawManifestOs(metadataObj: Record<string, unknown>): string[] {
  return normalizeStringList(metadataObj.os);
}

export type ParsedOpenClawManifestInstallBase = {
  raw: Record<string, unknown>;
  kind: string;
  id?: string;
  label?: string;
  bins?: string[];
};

/** Parses kind/type plus common install fields shared by package-manager install specs. */
export function parseOpenClawManifestInstallBase(
  input: unknown,
  allowedKinds: readonly string[],
): ParsedOpenClawManifestInstallBase | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const kindRaw =
    typeof raw.kind === "string" ? raw.kind : typeof raw.type === "string" ? raw.type : "";
  const kind = normalizeOptionalLowercaseString(kindRaw) ?? "";
  if (!allowedKinds.includes(kind)) {
    return undefined;
  }

  const spec: ParsedOpenClawManifestInstallBase = {
    raw,
    kind,
  };
  if (typeof raw.id === "string") {
    spec.id = raw.id;
  }
  if (typeof raw.label === "string") {
    spec.label = raw.label;
  }
  const bins = normalizeStringList(raw.bins);
  if (bins.length > 0) {
    spec.bins = bins;
  }
  return spec;
}

/** Copies optional common install fields onto a caller-specific install spec object. */
export function applyOpenClawManifestInstallCommonFields<
  T extends { id?: string; label?: string; bins?: string[] },
>(spec: T, parsed: Pick<ParsedOpenClawManifestInstallBase, "id" | "label" | "bins">): T {
  if (parsed.id) {
    spec.id = parsed.id;
  }
  if (parsed.label) {
    spec.label = parsed.label;
  }
  if (parsed.bins) {
    spec.bins = parsed.bins;
  }
  return spec;
}
