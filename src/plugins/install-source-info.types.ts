import type { ParsedRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import type { PluginPackageInstall } from "./package-manifest.types.js";

/** Warning emitted while describing plugin package install source metadata. */
export type PluginInstallSourceWarning =
  | "invalid-clawhub-spec"
  | "invalid-npm-spec"
  | "invalid-default-choice"
  | "default-choice-missing-source"
  | "clawhub-spec-floating"
  | "npm-integrity-without-source"
  | "npm-spec-floating"
  | "npm-spec-missing-integrity"
  | "npm-spec-package-name-mismatch";

/** Pinning state for npm plugin install metadata. */
export type PluginInstallNpmPinState =
  | "exact-with-integrity"
  | "exact-without-integrity"
  | "floating-with-integrity"
  | "floating-without-integrity";

/** Parsed npm install source metadata for a plugin package. */
export type PluginInstallNpmSourceInfo = {
  spec: string;
  packageName: string;
  expectedPackageName?: string;
  selector?: string;
  selectorKind: ParsedRegistryNpmSpec["selectorKind"];
  exactVersion: boolean;
  expectedIntegrity?: string;
  pinState: PluginInstallNpmPinState;
};

/** Parsed local install source metadata for a plugin package. */
type PluginInstallLocalSourceInfo = {
  path: string;
};

/** Parsed ClawHub install source metadata for a plugin package. */
export type PluginInstallClawHubSourceInfo = {
  spec: string;
  packageName: string;
  version?: string;
  exactVersion: boolean;
};

/** Parsed plugin install sources plus validation warnings. */
export type PluginInstallSourceInfo = {
  defaultChoice?: PluginPackageInstall["defaultChoice"];
  clawhub?: PluginInstallClawHubSourceInfo;
  npm?: PluginInstallNpmSourceInfo;
  local?: PluginInstallLocalSourceInfo;
  warnings: readonly PluginInstallSourceWarning[];
};
