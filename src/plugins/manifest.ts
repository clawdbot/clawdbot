import fs from "node:fs";
import path from "node:path";

import { LEGACY_MANIFEST_KEY, LEGACY_PLUGIN_MANIFEST_FILENAME } from "../compat/legacy-names.js";
import type { PluginConfigUiHint, PluginKind } from "./types.js";

export const PLUGIN_MANIFEST_FILENAME = "moltbot.plugin.json";
export const PLUGIN_MANIFEST_FILENAMES = [
  PLUGIN_MANIFEST_FILENAME,
  LEGACY_PLUGIN_MANIFEST_FILENAME,
] as const;

export type PluginManifest = {
  id: string;
  configSchema: Record<string, unknown>;
  kind?: PluginKind;
  channels?: string[];
  providers?: string[];
  skills?: string[];
  name?: string;
  description?: string;
  version?: string;
  uiHints?: Record<string, PluginConfigUiHint>;
};

export type PluginManifestLoadResult =
  | { ok: true; manifest: PluginManifest; manifestPath: string }
  | { ok: false; error: string; manifestPath: string };

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function resolvePluginManifestPath(rootDir: string): string {
  for (const filename of PLUGIN_MANIFEST_FILENAMES) {
    const candidate = path.join(rootDir, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(rootDir, PLUGIN_MANIFEST_FILENAME);
}

export function loadPluginManifest(rootDir: string): PluginManifestLoadResult {
  const manifestPath = resolvePluginManifestPath(rootDir);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: `plugin manifest not found: ${manifestPath}`, manifestPath };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown;
  } catch (err) {
    return {
      ok: false,
      error: `failed to parse plugin manifest: ${String(err)}`,
      manifestPath,
    };
  }
  if (!isRecord(raw)) {
    return { ok: false, error: "plugin manifest must be an object", manifestPath };
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) {
    return { ok: false, error: "plugin manifest requires id", manifestPath };
  }
  const configSchema = isRecord(raw.configSchema) ? raw.configSchema : null;
  if (!configSchema) {
    return { ok: false, error: "plugin manifest requires configSchema", manifestPath };
  }

  const kind = typeof raw.kind === "string" ? (raw.kind as PluginKind) : undefined;
  const name = typeof raw.name === "string" ? raw.name.trim() : undefined;
  const description = typeof raw.description === "string" ? raw.description.trim() : undefined;
  const version = typeof raw.version === "string" ? raw.version.trim() : undefined;
  const channels = normalizeStringList(raw.channels);
  const providers = normalizeStringList(raw.providers);
  const skills = normalizeStringList(raw.skills);

  let uiHints: Record<string, PluginConfigUiHint> | undefined;
  if (isRecord(raw.uiHints)) {
    uiHints = raw.uiHints as Record<string, PluginConfigUiHint>;
  }

  return {
    ok: true,
    manifest: {
      id,
      configSchema,
      kind,
      channels,
      providers,
      skills,
      name,
      description,
      version,
      uiHints,
    },
    manifestPath,
  };
}

// package.json "moltbot" metadata (used for onboarding/catalog)
export type PluginPackageChannel = {
  id?: string;
  label?: string;
  selectionLabel?: string;
  detailLabel?: string;
  docsPath?: string;
  docsLabel?: string;
  blurb?: string;
  order?: number;
  aliases?: string[];
  preferOver?: string[];
  systemImage?: string;
  selectionDocsPrefix?: string;
  selectionDocsOmitLabel?: boolean;
  selectionExtras?: string[];
  showConfigured?: boolean;
  quickstartAllowFrom?: boolean;
  forceAccountBinding?: boolean;
  preferSessionLookupForAnnounceTarget?: boolean;
};

export type PluginPackageInstall = {
  npmSpec?: string;
  localPath?: string;
  defaultChoice?: "npm" | "local";
};

export type MoltbotPackageManifest = {
  extensions?: string[];
  channel?: PluginPackageChannel;
  install?: PluginPackageInstall;
};

export type PackageManifest = {
  name?: string;
  version?: string;
  description?: string;
  moltbot?: MoltbotPackageManifest;
  [LEGACY_MANIFEST_KEY]?: MoltbotPackageManifest;
};

export function getPackageManifestMetadata(
  manifest: PackageManifest | undefined,
): MoltbotPackageManifest | undefined {
  if (!manifest) return undefined;
  return manifest.moltbot ?? manifest[LEGACY_MANIFEST_KEY];
}
