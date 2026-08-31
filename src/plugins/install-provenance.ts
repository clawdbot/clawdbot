// Shared policy and messaging for installs outside OpenClaw's trusted plugin sources.
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import {
  findBundledPluginSourceInMap,
  getProcessBundledPluginSources,
  type BundledPluginSource,
} from "./bundled-sources.js";
import {
  resolveCatalogOfficialExternalInstallPlan,
  resolveCatalogOfficialExternalNpmPackageTrust,
} from "./official-external-install-trust.js";

export const NON_CLAWHUB_INSTALL_FORCE_FLAG = "--force";

export type NonClawHubInstallSourceClass =
  | "git"
  | "local-archive"
  | "local-path"
  | "marketplace"
  | "npm"
  | "npm-pack";

export function resolveOpenClawTrustedNpmPackageInstall(
  npmSpec: string,
  bundledSources: ReadonlyMap<string, BundledPluginSource> = getProcessBundledPluginSources(),
): {
  pluginId: string;
  expectedIntegrity?: string;
} | null {
  const packageName = parseRegistryNpmSpec(npmSpec)?.name;
  if (!packageName) {
    return null;
  }
  const bundled = findBundledPluginSourceInMap({
    bundled: bundledSources,
    lookup: { kind: "npmSpec", value: packageName },
  });
  if (bundled) {
    return { pluginId: bundled.pluginId };
  }
  return resolveCatalogOfficialExternalNpmPackageTrust(npmSpec);
}

export function isOpenClawTrustedPluginInstallSpec(
  spec: string,
  bundledSources: ReadonlyMap<string, BundledPluginSource> = getProcessBundledPluginSources(),
): boolean {
  const trimmed = spec.trim();
  if (trimmed.toLowerCase().startsWith("clawhub:")) {
    return true;
  }
  const explicitNpm = trimmed.toLowerCase().startsWith("npm:");
  const npmSpec = explicitNpm ? trimmed.slice("npm:".length) : trimmed;
  if (explicitNpm) {
    return resolveOpenClawTrustedNpmPackageInstall(npmSpec, bundledSources) !== null;
  }
  const parsedPackageName = parseRegistryNpmSpec(npmSpec)?.name;
  const bundled =
    findBundledPluginSourceInMap({
      bundled: bundledSources,
      lookup: { kind: "pluginId", value: npmSpec },
    }) ??
    (parsedPackageName
      ? findBundledPluginSourceInMap({
          bundled: bundledSources,
          lookup: { kind: "npmSpec", value: parsedPackageName },
        })
      : undefined) ??
    findBundledPluginSourceInMap({
      bundled: bundledSources,
      lookup: { kind: "localPath", value: npmSpec },
    });
  return Boolean(
    bundled ??
    resolveOpenClawTrustedNpmPackageInstall(npmSpec, bundledSources) ??
    resolveCatalogOfficialExternalInstallPlan(npmSpec),
  );
}

const sourceClassLabels: Record<NonClawHubInstallSourceClass, string> = {
  git: "Git repository",
  "local-archive": "local archive",
  "local-path": "local path",
  marketplace: "marketplace source",
  npm: "npm registry",
  "npm-pack": "local npm-pack archive",
};

export function formatNonClawHubInstallWarning(params: {
  sourceClass: NonClawHubInstallSourceClass;
  spec: string;
}): string {
  const sourceLabel = sourceClassLabels[params.sourceClass];
  const spec = sanitizeTerminalText(params.spec);
  return [
    `WARNING - Installing plugin from ${sourceLabel}: ${spec}`,
    "This source is outside ClawHub review and trust metadata. Only continue if you trust the publisher, package contents, and install source.",
  ].join("\n");
}
