// Resolves trusted official external plugin installs from the OpenClaw-owned catalog.
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { resolveDefaultNpmSpec, type PluginInstallSource } from "./install-channel-specs.js";
import {
  getOfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogEntryForPackage,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstallSources,
  type OfficialExternalPluginCatalogEntry,
} from "./official-external-plugin-catalog.js";

export function resolveOfficialInstallSources(
  entry: OfficialExternalPluginCatalogEntry,
  version?: string,
): PluginInstallSource[] {
  return resolveOfficialExternalPluginInstallSources(entry).map((source) => {
    if (!version) {
      return source;
    }
    const name =
      source.source === "npm"
        ? parseRegistryNpmSpec(source.spec)?.name
        : parseClawHubPluginSpec(source.spec)?.name;
    if (!name) {
      return source;
    }
    const spec = `${source.source === "clawhub" ? "clawhub:" : ""}${name}@${version}`;
    // Requested latest intent follows each declared identity; a catalog digest
    // authenticates only its original spec, never a different release target.
    return spec === source.spec ? source : { source: source.source, spec };
  });
}

export function resolveCatalogOfficialExternalInstallPlan(rawSpec: string) {
  const parsed = resolveDefaultNpmSpec(rawSpec);
  if (!parsed) {
    return null;
  }
  const entry =
    getOfficialExternalPluginCatalogEntry(parsed.name) ??
    getOfficialExternalPluginCatalogEntryForPackage(parsed.name);
  const pluginId = entry && resolveOfficialExternalPluginId(entry);
  const installSources = entry ? resolveOfficialInstallSources(entry, parsed.selector) : [];
  const primary = installSources[0];
  return pluginId && primary ? { pluginId, spec: primary.spec, installSources } : null;
}

export function resolveCatalogOfficialExternalNpmPackageTrust(npmSpec: string): {
  pluginId: string;
  expectedIntegrity?: string;
  trustedSourceLinkedOfficialInstall: true;
} | null {
  const parsed = parseRegistryNpmSpec(npmSpec);
  const entry = parsed && getOfficialExternalPluginCatalogEntryForPackage(parsed.name);
  const pluginId = entry && resolveOfficialExternalPluginId(entry);
  const source =
    entry &&
    resolveOfficialExternalPluginInstallSources(entry).find(
      (candidate) => candidate.source === "npm",
    );
  // A catalog's ClawHub identity does not endorse an npm namesake.
  if (!parsed || !pluginId || !source || parseRegistryNpmSpec(source.spec)?.name !== parsed.name) {
    return null;
  }
  return {
    pluginId,
    ...(source.expectedIntegrity && source.spec === npmSpec.trim()
      ? { expectedIntegrity: source.expectedIntegrity }
      : {}),
    trustedSourceLinkedOfficialInstall: true,
  };
}
