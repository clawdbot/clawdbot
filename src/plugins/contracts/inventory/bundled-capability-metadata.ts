import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeBundledPluginStringList,
  resolveBundledPluginScanDir,
} from "../../bundled-plugin-scan.js";
import { PLUGIN_MANIFEST_FILENAME, type PluginManifest } from "../../manifest.js";
import { resolveLoaderPackageRoot } from "../../sdk-alias.js";
import { uniqueStrings } from "../shared.js";

// Build/test inventory only.
// Runtime code should prefer manifest/runtime registry queries instead of these snapshots.

export type BundledPluginContractSnapshot = {
  pluginId: string;
  cliBackendIds: string[];
  providerIds: string[];
  providerAuthEnvVars: Record<string, string[]>;
  speechProviderIds: string[];
  realtimeTranscriptionProviderIds: string[];
  realtimeVoiceProviderIds: string[];
  mediaUnderstandingProviderIds: string[];
  documentExtractorIds: string[];
  imageGenerationProviderIds: string[];
  videoGenerationProviderIds: string[];
  musicGenerationProviderIds: string[];
  webContentExtractorIds: string[];
  webFetchProviderIds: string[];
  webSearchProviderIds: string[];
  migrationProviderIds: string[];
  toolNames: string[];
};

const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: CURRENT_MODULE_PATH,
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../../../..", import.meta.url));
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);

export type BundledCapabilityManifest = Pick<
  PluginManifest,
  | "id"
  | "autoEnableWhenConfiguredProviders"
  | "cliBackends"
  | "contracts"
  | "legacyPluginIds"
  | "providerAuthEnvVars"
  | "providers"
>;

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readBundledCapabilityManifest(pluginDir: string): BundledCapabilityManifest | undefined {
  const packageJson = readJsonRecord(path.join(pluginDir, "package.json"));
  const extensions = normalizeBundledPluginStringList(
    packageJson?.openclaw && typeof packageJson.openclaw === "object"
      ? (packageJson.openclaw as { extensions?: unknown }).extensions
      : undefined,
  );
  if (extensions.length === 0) {
    return undefined;
  }

  const raw = readJsonRecord(path.join(pluginDir, PLUGIN_MANIFEST_FILENAME));
  const id = typeof raw?.id === "string" ? raw.id.trim() : "";
  if (!id) {
    return undefined;
  }
  return raw as BundledCapabilityManifest;
}

function listBundledCapabilityManifests(): readonly BundledCapabilityManifest[] {
  const scanDir = resolveBundledPluginScanDir({
    packageRoot: OPENCLAW_PACKAGE_ROOT,
    runningFromBuiltArtifact: RUNNING_FROM_BUILT_ARTIFACT,
  });
  if (!scanDir) {
    return [];
  }
  return fs
    .readdirSync(scanDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readBundledCapabilityManifest(path.join(scanDir, entry.name)))
    .filter((manifest): manifest is BundledCapabilityManifest => manifest !== undefined)
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

const BUNDLED_CAPABILITY_MANIFESTS = listBundledCapabilityManifests();

function normalizeStringListRecord(record: unknown): Record<string, string[]> {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record)
      .map(
        ([key, values]) =>
          [
            key.trim(),
            uniqueStrings(Array.isArray(values) ? values : [], (value) =>
              typeof value === "string" ? value.trim() : "",
            ),
          ] as const,
      )
      .filter(([key, values]) => key && values.length > 0)
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

export function buildBundledPluginContractSnapshot(
  manifest: BundledCapabilityManifest,
): BundledPluginContractSnapshot {
  return {
    pluginId: manifest.id,
    cliBackendIds: uniqueStrings(manifest.cliBackends, (value) => value.trim()),
    providerIds: uniqueStrings(manifest.providers, (value) => value.trim()),
    providerAuthEnvVars: normalizeStringListRecord(manifest.providerAuthEnvVars),
    speechProviderIds: uniqueStrings(manifest.contracts?.speechProviders, (value) => value.trim()),
    realtimeTranscriptionProviderIds: uniqueStrings(
      manifest.contracts?.realtimeTranscriptionProviders,
      (value) => value.trim(),
    ),
    realtimeVoiceProviderIds: uniqueStrings(manifest.contracts?.realtimeVoiceProviders, (value) =>
      value.trim(),
    ),
    mediaUnderstandingProviderIds: uniqueStrings(
      manifest.contracts?.mediaUnderstandingProviders,
      (value) => value.trim(),
    ),
    documentExtractorIds: uniqueStrings(manifest.contracts?.documentExtractors, (value) =>
      value.trim(),
    ),
    imageGenerationProviderIds: uniqueStrings(
      manifest.contracts?.imageGenerationProviders,
      (value) => value.trim(),
    ),
    videoGenerationProviderIds: uniqueStrings(
      manifest.contracts?.videoGenerationProviders,
      (value) => value.trim(),
    ),
    musicGenerationProviderIds: uniqueStrings(
      manifest.contracts?.musicGenerationProviders,
      (value) => value.trim(),
    ),
    webContentExtractorIds: uniqueStrings(manifest.contracts?.webContentExtractors, (value) =>
      value.trim(),
    ),
    webFetchProviderIds: uniqueStrings(manifest.contracts?.webFetchProviders, (value) =>
      value.trim(),
    ),
    webSearchProviderIds: uniqueStrings(manifest.contracts?.webSearchProviders, (value) =>
      value.trim(),
    ),
    migrationProviderIds: uniqueStrings(manifest.contracts?.migrationProviders, (value) =>
      value.trim(),
    ),
    toolNames: uniqueStrings(manifest.contracts?.tools, (value) => value.trim()),
  };
}

export function hasBundledPluginContractSnapshotCapabilities(
  entry: BundledPluginContractSnapshot,
): boolean {
  return (
    entry.cliBackendIds.length > 0 ||
    entry.providerIds.length > 0 ||
    entry.speechProviderIds.length > 0 ||
    entry.realtimeTranscriptionProviderIds.length > 0 ||
    entry.realtimeVoiceProviderIds.length > 0 ||
    entry.mediaUnderstandingProviderIds.length > 0 ||
    entry.documentExtractorIds.length > 0 ||
    entry.imageGenerationProviderIds.length > 0 ||
    entry.videoGenerationProviderIds.length > 0 ||
    entry.musicGenerationProviderIds.length > 0 ||
    entry.webContentExtractorIds.length > 0 ||
    entry.webFetchProviderIds.length > 0 ||
    entry.webSearchProviderIds.length > 0 ||
    entry.migrationProviderIds.length > 0 ||
    entry.toolNames.length > 0
  );
}

export const BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS: readonly BundledPluginContractSnapshot[] =
  BUNDLED_CAPABILITY_MANIFESTS.map(buildBundledPluginContractSnapshot)
    .filter(hasBundledPluginContractSnapshotCapabilities)
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));

export const BUNDLED_LEGACY_PLUGIN_ID_ALIASES = Object.fromEntries(
  BUNDLED_CAPABILITY_MANIFESTS.flatMap((manifest) =>
    (manifest.legacyPluginIds ?? []).map(
      (legacyPluginId) => [legacyPluginId, manifest.id] as const,
    ),
  ).toSorted(([left], [right]) => left.localeCompare(right)),
) as Readonly<Record<string, string>>;

export const BUNDLED_AUTO_ENABLE_PROVIDER_PLUGIN_IDS = Object.fromEntries(
  BUNDLED_CAPABILITY_MANIFESTS.flatMap((manifest) =>
    (manifest.autoEnableWhenConfiguredProviders ?? []).map((providerId) => [
      providerId,
      manifest.id,
    ]),
  ).toSorted(([left], [right]) => left.localeCompare(right)),
) as Readonly<Record<string, string>>;

type BundledContractIdSnapshotKey = Exclude<
  keyof Omit<BundledPluginContractSnapshot, "pluginId">,
  "providerAuthEnvVars"
>;

export function resolveBundledContractSnapshotPluginIds(
  key: BundledContractIdSnapshotKey,
): string[] {
  return BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry[key].length > 0)
    .map((entry) => entry.pluginId)
    .toSorted((left, right) => left.localeCompare(right));
}
