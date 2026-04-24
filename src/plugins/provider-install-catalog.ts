import path from "node:path";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import {
  describePluginInstallSource,
  type PluginInstallSourceInfo,
} from "./install-source-info.js";
import {
  loadPluginManifest,
  type PluginPackageInstall,
  type PluginManifestLoadResult,
} from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import {
  resolveManifestProviderAuthChoices,
  type ProviderAuthChoiceMetadata,
} from "./provider-auth-choices.js";

export type ProviderInstallCatalogEntry = ProviderAuthChoiceMetadata & {
  label: string;
  origin: PluginOrigin;
  install: PluginPackageInstall;
  installSource?: PluginInstallSourceInfo;
};

type ProviderInstallCatalogParams = {
  config?: import("../config/types.openclaw.js").OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUntrustedWorkspacePlugins?: boolean;
};

type PreferredInstallSource = {
  origin: PluginOrigin;
  install: PluginPackageInstall;
};

const INSTALL_ORIGIN_PRIORITY: Readonly<Record<PluginOrigin, number>> = {
  config: 0,
  bundled: 1,
  global: 2,
  workspace: 3,
};

function isPreferredOrigin(candidate: PluginOrigin, current: PluginOrigin | undefined): boolean {
  if (!current) {
    return true;
  }
  return INSTALL_ORIGIN_PRIORITY[candidate] < INSTALL_ORIGIN_PRIORITY[current];
}

function resolvePluginManifest(
  rootDir: Parameters<typeof loadPluginManifest>[0],
  rejectHardlinks: boolean,
): Extract<PluginManifestLoadResult, { ok: true }> | null {
  const manifest = loadPluginManifest(rootDir, rejectHardlinks);
  return manifest.ok ? manifest : null;
}

function resolveTrustedNpmSpec(params: {
  origin: PluginOrigin;
  install?: PluginPackageInstall;
}): string | undefined {
  if (params.origin !== "bundled" && params.origin !== "config") {
    return undefined;
  }
  const npmSpec = params.install?.npmSpec?.trim();
  if (!npmSpec) {
    return undefined;
  }
  const parsed = parseRegistryNpmSpec(npmSpec);
  return parsed ? npmSpec : undefined;
}

function resolveInstallInfo(params: {
  origin: PluginOrigin;
  install?: PluginPackageInstall;
  packageDir?: string;
  workspaceDir?: string;
}): PluginPackageInstall | null {
  const npmSpec = resolveTrustedNpmSpec({
    origin: params.origin,
    install: params.install,
  });
  let localPath = params.install?.localPath?.trim();
  if (!localPath && params.workspaceDir && params.packageDir) {
    const relative = path.relative(params.workspaceDir, params.packageDir);
    localPath = relative || undefined;
  }
  if (!npmSpec && !localPath) {
    return null;
  }
  const defaultChoice =
    params.install?.defaultChoice ?? (localPath ? "local" : npmSpec ? "npm" : undefined);
  return {
    ...(npmSpec ? { npmSpec } : {}),
    ...(localPath ? { localPath } : {}),
    ...(defaultChoice ? { defaultChoice } : {}),
    ...(params.install?.minHostVersion ? { minHostVersion: params.install.minHostVersion } : {}),
    ...(npmSpec && params.install?.expectedIntegrity
      ? { expectedIntegrity: params.install.expectedIntegrity }
      : {}),
    ...(params.install?.allowInvalidConfigRecovery === true
      ? { allowInvalidConfigRecovery: true }
      : {}),
  };
}

function resolvePreferredInstallsByPluginId(
  params: ProviderInstallCatalogParams,
): Map<string, PreferredInstallSource> {
  const preferredByPluginId = new Map<string, PreferredInstallSource>();
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  for (const candidate of discoverOpenClawPlugins({
    workspaceDir: params.workspaceDir,
    env: params.env,
  }).candidates) {
    const idHint = candidate.idHint.trim();
    if (candidate.origin === "workspace" && params.includeUntrustedWorkspacePlugins === false) {
      if (!idHint) {
        continue;
      }
      if (
        !resolveEffectiveEnableState({
          id: idHint,
          origin: candidate.origin,
          config: normalizedConfig,
          rootConfig: params.config,
        }).enabled
      ) {
        continue;
      }
    }
    const manifest = resolvePluginManifest(candidate.rootDir, candidate.origin !== "bundled");
    if (!manifest) {
      continue;
    }
    if (
      candidate.origin === "workspace" &&
      params.includeUntrustedWorkspacePlugins === false &&
      !resolveEffectiveEnableState({
        id: manifest.manifest.id,
        origin: candidate.origin,
        config: normalizedConfig,
        rootConfig: params.config,
      }).enabled
    ) {
      continue;
    }
    const install = resolveInstallInfo({
      origin: candidate.origin,
      install: candidate.packageManifest?.install,
      packageDir: candidate.packageDir,
      workspaceDir: candidate.workspaceDir,
    });
    if (!install) {
      continue;
    }
    const existing = preferredByPluginId.get(manifest.manifest.id);
    if (!existing || isPreferredOrigin(candidate.origin, existing.origin)) {
      preferredByPluginId.set(manifest.manifest.id, {
        origin: candidate.origin,
        install,
      });
    }
  }
  return preferredByPluginId;
}

export function resolveProviderInstallCatalogEntries(
  params?: ProviderInstallCatalogParams,
): ProviderInstallCatalogEntry[] {
  const installsByPluginId = resolvePreferredInstallsByPluginId(params ?? {});
  return resolveManifestProviderAuthChoices(params)
    .flatMap((choice) => {
      const install = installsByPluginId.get(choice.pluginId);
      if (!install) {
        return [];
      }
      return [
        {
          ...choice,
          label: choice.groupLabel ?? choice.choiceLabel,
          origin: install.origin,
          install: install.install,
          installSource: describePluginInstallSource(install.install),
        } satisfies ProviderInstallCatalogEntry,
      ];
    })
    .toSorted((left, right) => left.choiceLabel.localeCompare(right.choiceLabel));
}

export function resolveProviderInstallCatalogEntry(
  choiceId: string,
  params?: ProviderInstallCatalogParams,
): ProviderInstallCatalogEntry | undefined {
  const normalizedChoiceId = choiceId.trim();
  if (!normalizedChoiceId) {
    return undefined;
  }
  return resolveProviderInstallCatalogEntries(params).find(
    (entry) => entry.choiceId === normalizedChoiceId,
  );
}
