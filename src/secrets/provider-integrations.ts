import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ManualExecSecretProviderConfig,
  PluginIntegrationSecretProviderConfig,
} from "../config/types.secrets.js";
import { normalizePluginsConfig, type NormalizedPluginsConfig } from "../plugins/config-state.js";
import { shouldRejectHardlinkedPluginFiles } from "../plugins/hardlink-policy.js";
import { isActivatedManifestOwner } from "../plugins/manifest-owner-policy.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginManifestSecretProviderIntegration } from "../plugins/manifest.js";
import { isValidSecretProviderAlias } from "./ref-contract.js";

export type SecretProviderIntegrationPreset = {
  id: string;
  pluginId: string;
  providerAlias: string;
  displayName: string;
  description?: string;
  providerConfig: PluginIntegrationSecretProviderConfig;
};

export type SecretProviderIntegrationResolution =
  | {
      ok: true;
      providerConfig: ManualExecSecretProviderConfig;
    }
  | {
      ok: false;
      reason: string;
    };

const NODE_COMMAND_PLACEHOLDER = "${node}";
const PLUGIN_INTEGRATION_PROVIDER_ID_MAX_LENGTH = 128;

function isPathInsideOrEqual(rootDir: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(rootDir), path.resolve(candidate));
  return (
    relative === "" ||
    (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resolvePluginRelativePath(value: string, pluginRoot: string): string | undefined {
  const resolved = path.resolve(pluginRoot, value);
  return isPathInsideOrEqual(pluginRoot, resolved) ? resolved : undefined;
}

function isPluginRelativeEntrypoint(value: string): boolean {
  return value.startsWith("./");
}

function resolveArg(arg: string, pluginRoot: string): string | undefined {
  if (!arg.startsWith("./") && !arg.startsWith("../")) {
    return arg;
  }
  return resolvePluginRelativePath(arg, pluginRoot);
}

function withNodeCommandTrustedDir(command: string, pluginRoot: string): string[] {
  return command === NODE_COMMAND_PLACEHOLDER
    ? [...new Set([path.dirname(process.execPath), pluginRoot])]
    : [pluginRoot];
}

function isSecurePosixPathStat(stat: fs.Stats): boolean {
  if (process.platform === "win32") {
    return true;
  }
  if ((stat.mode & 0o022) !== 0) {
    return false;
  }
  if (typeof process.getuid !== "function" || typeof stat.uid !== "number") {
    return true;
  }
  const uid = process.getuid();
  return stat.uid === uid || stat.uid === 0;
}

function pathSegmentsBetween(rootDir: string, targetDir: string): string[] | undefined {
  const relative = path.relative(rootDir, targetDir);
  if (relative === "") {
    return [];
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(path.sep).filter(Boolean);
}

function isSecurePluginEntrypointPath(params: {
  pluginRoot: string;
  pluginRootRealpath: string;
  resolvedEntrypoint: string;
  entrypointRealpath: string;
  allowInsecurePath: boolean;
}): boolean {
  if (params.allowInsecurePath || process.platform === "win32") {
    return true;
  }
  const originalSegments = pathSegmentsBetween(
    path.resolve(params.pluginRoot),
    path.dirname(path.resolve(params.resolvedEntrypoint)),
  );
  const realpathSegments = pathSegmentsBetween(
    params.pluginRootRealpath,
    path.dirname(params.entrypointRealpath),
  );
  if (!originalSegments || !realpathSegments) {
    return false;
  }

  let originalDir = path.resolve(params.pluginRoot);
  for (const [index, segment] of ["", ...originalSegments].entries()) {
    if (segment) {
      originalDir = path.join(originalDir, segment);
    }
    const stat = fs.lstatSync(originalDir);
    if (index === 0 && stat.isSymbolicLink()) {
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isSecurePosixPathStat(stat)) {
      return false;
    }
  }

  let realpathDir = params.pluginRootRealpath;
  for (const segment of ["", ...realpathSegments]) {
    if (segment) {
      realpathDir = path.join(realpathDir, segment);
    }
    const stat = fs.lstatSync(realpathDir);
    if (!stat.isDirectory() || !isSecurePosixPathStat(stat)) {
      return false;
    }
  }

  return true;
}

function resolveNodeEntrypointArg(params: {
  integration: PluginManifestSecretProviderIntegration;
  pluginRoot: string;
  rejectHardlinks: boolean;
}): string | undefined {
  const entrypoint = params.integration.args?.[0];
  if (!entrypoint || !isPluginRelativeEntrypoint(entrypoint)) {
    return undefined;
  }
  let pluginRootRealpath: string;
  try {
    pluginRootRealpath = fs.realpathSync(params.pluginRoot);
  } catch {
    return undefined;
  }
  const resolved = resolvePluginRelativePath(entrypoint, params.pluginRoot);
  if (!resolved) {
    return undefined;
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return undefined;
  }
  if (params.rejectHardlinks && stat.nlink > 1) {
    return undefined;
  }
  if (params.integration.allowInsecurePath !== true && !isSecurePosixPathStat(stat)) {
    return undefined;
  }
  try {
    const realpath = fs.realpathSync(resolved);
    if (!isPathInsideOrEqual(pluginRootRealpath, realpath)) {
      return undefined;
    }
    if (
      !isSecurePluginEntrypointPath({
        pluginRoot: params.pluginRoot,
        pluginRootRealpath,
        resolvedEntrypoint: resolved,
        entrypointRealpath: realpath,
        allowInsecurePath: params.integration.allowInsecurePath === true,
      })
    ) {
      return undefined;
    }
    return realpath;
  } catch {
    return undefined;
  }
}

function materializeExecProviderConfig(
  integration: PluginManifestSecretProviderIntegration,
  record: PluginManifestRecord,
  env: NodeJS.ProcessEnv,
): ManualExecSecretProviderConfig | undefined {
  const pluginRoot = record.rootDir;
  if (integration.command !== NODE_COMMAND_PLACEHOLDER) {
    return undefined;
  }
  const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
    origin: record.origin,
    rootDir: pluginRoot,
    env,
  });
  const nodeEntrypoint = resolveNodeEntrypointArg({
    integration,
    pluginRoot,
    rejectHardlinks,
  });
  if (!nodeEntrypoint) {
    return undefined;
  }
  const args = integration.args
    ?.map((arg, index) =>
      nodeEntrypoint && index === 0 ? nodeEntrypoint : resolveArg(arg, pluginRoot),
    )
    .filter((arg): arg is string => arg !== undefined);
  if (integration.args && args?.length !== integration.args.length) {
    return undefined;
  }
  const trustedDirs = withNodeCommandTrustedDir(integration.command, pluginRoot);
  return {
    source: "exec",
    command: process.execPath,
    ...(args ? { args } : {}),
    ...(integration.timeoutMs !== undefined ? { timeoutMs: integration.timeoutMs } : {}),
    ...(integration.noOutputTimeoutMs !== undefined
      ? { noOutputTimeoutMs: integration.noOutputTimeoutMs }
      : {}),
    ...(integration.maxOutputBytes !== undefined
      ? { maxOutputBytes: integration.maxOutputBytes }
      : {}),
    ...(integration.jsonOnly === false ? { jsonOnly: false } : {}),
    ...(integration.env ? { env: integration.env } : {}),
    ...(integration.passEnv ? { passEnv: integration.passEnv } : {}),
    trustedDirs,
    ...(integration.command === NODE_COMMAND_PLACEHOLDER || integration.allowInsecurePath
      ? { allowInsecurePath: true }
      : {}),
  };
}

function canExposeSecretProviderIntegrations(params: {
  record: PluginManifestRecord;
  normalizedConfig: NormalizedPluginsConfig;
  config: OpenClawConfig;
}): boolean {
  if (params.record.origin !== "bundled" && params.record.origin !== "global") {
    return false;
  }
  return isActivatedManifestOwner({
    plugin: params.record,
    normalizedConfig: params.normalizedConfig,
    rootConfig: params.config,
  });
}

function integrationDisplayName(
  record: PluginManifestRecord,
  integrationId: string,
  integration: PluginManifestSecretProviderIntegration,
): string {
  return (
    normalizeOptionalString(integration.displayName) ??
    normalizeOptionalString(record.name) ??
    integrationId
  );
}

function createPluginIntegrationProviderConfig(params: {
  pluginId: string;
  integrationId: string;
}): PluginIntegrationSecretProviderConfig {
  return {
    source: "exec",
    pluginIntegration: {
      pluginId: params.pluginId,
      integrationId: params.integrationId,
    },
  };
}

function isValidPluginIntegrationProviderId(value: string): boolean {
  return value.length > 0 && value.length <= PLUGIN_INTEGRATION_PROVIDER_ID_MAX_LENGTH;
}

export function isPluginIntegrationSecretProviderConfig(
  value: unknown,
): value is PluginIntegrationSecretProviderConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "source" in value &&
    value.source === "exec" &&
    "pluginIntegration" in value &&
    typeof value.pluginIntegration === "object" &&
    value.pluginIntegration !== null &&
    "pluginId" in value.pluginIntegration &&
    typeof value.pluginIntegration.pluginId === "string" &&
    value.pluginIntegration.pluginId.trim().length > 0 &&
    "integrationId" in value.pluginIntegration &&
    typeof value.pluginIntegration.integrationId === "string" &&
    value.pluginIntegration.integrationId.trim().length > 0
  );
}

export function resolveSecretProviderIntegrationConfig(params: {
  manifestRegistry: Pick<PluginManifestRegistry, "plugins">;
  providerAlias: string;
  providerConfig: PluginIntegrationSecretProviderConfig;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): SecretProviderIntegrationResolution {
  const config = params.config ?? {};
  const normalizedConfig = normalizePluginsConfig(config.plugins);
  const env = params.env ?? process.env;
  const { pluginId, integrationId } = params.providerConfig.pluginIntegration;
  if (!isValidSecretProviderAlias(params.providerAlias)) {
    return {
      ok: false,
      reason: `provider alias "${params.providerAlias}" is invalid`,
    };
  }
  const record = params.manifestRegistry.plugins.find((candidate) => candidate.id === pluginId);
  if (!record) {
    return {
      ok: false,
      reason: `plugin "${pluginId}" is not installed`,
    };
  }
  if (!canExposeSecretProviderIntegrations({ record, normalizedConfig, config })) {
    return {
      ok: false,
      reason: `plugin "${pluginId}" is not active or is not from a trusted install origin`,
    };
  }
  const integration = record.secretProviderIntegrations?.[integrationId];
  if (!integration) {
    return {
      ok: false,
      reason: `plugin "${record.id}" does not declare secret provider integration "${integrationId}"`,
    };
  }
  const materialized = materializeExecProviderConfig(integration, record, env);
  if (!materialized) {
    return {
      ok: false,
      reason: `plugin "${record.id}" integration "${integrationId}" could not be materialized`,
    };
  }
  return {
    ok: true,
    providerConfig: materialized,
  };
}

export function listSecretProviderIntegrationPresets(params: {
  manifestRegistry: Pick<PluginManifestRegistry, "plugins">;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): SecretProviderIntegrationPreset[] {
  const presets: SecretProviderIntegrationPreset[] = [];
  const config = params.config ?? {};
  const normalizedConfig = normalizePluginsConfig(config.plugins);
  const env = params.env ?? process.env;
  for (const record of params.manifestRegistry.plugins) {
    if (!canExposeSecretProviderIntegrations({ record, normalizedConfig, config })) {
      continue;
    }
    for (const [integrationId, integration] of Object.entries(
      record.secretProviderIntegrations ?? {},
    )) {
      const providerAlias = normalizeOptionalString(integration.providerAlias) ?? integrationId;
      if (
        !isValidSecretProviderAlias(providerAlias) ||
        !isValidPluginIntegrationProviderId(record.id) ||
        !isValidPluginIntegrationProviderId(integrationId)
      ) {
        continue;
      }
      const providerConfig = materializeExecProviderConfig(integration, record, env);
      if (!providerConfig) {
        continue;
      }
      presets.push({
        id: integrationId,
        pluginId: record.id,
        providerAlias,
        displayName: integrationDisplayName(record, integrationId, integration),
        ...(integration.description ? { description: integration.description } : {}),
        providerConfig: createPluginIntegrationProviderConfig({
          pluginId: record.id,
          integrationId,
        }),
      });
    }
  }
  return presets.toSorted((left, right) =>
    `${left.displayName}:${left.providerAlias}`.localeCompare(
      `${right.displayName}:${right.providerAlias}`,
    ),
  );
}
