import type {
  PluginBundleFormat,
  PluginDiagnostic,
  PluginFormat,
  PluginManifest,
} from "./manifest-types.js";
import type { OpenClawPackageManifest, PackageManifest } from "./package-manifest.types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { PluginDependencySpecMap } from "./status-dependencies-core.js";

/** One potential plugin root discovered before manifest validation and registry normalization. */
export type PluginCandidate = {
  idHint: string;
  /** Discovery-owned identity for one entry in a multi-entry package pack. */
  effectivePluginId?: string;
  diagnosticIdHint?: string;
  source: string;
  setupSource?: string;
  rootDir: string;
  origin: PluginOrigin;
  /** Retains explicit load-path precedence when physical aliases merge their provenance. */
  configSelected?: true;
  /** An intentional source overlay must not execute its packaged peer. */
  sourcePreferred?: true;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  workspaceDir?: string;
  packageName?: string;
  packageVersion?: string;
  packageDescription?: string;
  packageDir?: string;
  packageManifest?: OpenClawPackageManifest;
  packageDependencies?: PluginDependencySpecMap;
  packageOptionalDependencies?: PluginDependencySpecMap;
  bundledManifestId?: string;
  bundledManifest?: PluginManifest;
  bundledManifestPath?: string;
  requiredPluginIds?: string[];
  requiredPluginSource?: string;
  rawPackageManifest?: PackageManifest;
};

/** Discovery candidates plus warnings/errors emitted while scanning roots. */
export type PluginDiscoveryResult = {
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
};
