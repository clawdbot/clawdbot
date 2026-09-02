// Builds provider install catalog entries from plugin metadata.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { getRemoteModelCatalogProviderOverlay } from "../model-catalog/remote-overlay.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import {
  describePluginInstallSource,
  type PluginInstallSourceInfo,
} from "./install-source-info.js";
import type { InstalledPluginInstallRecordInfo } from "./installed-plugin-index.js";
import { normalizeProviderAuthChoices } from "./manifest-setup-normalizers.js";
import type { PluginPackageInstall } from "./manifest.js";
import {
  getOfficialExternalPluginCatalogManifest,
  resolveOfficialExternalPluginInstall,
} from "./official-external-plugin-catalog.js";
import {
  getOfficialPluginCatalogSnapshot,
  loadOfficialPluginCatalogSnapshot,
} from "./official-plugin-catalog-snapshot.js";
import { normalizePluginInstallDefaultChoice } from "./plugin-install-default-choice.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { loadPluginRegistrySnapshot, type PluginRegistryRecord } from "./plugin-registry.js";
import {
  resolveManifestProviderAuthChoices,
  type ProviderAuthChoiceMetadata,
} from "./provider-auth-choices.js";

/** Provider setup choice paired with install metadata for the owning plugin. */
export type ProviderInstallCatalogEntry = ProviderAuthChoiceMetadata & {
  providerAliases?: string[];
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
  includeWorkspacePlugins?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
};

type PreferredInstallSource = {
  origin: PluginOrigin;
  install: PluginPackageInstall;
  packageName?: string;
};
type PreferredInstallSources = {
  installedPluginIds: ReadonlySet<string>;
  installedProviderIds: ReadonlySet<string>;
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

function resolveInstallInfoFromInstallRecord(
  record: InstalledPluginInstallRecordInfo | undefined,
): PluginPackageInstall | null {
  if (!record) {
    return null;
  }
  const npmSpec = (record.resolvedSpec ?? record.spec)?.trim();
  const localPath = (record.installPath ?? record.sourcePath)?.trim();
  if (record.source === "clawhub" && record.spec?.trim()) {
    return {
      clawhubSpec: record.spec.trim(),
      defaultChoice: "clawhub",
    };
  }
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
  source?: unknown;
}): PluginPackageInstall | null {
  const source = isRecord(params.source) ? params.source : undefined;
  const npm = isRecord(source?.npm) ? source.npm : undefined;
  const clawhub = isRecord(source?.clawhub) ? source.clawhub : undefined;
  const local = isRecord(source?.local) ? source.local : undefined;
  const npmSpec =
    params.origin === "bundled" || params.origin === "config"
      ? normalizeOptionalString(npm?.spec)
      : undefined;
  const clawhubSpec =
    params.origin === "bundled" || params.origin === "config"
      ? normalizeOptionalString(clawhub?.spec)
      : undefined;
  const localPath = normalizeOptionalString(local?.path);
  if (!clawhubSpec && !npmSpec && !localPath) {
    return null;
  }
  const defaultChoice = normalizePluginInstallDefaultChoice(source?.defaultChoice);
  const expectedIntegrity = normalizeOptionalString(npm?.expectedIntegrity);
  return {
    ...(clawhubSpec ? { clawhubSpec } : {}),
    ...(npmSpec ? { npmSpec } : {}),
    ...(localPath ? { localPath } : {}),
    ...(defaultChoice
      ? { defaultChoice }
      : clawhubSpec
        ? { defaultChoice: "clawhub" as const }
        : npmSpec
          ? { defaultChoice: "npm" as const }
          : {}),
    ...(npmSpec && expectedIntegrity ? { expectedIntegrity } : {}),
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

function resolvePreferredInstallsByPluginId(
  params: ProviderInstallCatalogParams,
): PreferredInstallSources {
  const preferredByPluginId = new Map<string, PreferredInstallSource>();
  const index =
    params.metadataSnapshot?.index ??
    loadPluginRegistrySnapshot({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
  const installedPluginIds = new Set(index.plugins.map((record) => record.pluginId));
  const installedProviderIds = new Set(
    index.plugins.flatMap((record) => record.contributions?.providers ?? []),
  );
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  for (const record of index.plugins) {
    if (record.origin === "workspace" && params.includeWorkspacePlugins === false) {
      continue;
    }
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
  return { installedPluginIds, installedProviderIds, installsByPluginId: preferredByPluginId };
}

function safeCatalogId(value: unknown): string | undefined {
  const id = normalizeOptionalString(value);
  return id &&
    id.length <= 256 &&
    !isBlockedObjectKey(id) &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(id)
    ? id
    : undefined;
}

function resolveCatalogModelHint(
  params: ProviderInstallCatalogParams,
  providerId: string,
  catalog: unknown,
): string | undefined {
  const published = getRemoteModelCatalogProviderOverlay(params.config ?? {}, providerId);
  const provider =
    published ??
    (isRecord(catalog) &&
    isRecord(catalog.providers) &&
    Object.hasOwn(catalog.providers, providerId)
      ? catalog.providers[providerId]
      : undefined);
  if (!isRecord(provider) || !Array.isArray(provider.models)) {
    return undefined;
  }
  // Preview labels never become runtime model rows or configuration/default authority.
  const models = provider.models
    .filter(isRecord)
    .flatMap((model) => {
      const id = normalizeOptionalString(model.id);
      return id && id.length <= 256
        ? [{ id, name: normalizeOptionalString(model.name) ?? id }]
        : [];
    })
    .toSorted(
      (left, right) =>
        Number(right.id === provider.defaultModel) - Number(left.id === provider.defaultModel) ||
        left.id.localeCompare(right.id),
    );
  const labels = [...new Set(models.map((model) => model.name))].slice(0, 3);
  return labels.length ? `Models: ${labels.join(", ")}`.slice(0, 256) : undefined;
}

function resolveOfficialExternalProviderInstallCatalogEntries(params: {
  installedPluginIds: ReadonlySet<string>;
  installedProviderIds: ReadonlySet<string>;
  manifestChoices: readonly ProviderAuthChoiceMetadata[];
  catalogParams: ProviderInstallCatalogParams;
}): ProviderInstallCatalogEntry[] {
  const entries: ProviderInstallCatalogEntry[] = [];
  const seenChoiceIds = new Set(params.manifestChoices.map((choice) => choice.choiceId));
  const installedProviderIds = new Set([
    ...params.installedProviderIds,
    ...params.manifestChoices.map((choice) => choice.providerId),
  ]);
  const catalogProviderOwners = new Map<string, string>();
  const catalog = getOfficialPluginCatalogSnapshot();
  for (const entry of catalog.entries) {
    const manifest = getOfficialExternalPluginCatalogManifest(entry);
    const pluginId = safeCatalogId(manifest?.plugin?.id);
    if (
      !manifest ||
      !pluginId ||
      params.installedPluginIds.has(pluginId) ||
      !Array.isArray(manifest.providers)
    ) {
      continue;
    }
    const install = resolveOfficialExternalPluginInstall(entry);
    if (!install) {
      continue;
    }
    for (const provider of manifest.providers.slice(0, 32)) {
      if (!isRecord(provider)) {
        continue;
      }
      const providerId = safeCatalogId(provider.id);
      const label =
        normalizeOptionalString(provider.name) ??
        normalizeOptionalString(manifest.plugin?.label) ??
        normalizeOptionalString(entry.title) ??
        normalizeOptionalString(entry.name);
      if (!providerId || !label || installedProviderIds.has(providerId)) {
        continue;
      }
      const owner = catalogProviderOwners.get(providerId);
      if (owner && owner !== pluginId) {
        continue;
      }
      catalogProviderOwners.set(providerId, pluginId);
      const providerAliases = normalizeUniqueTrimmedStringList(provider.aliases).filter(
        (alias) => safeCatalogId(alias) && alias !== providerId,
      );
      const rawChoices = Array.isArray(provider.authChoices)
        ? provider.authChoices.slice(0, 16)
        : [];
      // Scope a copy so setup never mutates the accepted catalog snapshot.
      const providerScope = { provider: providerId, appGuidedDiscovery: false };
      const choices =
        normalizeProviderAuthChoices(
          rawChoices.filter(isRecord).map((choice) => Object.assign({ ...choice }, providerScope)),
        ) ?? [];
      const modelHint = resolveCatalogModelHint(
        params.catalogParams,
        providerId,
        manifest.modelCatalog,
      );
      for (const { provider: _provider, method, ...choice } of choices) {
        // Auth identifiers are opaque manifest values, not provider/plugin object keys.
        if (
          [method, choice.choiceId].some((id) => id.length > 256 || /\p{Cc}/u.test(id)) ||
          !choice.choiceLabel ||
          seenChoiceIds.has(choice.choiceId)
        ) {
          continue;
        }
        seenChoiceIds.add(choice.choiceId);
        const cliFlag = choice.cliFlag;
        const expectedKey = cliFlag
          ?.slice(2)
          .replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());
        if (
          !cliFlag ||
          !/^--[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(cliFlag) ||
          choice.optionKey !== expectedKey ||
          !choice.cliOption?.startsWith(`${cliFlag} <`) ||
          !/^--[a-z0-9-]+ <[a-zA-Z][a-zA-Z0-9-]*>$/u.test(choice.cliOption)
        ) {
          delete choice.optionKey;
          delete choice.cliFlag;
          delete choice.cliOption;
          delete choice.cliDescription;
        }
        entries.push({
          ...choice,
          pluginId,
          providerId,
          methodId: method,
          choiceLabel: choice.choiceLabel,
          ...(providerAliases.length ? { providerAliases } : {}),
          ...(!choice.choiceHint && modelHint ? { choiceHint: modelHint } : {}),
          label,
          origin: catalog.source === "bundled-fallback" ? "bundled" : "global",
          install,
          installSource: describePluginInstallSource(install, {
            expectedPackageName: entry.name ?? entry.id,
          }),
        });
      }
    }
  }
  return entries;
}

/** Lists install catalog entries for provider setup choices. */
export function resolveProviderInstallCatalogEntries(
  params?: ProviderInstallCatalogParams,
): ProviderInstallCatalogEntry[] {
  const installParams = params ?? {};
  const { installedPluginIds, installedProviderIds, installsByPluginId } =
    resolvePreferredInstallsByPluginId(installParams);
  const manifestChoices = resolveManifestProviderAuthChoices(params);
  const manifestEntries = manifestChoices
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
  const officialEntries = resolveOfficialExternalProviderInstallCatalogEntries({
    installedPluginIds,
    installedProviderIds,
    manifestChoices,
    catalogParams: installParams,
  });
  return [...manifestEntries, ...officialEntries].toSorted((left, right) =>
    left.choiceLabel.localeCompare(right.choiceLabel),
  );
}

/** Installed metadata wins; hosted choices only describe owners not installed yet. */
function resolveProviderSetupAuthChoices(
  params?: ProviderInstallCatalogParams,
): ProviderAuthChoiceMetadata[] {
  const installed = resolveManifestProviderAuthChoices(params);
  const seen = new Set(installed.map((choice) => choice.choiceId));
  const config = normalizePluginsConfig(params?.config?.plugins);
  const available = resolveProviderInstallCatalogEntries(params).filter(
    (entry) =>
      !seen.has(entry.choiceId) &&
      resolveEffectiveEnableState({
        id: entry.pluginId,
        origin: entry.origin,
        config,
        rootConfig: params?.config,
        enabledByDefault: true,
      }).enabled,
  );
  return [...installed, ...available];
}

export async function loadProviderSetupAuthChoices(
  params?: ProviderInstallCatalogParams,
): Promise<ProviderAuthChoiceMetadata[]> {
  await loadOfficialPluginCatalogSnapshot(params?.env ? { env: params.env } : undefined);
  return resolveProviderSetupAuthChoices(params);
}

/** Resolves one provider install catalog entry by setup choice id. */
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

/** Resolves an uninstalled provider's deprecated setup choice to its replacement entry. */
export function resolveDeprecatedProviderInstallCatalogEntry(
  choiceId: string,
  params?: ProviderInstallCatalogParams,
): ProviderInstallCatalogEntry | undefined {
  const normalizedChoiceId = choiceId.trim();
  if (!normalizedChoiceId) {
    return undefined;
  }
  return resolveProviderInstallCatalogEntries(params).find((entry) =>
    entry.deprecatedChoiceIds?.includes(normalizedChoiceId),
  );
}

/** Provider auth flags share the same accepted metadata snapshot as interactive setup. */
export function resolveProviderOnboardAuthFlags(
  params?: ProviderInstallCatalogParams & { installedOnly?: boolean },
) {
  const seenKeys = new Set<string>();
  const seenFlags = new Set<string>();
  const choices = params?.installedOnly
    ? resolveManifestProviderAuthChoices(params)
    : resolveProviderSetupAuthChoices(params);
  return choices.flatMap((choice) => {
    if (
      !choice.optionKey ||
      !choice.cliFlag ||
      !choice.cliOption ||
      seenKeys.has(choice.optionKey) ||
      seenFlags.has(choice.cliFlag)
    ) {
      return [];
    }
    seenKeys.add(choice.optionKey);
    seenFlags.add(choice.cliFlag);
    return [
      {
        optionKey: choice.optionKey,
        authChoice: choice.choiceId,
        cliFlag: choice.cliFlag,
        cliOption: choice.cliOption,
        description: choice.cliDescription ?? choice.choiceLabel,
      },
    ];
  });
}
