import {
  loadOpenClawProviderIndex,
  type OpenClawProviderIndexProvider,
} from "../model-catalog/index.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import {
  describePluginInstallSource,
  type PluginInstallSourceInfo,
} from "./install-source-info.js";
import type { InstalledPluginInstallRecordInfo } from "./installed-plugin-index.js";
import type { PluginPackageInstall } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { loadPluginRegistrySnapshot, type PluginRegistryRecord } from "./plugin-registry.js";
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
  packageName?: string;
};
type PreferredInstallSources = {
  installedPluginIds: ReadonlySet<string>;
  installsByPluginId: Map<string, PreferredInstallSource>;
};

const INSTALL_ORIGIN_PRIORITY: Readonly<Record<PluginOrigin, number>> = {
  config: 0,
  bundled: 1,
  global: 2,
  workspace: 3,
};

function isPreferredOrigin(candidate: PluginOrigin, current: PluginOrigin | undefined): boolean {
  return !current || INSTALL_ORIGIN_PRIORITY[candidate] < INSTALL_ORIGIN_PRIORITY[current];
}

function normalizeDefaultChoice(value: unknown): PluginPackageInstall["defaultChoice"] | undefined {
  return value === "npm" || value === "local" ? value : undefined;
}

function resolveInstallInfoFromInstallRecord(
  record: InstalledPluginInstallRecordInfo | undefined,
): PluginPackageInstall | null {
  if (!record) {
    return null;
  }
  const npmSpec = (record.resolvedSpec ?? record.spec)?.trim();
  const localPath = (record.installPath ?? record.sourcePath)?.trim();
  if (record.source === "npm" && npmSpec) {
    return {
      npmSpec,
      defaultChoice: "npm",
      ...(record.integrity ? { expectedIntegrity: record.integrity } : {}),
    };
  }
  if (record.source === "path" && localPath) {
    return {
      localPath,
      defaultChoice: "local",
    };
  }
  return null;
}

function resolveInstallInfoFromPackageSource(params: {
  origin: PluginOrigin;
  source?: PluginInstallSourceInfo;
}): PluginPackageInstall | null {
  const npmSpec =
    params.origin === "bundled" || params.origin === "config"
      ? params.source?.npm?.spec
      : undefined;
  const localPath = params.source?.local?.path;
  if (!npmSpec && !localPath) {
    return null;
  }
  const defaultChoice = normalizeDefaultChoice(params.source?.defaultChoice);
  return {
    ...(npmSpec ? { npmSpec } : {}),
    ...(localPath ? { localPath } : {}),
    ...(defaultChoice ? { defaultChoice } : npmSpec ? { defaultChoice: "npm" as const } : {}),
    ...(npmSpec && params.source?.npm?.expectedIntegrity
      ? { expectedIntegrity: params.source.npm.expectedIntegrity }
      : {}),
  };
}

function resolveInstallInfoFromRegistryRecord(params: {
  record: PluginRegistryRecord;
  installRecord?: InstalledPluginInstallRecordInfo;
}): PluginPackageInstall | null {
  return (
    resolveInstallInfoFromInstallRecord(params.installRecord) ??
    resolveInstallInfoFromPackageSource({
      origin: params.record.origin,
      source: params.record.packageInstall,
    })
  );
}

function resolveInstallInfoFromProviderIndex(
  provider: OpenClawProviderIndexProvider,
): PluginPackageInstall | null {
  const install = provider.plugin.install;
  if (!install) {
    return null;
  }
  const npmSpec = install.npmSpec?.trim();
  if (!npmSpec) {
    return null;
  }
  const defaultChoice = normalizeDefaultChoice(install.defaultChoice) ?? "npm";
  return {
    npmSpec,
    defaultChoice,
    ...(install.minHostVersion ? { minHostVersion: install.minHostVersion } : {}),
    ...(install.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}),
  };
}

function resolvePreferredInstallsByPluginId(
  params: ProviderInstallCatalogParams,
): PreferredInstallSources {
  const preferredByPluginId = new Map<string, PreferredInstallSource>();
  const index = loadPluginRegistrySnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const installedPluginIds = new Set(index.plugins.map((record) => record.pluginId));
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  for (const record of index.plugins) {
    if (
      record.origin === "workspace" &&
      params.includeUntrustedWorkspacePlugins === false &&
      !resolveEffectiveEnableState({
        id: record.pluginId,
        origin: record.origin,
        config: normalizedConfig,
        rootConfig: params.config,
        enabledByDefault: record.enabledByDefault,
      }).enabled
    ) {
      continue;
    }
    const install = resolveInstallInfoFromRegistryRecord({
      record,
      installRecord: index.installRecords[record.pluginId],
    });
    if (!install) {
      continue;
    }
    const existing = preferredByPluginId.get(record.pluginId);
    if (!existing || isPreferredOrigin(record.origin, existing.origin)) {
      preferredByPluginId.set(record.pluginId, {
        origin: record.origin,
        install,
        ...(record.packageName ? { packageName: record.packageName } : {}),
      });
    }
  }
  return { installedPluginIds, installsByPluginId: preferredByPluginId };
}

function resolveProviderIndexInstallCatalogEntries(params: {
  installedPluginIds: ReadonlySet<string>;
  seenChoiceIds: ReadonlySet<string>;
}): ProviderInstallCatalogEntry[] {
  const entries: ProviderInstallCatalogEntry[] = [];
  const index = loadOpenClawProviderIndex();
  for (const provider of Object.values(index.providers)) {
    if (params.installedPluginIds.has(provider.plugin.id)) {
      continue;
    }
    const install = resolveInstallInfoFromProviderIndex(provider);
    if (!install) {
      continue;
    }
    for (const choice of provider.authChoices ?? []) {
      if (params.seenChoiceIds.has(choice.choiceId)) {
        continue;
      }
      entries.push({
        pluginId: provider.plugin.id,
        providerId: provider.id,
        methodId: choice.method,
        choiceId: choice.choiceId,
        choiceLabel: choice.choiceLabel,
        ...(choice.choiceHint ? { choiceHint: choice.choiceHint } : {}),
        ...(choice.assistantPriority !== undefined
          ? { assistantPriority: choice.assistantPriority }
          : {}),
        ...(choice.assistantVisibility ? { assistantVisibility: choice.assistantVisibility } : {}),
        ...(choice.groupId ? { groupId: choice.groupId } : {}),
        ...(choice.groupLabel ? { groupLabel: choice.groupLabel } : {}),
        ...(choice.groupHint ? { groupHint: choice.groupHint } : {}),
        ...(choice.optionKey ? { optionKey: choice.optionKey } : {}),
        ...(choice.cliFlag ? { cliFlag: choice.cliFlag } : {}),
        ...(choice.cliOption ? { cliOption: choice.cliOption } : {}),
        ...(choice.cliDescription ? { cliDescription: choice.cliDescription } : {}),
        ...(choice.onboardingScopes ? { onboardingScopes: [...choice.onboardingScopes] } : {}),
        label: provider.name,
        origin: "bundled",
        install,
        installSource: describePluginInstallSource(install, {
          expectedPackageName: provider.plugin.package,
        }),
      });
    }
  }
  return entries;
}

export function resolveProviderInstallCatalogEntries(
  params?: ProviderInstallCatalogParams,
): ProviderInstallCatalogEntry[] {
  const installParams = params ?? {};
  const { installedPluginIds, installsByPluginId } =
    resolvePreferredInstallsByPluginId(installParams);
  const manifestEntries = resolveManifestProviderAuthChoices(params)
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
          installSource: describePluginInstallSource(install.install, {
            expectedPackageName: install.packageName,
          }),
        } satisfies ProviderInstallCatalogEntry,
      ];
    })
    .toSorted((left, right) => left.choiceLabel.localeCompare(right.choiceLabel));
  const seenChoiceIds = new Set(manifestEntries.map((entry) => entry.choiceId));
  const indexEntries = resolveProviderIndexInstallCatalogEntries({
    installedPluginIds,
    seenChoiceIds,
  });
  return [...manifestEntries, ...indexEntries].toSorted((left, right) =>
    left.choiceLabel.localeCompare(right.choiceLabel),
  );
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
