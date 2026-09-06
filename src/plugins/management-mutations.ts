// Owns managed plugin install, policy and uninstall mutations under the lifecycle lease.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { collectChangedPaths } from "../config/config-change-paths.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshot,
  replaceConfigFile,
} from "../config/config.js";
import { ensurePluginAllowlisted } from "../config/plugins-allowlist.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  resolvePluginCapabilityConsent,
  type PluginCapabilityConsentAcknowledgment,
  type PluginCapabilityConsentHandler,
} from "./capability-consent.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "./clawhub-error-codes.js";
import { normalizePluginId } from "./config-state.js";
import { resolvePluginControlPlaneWorkspace } from "./control-plane-workspace.js";
import { getProcessGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import { enableExplicitlySelectedPluginInConfig } from "./enable.js";
import type { InstallPolicyWarningDetails } from "./install-security-scan.types.js";
import { createInstalledPluginOwnershipResolver } from "./installed-plugin-package-ownership.js";
import {
  type ManagedPluginCatalogEntry,
  loadOfficialCatalog,
  resolveOfficialEntryById,
} from "./management-catalog.js";
import { readPluginMutationSnapshot } from "./management-config.js";
import {
  type ManagedPluginSourceInstallRequest,
  installManagedPluginSource,
} from "./management-install.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import {
  loadFreshManagedPluginMetadata,
  refreshManagedPluginMetadata,
  listManagedPlugins,
} from "./management-service.js";
import {
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginInstallSources,
  type OfficialExternalPluginCatalogEntry,
} from "./official-external-plugin-catalog.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { refreshPluginRegistryAfterConfigMutation } from "./registry-refresh.js";
import { applySlotSelectionForPlugin } from "./slot-selection.js";
import { setPluginEnabledInConfig } from "./toggle-config.js";

type ManagedPluginInstallRequest =
  | {
      source: "clawhub";
      packageName: string;
      version?: string;
      acknowledgeInstallPolicyWarning?: true;
      acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
    }
  | {
      source: "official";
      pluginId: string;
      acknowledgeInstallPolicyWarning?: true;
      acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
    };

function createSilentRuntime(): RuntimeEnv {
  return {
    log: () => undefined,
    error: () => undefined,
    exit: (code) => {
      throw new ManagedPluginLifecycleError(`plugin lifecycle exited with code ${code}`);
    },
  };
}

function createInstallLogger(warnings: string[]) {
  return {
    info: () => undefined,
    warn: (message: string) => warnings.push(message),
  };
}

/** Explicitly declared runtime id, ignoring the entry-id fallback used for display. */
function resolveDeclaredOfficialPluginId(
  entry: OfficialExternalPluginCatalogEntry,
): string | undefined {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  return (
    normalizeOptionalString(manifest?.plugin?.id) ??
    normalizeOptionalString(manifest?.channel?.id) ??
    normalizeOptionalString(manifest?.providers?.[0]?.id)
  );
}

function resolveOfficialEntryByClawHubPackage(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  packageName: string,
): OfficialExternalPluginCatalogEntry | undefined {
  // Bundled identities remain the local trust anchor when a hosted feed omits
  // its ClawHub candidate; hosted install/version metadata is never copied back.
  return [...listOfficialExternalPluginCatalogEntries(), ...entries].find((entry) => {
    return resolveOfficialExternalPluginInstallSources(entry).some(
      (source) =>
        source.source === "clawhub" && parseClawHubPluginSpec(source.spec)?.name === packageName,
    );
  });
}

function resolveHostedOfficialEntryByClawHubPackage(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  packageName: string,
): OfficialExternalPluginCatalogEntry | undefined {
  return entries.find((entry) => {
    return resolveOfficialExternalPluginInstallSources(entry).some(
      (source) =>
        source.source === "clawhub" && parseClawHubPluginSpec(source.spec)?.name === packageName,
    );
  });
}

function buildClawHubSpec(packageName: string, version?: string): string {
  const parsed = parseClawHubPluginSpec(`clawhub:${packageName}`);
  if (!parsed || parsed.version) {
    throw new ManagedPluginLifecycleError(`invalid ClawHub package name: ${packageName}`);
  }
  return `clawhub:${packageName}${version ? `@${version}` : ""}`;
}

function throwInstallFailure(result: {
  error: string;
  code?: string;
  version?: string;
  warning?: string;
  installPolicyWarning?: InstallPolicyWarningDetails;
}): never {
  const unavailable =
    !result.code ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_UNAVAILABLE ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_DOWNLOAD_UNAVAILABLE ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE;
  throw new ManagedPluginLifecycleError(result.error, {
    kind: unavailable ? "unavailable" : "invalid-request",
    code: result.code,
    version: result.version,
    warning: result.warning,
    installPolicyWarning: result.installPolicyWarning,
    cause: result,
  });
}

function resolveManagedClawHubInstallRequest(params: {
  request: Extract<ManagedPluginInstallRequest, { source: "clawhub" }>;
  officialEntries: readonly OfficialExternalPluginCatalogEntry[];
  expectedIntegrity?: string;
}): Extract<ManagedPluginSourceInstallRequest, { source: "clawhub" }> {
  const packageName = params.request.packageName.trim();
  const official = resolveOfficialEntryByClawHubPackage(params.officialEntries, packageName);
  // Pin the runtime id only when the catalog entry declares one; the entry-id
  // fallback is just the package name and would reject legitimate installs.
  const expectedPluginId = official ? resolveDeclaredOfficialPluginId(official) : undefined;
  const hostedOfficial = resolveHostedOfficialEntryByClawHubPackage(
    params.officialEntries,
    packageName,
  );
  const hostedSource = hostedOfficial
    ? resolveOfficialExternalPluginInstallSources(hostedOfficial).find(
        (source) => source.source === "clawhub",
      )
    : undefined;
  const hostedClawHub = parseClawHubPluginSpec(hostedSource?.spec ?? "");
  const requestMatchesHostedCandidate =
    !params.request.version || params.request.version === hostedClawHub?.version;
  const version =
    params.request.version ?? (requestMatchesHostedCandidate ? hostedClawHub?.version : undefined);
  const expectedIntegrity =
    params.expectedIntegrity ??
    (requestMatchesHostedCandidate ? hostedSource?.expectedIntegrity : undefined);
  return {
    source: "clawhub",
    spec: buildClawHubSpec(packageName, version),
    ...(official ? { trustedSourceLinkedOfficialInstall: true } : {}),
    ...(expectedPluginId ? { expectedPluginId } : {}),
    ...(expectedIntegrity ? { expectedIntegrity } : {}),
  };
}

function resolveManagedOfficialInstallRequest(params: {
  request: Extract<ManagedPluginInstallRequest, { source: "official" }>;
  officialEntries: readonly OfficialExternalPluginCatalogEntry[];
}): ManagedPluginSourceInstallRequest {
  const entry = resolveOfficialEntryById(params.officialEntries, params.request.pluginId);
  if (!entry) {
    throw new ManagedPluginLifecycleError(
      `unknown official plugin catalog entry: ${params.request.pluginId}`,
    );
  }
  const pluginId = resolveOfficialExternalPluginId(entry);
  const install = resolveOfficialExternalPluginInstall(entry);
  if (!pluginId || !install) {
    throw new ManagedPluginLifecycleError(
      `official plugin catalog entry is not installable: ${params.request.pluginId}`,
    );
  }
  const installSources = resolveOfficialExternalPluginInstallSources(entry);
  const primary = installSources[0];
  if (!primary) {
    throw new ManagedPluginLifecycleError(
      `official plugin catalog entry has no supported install source: ${params.request.pluginId}`,
    );
  }
  return {
    source: "official",
    spec: primary.spec,
    installSources,
    pluginId,
    expectedPluginId: resolveDeclaredOfficialPluginId(entry),
    mode: "install",
  };
}

/** Install a ClawHub or curated official plugin through the canonical install pipeline. */
export async function installManagedPlugin(params: {
  request: ManagedPluginInstallRequest;
  env?: NodeJS.ProcessEnv;
}): Promise<{ plugin: ManagedPluginCatalogEntry; warnings?: string[] }> {
  const env = params.env ?? process.env;
  return await withPluginLifecycleLease({ env }, async () => {
    const snapshot = await readPluginMutationSnapshot(env);
    const officialCatalog = await loadOfficialCatalog();
    const warnings: string[] = [];
    const installLogger = createInstallLogger(warnings);
    const request =
      params.request.source === "clawhub"
        ? resolveManagedClawHubInstallRequest({
            request: params.request,
            officialEntries: officialCatalog.entries,
          })
        : resolveManagedOfficialInstallRequest({
            request: params.request,
            officialEntries: officialCatalog.entries,
          });
    const installed = await installManagedPluginSource({
      request,
      snapshot,
      env,
      logger: installLogger,
      ...(params.request.acknowledgeCapabilities
        ? { acknowledgeCapabilities: params.request.acknowledgeCapabilities }
        : {}),
      ...(params.request.acknowledgeInstallPolicyWarning
        ? {
            safetyOverrides: {
              onInstallPolicyWarning: async () => ({ status: "approved" as const }),
            },
          }
        : {}),
      invalidateRuntimeCache: false,
      runtime: createSilentRuntime(),
    });
    if (!installed.ok) {
      return throwInstallFailure(installed);
    }
    warnings.push(...(installed.warnings ?? []));
    const workspace = resolvePluginControlPlaneWorkspace({ config: installed.config, env });
    if (workspace.diagnostic && !getProcessGatewayPluginMetadataSnapshot()) {
      warnings.push(workspace.diagnostic.message);
    }
    // Management inspects the committed candidate; the Gateway keeps its boot inventory.
    const installedMetadata = refreshManagedPluginMetadata({ config: installed.config, env });
    const catalog = await listManagedPlugins({
      config: installed.config,
      env,
      officialCatalog,
      metadata: installedMetadata,
    });
    const installedOwnership = createInstalledPluginOwnershipResolver(
      installedMetadata.index,
      env,
    ).resolvePackage(installed.pluginId);
    if (!installedOwnership.ok) {
      throw new ManagedPluginLifecycleError(installedOwnership.error);
    }
    const installedPluginIds = installedOwnership.value.pluginIds;
    const representativePluginId = installedPluginIds[0]!;
    const plugin = catalog.plugins.find((entry) => entry.id === representativePluginId);
    if (!plugin) {
      throw new ManagedPluginLifecycleError(
        `installed plugin missing from refreshed registry: ${installed.pluginId}`,
      );
    }
    return {
      plugin,
      ...(installedPluginIds.length > 1 || warnings.length > 0
        ? {
            warnings: [
              ...(installedPluginIds.length > 1
                ? [
                    `Installed package "${installed.pluginId}" with plugin entries: ${installedPluginIds.join(", ")}.`,
                  ]
                : []),
              ...new Set(warnings),
            ],
          }
        : {}),
    };
  });
}

type ManagedPluginEnableRequest = {
  pluginId: string;
  enabled: boolean;
  acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
  env?: NodeJS.ProcessEnv;
};

/** Commit plugin policy without requiring the management catalog's hosted projection. */
export async function mutateManagedPluginEnabled(
  params: ManagedPluginEnableRequest & {
    caller: "cli" | "management";
    onCapabilityConsent?: PluginCapabilityConsentHandler;
    requestCapabilityConsent?: boolean;
  },
) {
  const env = params.env ?? process.env;
  const cli = params.caller === "cli";
  return await withPluginLifecycleLease({ env }, async () => {
    if (cli) {
      assertConfigWriteAllowedInCurrentMode({ env });
    }
    // CLI policy writes retain their config owner's include admission. Management
    // additionally requires the install mutation preflight before any consent.
    const snapshot = cli
      ? await readConfigFileSnapshot().then((file) => ({
          config: file.sourceConfig,
          baseHash: file.hash,
          writeOptions: {},
        }))
      : await readPluginMutationSnapshot(env);
    const metadata = loadFreshManagedPluginMetadata(snapshot.config, env);
    const pluginId = cli
      ? normalizePluginId(params.pluginId)
      : metadata.normalizePluginId(params.pluginId.trim());
    const installedPlugin = metadata.index.plugins.find((plugin) => plugin.pluginId === pluginId);
    if (!installedPlugin) {
      return { status: "missing" as const, pluginId };
    }
    const resolveConsent = async () => {
      if (params.enabled && (!installedPlugin.enabled || params.requestCapabilityConsent)) {
        await resolvePluginCapabilityConsent({
          config: snapshot.config,
          env,
          pluginId,
          acknowledge: params.acknowledgeCapabilities,
          onCapabilityConsent: params.onCapabilityConsent,
          metadata,
        });
      }
    };
    if (!cli) {
      await resolveConsent();
    }
    let next = snapshot.config;
    const slotWarnings: string[] = [];
    let policyPluginId = pluginId;
    if (params.enabled) {
      // Admin selection admits one installed plugin; CLI preserves restrictive policy.
      if (!cli && (next.plugins?.allow?.length ?? 0) > 0) {
        next = ensurePluginAllowlisted(next, pluginId);
      }
      const enableResult = enableExplicitlySelectedPluginInConfig(next, pluginId, {
        updateChannelConfig: false,
      });
      if (!enableResult.enabled) {
        return { status: "blocked" as const, pluginId, reason: enableResult.reason };
      }
      // CLI rejection precedes consent; reuse this exact config after review.
      if (cli) {
        await resolveConsent();
      }
      next = enableResult.config;
      policyPluginId = enableResult.pluginId;
      // CLI slot inspection uses the enabled config, including legacy runtime-only kinds.
      const slotResult = applySlotSelectionForPlugin(next, pluginId, cli ? undefined : metadata);
      next = slotResult.config;
      slotWarnings.push(...slotResult.warnings);
    } else {
      next = setPluginEnabledInConfig(next, pluginId, false, { updateChannelConfig: false });
    }
    const changedPaths = new Set<string>();
    collectChangedPaths(snapshot.config, next, "", changedPaths);
    await replaceConfigFile({
      nextConfig: next,
      baseHash: snapshot.baseHash,
      // CLI alias writes preserve merged canonical settings during source projection.
      writeOptions: cli
        ? { explicitSetPaths: [["plugins", "entries", policyPluginId]] }
        : snapshot.writeOptions,
    });
    const registryWarnings: string[] = [];
    await refreshPluginRegistryAfterConfigMutation({
      config: next,
      env,
      reason: "policy-changed",
      invalidateRuntimeCache: false,
      policyPluginIds: [policyPluginId],
      logger: { warn: (message) => registryWarnings.push(message) },
    });
    return {
      status: "committed" as const,
      pluginId,
      config: next,
      changedPaths: [...changedPaths].filter(Boolean).toSorted(),
      warnings: cli
        ? [...registryWarnings, ...slotWarnings]
        : [...slotWarnings, ...registryWarnings],
    };
  });
}

/** Persist desired policy and project the committed candidate into the management catalog. */
export async function setManagedPluginEnabled(params: ManagedPluginEnableRequest): Promise<{
  plugin: ManagedPluginCatalogEntry;
  changedPaths: string[];
  warnings?: string[];
}> {
  const env = params.env ?? process.env;
  return await withPluginLifecycleLease({ env }, async () => {
    const result = await mutateManagedPluginEnabled({ ...params, caller: "management" });
    if (result.status !== "committed") {
      throw new ManagedPluginLifecycleError(
        result.status === "missing"
          ? `plugin not installed: ${params.pluginId}`
          : `plugin "${result.pluginId}" could not be enabled (${result.reason ?? "unknown reason"})`,
      );
    }
    const metadata = refreshManagedPluginMetadata({ config: result.config, env });
    const catalog = await listManagedPlugins({ config: result.config, env, metadata });
    const plugin = catalog.plugins.find((entry) => entry.id === result.pluginId);
    if (!plugin) {
      throw new ManagedPluginLifecycleError(
        `updated plugin missing from refreshed registry: ${result.pluginId}`,
      );
    }
    return {
      plugin,
      changedPaths: result.changedPaths,
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    };
  });
}

export { uninstallManagedPlugin } from "./management-uninstall.js";
