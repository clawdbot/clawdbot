import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { normalizeTrimmedStringList } from "../../packages/normalization-core/src/string-normalization.js";
import type { ChannelConfigRuntimeSchema } from "../channels/plugins/types.config.js";
import {
  normalizeCommandDescriptorName,
  sanitizeCommandDescriptorDescription,
} from "../cli/program/command-descriptor-utils.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import { isRecord } from "../utils.js";
import type {
  PluginManifestActivation,
  PluginManifestActivationCapability,
  PluginManifestChannelCommandDefaults,
  PluginManifestChannelConfig,
  PluginManifestCliCommand,
  PluginManifestDashboard,
  PluginManifestDashboardActionVerb,
  PluginManifestDashboardDataBinding,
  PluginManifestDefaultPlatform,
  PluginManifestOnboardingScope,
  PluginManifestProviderAuthChoice,
  PluginManifestQaRunner,
  PluginManifestSetup,
  PluginManifestSetupProvider,
  PluginManifestSetupProviderAuthEvidence,
  PluginConfigUiHint,
} from "./manifest-types.js";

export function normalizeManifestActivation(value: unknown): PluginManifestActivation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const onProviders = normalizeTrimmedStringList(value.onProviders);
  const onAgentHarnesses = normalizeTrimmedStringList(value.onAgentHarnesses);
  const onCommands = normalizeTrimmedStringList(value.onCommands);
  const onChannels = normalizeTrimmedStringList(value.onChannels);
  const onRoutes = normalizeTrimmedStringList(value.onRoutes);
  const onConfigPaths = normalizeTrimmedStringList(value.onConfigPaths);
  const onStartup = typeof value.onStartup === "boolean" ? value.onStartup : undefined;
  const onCapabilities = normalizeTrimmedStringList(value.onCapabilities).filter(
    (capability): capability is PluginManifestActivationCapability =>
      capability === "provider" ||
      capability === "channel" ||
      capability === "tool" ||
      capability === "hook",
  );

  const activation = {
    ...(onStartup !== undefined ? { onStartup } : {}),
    ...(onProviders.length > 0 ? { onProviders } : {}),
    ...(onAgentHarnesses.length > 0 ? { onAgentHarnesses } : {}),
    ...(onCommands.length > 0 ? { onCommands } : {}),
    ...(onChannels.length > 0 ? { onChannels } : {}),
    ...(onRoutes.length > 0 ? { onRoutes } : {}),
    ...(onConfigPaths.length > 0 ? { onConfigPaths } : {}),
    ...(onCapabilities.length > 0 ? { onCapabilities } : {}),
  } satisfies PluginManifestActivation;

  return Object.keys(activation).length > 0 ? activation : undefined;
}

export function normalizeManifestCliCommands(
  value: unknown,
): PluginManifestCliCommand[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const seen = new Set<string>();
  const commands: PluginManifestCliCommand[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      typeof entry.description !== "string"
    ) {
      continue;
    }
    const name = normalizeCommandDescriptorName(entry.name);
    const description = sanitizeCommandDescriptorDescription(entry.description);
    if (!name || !description || typeof entry.hasSubcommands !== "boolean" || seen.has(name)) {
      continue;
    }
    seen.add(name);
    commands.push({ name, description, hasSubcommands: entry.hasSubcommands });
  }
  return commands;
}

const MANIFEST_DEFAULT_ENABLEMENT_PLATFORMS = new Set<PluginManifestDefaultPlatform>([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
  "netbsd",
]);

export function normalizeManifestDefaultPlatforms(value: unknown): PluginManifestDefaultPlatform[] {
  return normalizeTrimmedStringList(value).filter(
    (platform): platform is PluginManifestDefaultPlatform =>
      MANIFEST_DEFAULT_ENABLEMENT_PLATFORMS.has(platform as PluginManifestDefaultPlatform),
  );
}

function normalizeManifestSetupProviders(
  value: unknown,
): PluginManifestSetupProvider[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: PluginManifestSetupProvider[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = normalizeOptionalString(entry.id) ?? "";
    if (!id) {
      continue;
    }
    const authMethods = normalizeTrimmedStringList(entry.authMethods);
    const envVars = normalizeTrimmedStringList(entry.envVars);
    const authEvidence = normalizeManifestSetupProviderAuthEvidence(entry.authEvidence);
    normalized.push({
      id,
      ...(authMethods.length > 0 ? { authMethods } : {}),
      ...(envVars.length > 0 ? { envVars } : {}),
      ...(authEvidence ? { authEvidence } : {}),
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeManifestSetupProviderAuthEvidence(
  value: unknown,
): PluginManifestSetupProviderAuthEvidence[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: PluginManifestSetupProviderAuthEvidence[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || entry.type !== "local-file-with-env") {
      continue;
    }
    const credentialMarker = normalizeOptionalString(entry.credentialMarker);
    if (!credentialMarker) {
      continue;
    }
    const fileEnvVar = normalizeOptionalString(entry.fileEnvVar);
    const fallbackPaths = normalizeTrimmedStringList(entry.fallbackPaths);
    if (!fileEnvVar && fallbackPaths.length === 0) {
      continue;
    }
    const requiresAnyEnv = normalizeTrimmedStringList(entry.requiresAnyEnv);
    const requiresAllEnv = normalizeTrimmedStringList(entry.requiresAllEnv);
    const source = normalizeOptionalString(entry.source);
    normalized.push({
      type: "local-file-with-env",
      ...(fileEnvVar ? { fileEnvVar } : {}),
      ...(fallbackPaths.length > 0 ? { fallbackPaths } : {}),
      ...(requiresAnyEnv.length > 0 ? { requiresAnyEnv } : {}),
      ...(requiresAllEnv.length > 0 ? { requiresAllEnv } : {}),
      credentialMarker,
      ...(source ? { source } : {}),
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeManifestSetup(value: unknown): PluginManifestSetup | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const providers = normalizeManifestSetupProviders(value.providers);
  const cliBackends = normalizeTrimmedStringList(value.cliBackends);
  const configMigrations = normalizeTrimmedStringList(value.configMigrations);
  const requiresRuntime =
    typeof value.requiresRuntime === "boolean" ? value.requiresRuntime : undefined;
  const setup = {
    ...(providers ? { providers } : {}),
    ...(cliBackends.length > 0 ? { cliBackends } : {}),
    ...(configMigrations.length > 0 ? { configMigrations } : {}),
    ...(requiresRuntime !== undefined ? { requiresRuntime } : {}),
  } satisfies PluginManifestSetup;
  return Object.keys(setup).length > 0 ? setup : undefined;
}

export function normalizeManifestQaRunners(value: unknown): PluginManifestQaRunner[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: PluginManifestQaRunner[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const commandName = normalizeOptionalString(entry.commandName) ?? "";
    if (!commandName) {
      continue;
    }
    const description = normalizeOptionalString(entry.description) ?? "";
    normalized.push({
      commandName,
      ...(description ? { description } : {}),
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

type DashboardManifestResult =
  | { ok: true; dashboard?: PluginManifestDashboard }
  | { ok: false; error: string };

function normalizeDashboardCapabilityBase(
  value: unknown,
  field: string,
  index: number,
): { id: string; method: string; description: string } | string {
  if (!isRecord(value)) {
    return `${field}[${index}] must be an object`;
  }
  const id = normalizeOptionalString(value.id);
  const method = normalizeOptionalString(value.method);
  const description = normalizeOptionalString(value.description);
  if (!id || !/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
    return `${field}[${index}].id must be a lowercase capability id`;
  }
  if (!method) {
    return `${field}[${index}].method must be a non-empty string`;
  }
  if (!description) {
    return `${field}[${index}].description must be a non-empty string`;
  }
  return { id, method, description };
}

export function normalizeManifestDashboard(value: unknown): DashboardManifestResult {
  if (value === undefined) {
    return { ok: true };
  }
  if (!isRecord(value)) {
    return { ok: false, error: "dashboard must be an object" };
  }
  if (value.dataBindings !== undefined && !Array.isArray(value.dataBindings)) {
    return { ok: false, error: "dashboard.dataBindings must be an array" };
  }
  if (value.actionVerbs !== undefined && !Array.isArray(value.actionVerbs)) {
    return { ok: false, error: "dashboard.actionVerbs must be an array" };
  }

  const dataBindings: PluginManifestDashboardDataBinding[] = [];
  for (const [index, entry] of (value.dataBindings ?? []).entries()) {
    const normalized = normalizeDashboardCapabilityBase(entry, "dashboard.dataBindings", index);
    if (typeof normalized === "string") {
      return { ok: false, error: normalized };
    }
    dataBindings.push(normalized);
  }

  const actionVerbs: PluginManifestDashboardActionVerb[] = [];
  for (const [index, entry] of (value.actionVerbs ?? []).entries()) {
    const normalized = normalizeDashboardCapabilityBase(entry, "dashboard.actionVerbs", index);
    if (typeof normalized === "string") {
      return { ok: false, error: normalized };
    }
    const rawParamShape = isRecord(entry) ? entry.paramShape : undefined;
    if (rawParamShape !== undefined && !isRecord(rawParamShape)) {
      return {
        ok: false,
        error: `dashboard.actionVerbs[${index}].paramShape must be a JSON Schema object`,
      };
    }
    actionVerbs.push({
      ...normalized,
      ...(rawParamShape ? { paramShape: rawParamShape as JsonSchemaObject } : {}),
    });
  }

  if (dataBindings.length === 0 && actionVerbs.length === 0) {
    return { ok: true };
  }
  return {
    ok: true,
    dashboard: {
      ...(dataBindings.length > 0 ? { dataBindings } : {}),
      ...(actionVerbs.length > 0 ? { actionVerbs } : {}),
    },
  };
}

function normalizeManifestHttpsUrl(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  try {
    const url = new URL(normalized);
    const canonical = url.toString();
    return url.protocol === "https:" &&
      url.hostname &&
      !url.username &&
      !url.password &&
      canonical.length <= 2048
      ? canonical
      : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeProviderAuthChoices(
  value: unknown,
): PluginManifestProviderAuthChoice[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: PluginManifestProviderAuthChoice[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const provider = normalizeOptionalString(entry.provider) ?? "";
    const method = normalizeOptionalString(entry.method) ?? "";
    const choiceId = normalizeOptionalString(entry.choiceId) ?? "";
    if (!provider || !method || !choiceId) {
      continue;
    }
    const choiceLabel = normalizeOptionalString(entry.choiceLabel) ?? "";
    const choiceHint = normalizeOptionalString(entry.choiceHint) ?? "";
    const icon = normalizeManifestHttpsUrl(entry.icon);
    const website = normalizeManifestHttpsUrl(entry.website);
    const assistantPriority =
      typeof entry.assistantPriority === "number" && Number.isFinite(entry.assistantPriority)
        ? entry.assistantPriority
        : undefined;
    const assistantVisibility =
      entry.assistantVisibility === "manual-only" || entry.assistantVisibility === "visible"
        ? entry.assistantVisibility
        : undefined;
    const deprecatedChoiceIds = normalizeTrimmedStringList(entry.deprecatedChoiceIds);
    const groupId = normalizeOptionalString(entry.groupId) ?? "";
    const groupLabel = normalizeOptionalString(entry.groupLabel) ?? "";
    const groupHint = normalizeOptionalString(entry.groupHint) ?? "";
    const onboardingFeatured = entry.onboardingFeatured === true;
    const optionKey = normalizeOptionalString(entry.optionKey) ?? "";
    const cliFlag = normalizeOptionalString(entry.cliFlag) ?? "";
    const cliOption = normalizeOptionalString(entry.cliOption) ?? "";
    const cliDescription = normalizeOptionalString(entry.cliDescription) ?? "";
    const appGuidedSecret = entry.appGuidedSecret === true;
    const appGuidedActionLabel = normalizeOptionalString(entry.appGuidedActionLabel) ?? "";
    const appGuidedAuth =
      entry.appGuidedAuth === "oauth" || entry.appGuidedAuth === "device-code"
        ? entry.appGuidedAuth
        : undefined;
    const onboardingScopes = normalizeTrimmedStringList(entry.onboardingScopes).filter(
      (scope): scope is PluginManifestOnboardingScope =>
        scope === "text-inference" || scope === "image-generation" || scope === "music-generation",
    );
    const appGuidedDiscovery = entry.appGuidedDiscovery === true;
    normalized.push({
      provider,
      method,
      choiceId,
      ...(choiceLabel ? { choiceLabel } : {}),
      ...(choiceHint ? { choiceHint } : {}),
      ...(icon ? { icon } : {}),
      ...(website ? { website } : {}),
      ...(assistantPriority !== undefined ? { assistantPriority } : {}),
      ...(assistantVisibility ? { assistantVisibility } : {}),
      ...(deprecatedChoiceIds.length > 0 ? { deprecatedChoiceIds } : {}),
      ...(groupId ? { groupId } : {}),
      ...(groupLabel ? { groupLabel } : {}),
      ...(groupHint ? { groupHint } : {}),
      ...(onboardingFeatured ? { onboardingFeatured: true } : {}),
      ...(appGuidedDiscovery ? { appGuidedDiscovery: true } : {}),
      ...(optionKey ? { optionKey } : {}),
      ...(cliFlag ? { cliFlag } : {}),
      ...(cliOption ? { cliOption } : {}),
      ...(cliDescription ? { cliDescription } : {}),
      ...(appGuidedSecret ? { appGuidedSecret: true } : {}),
      ...(appGuidedActionLabel ? { appGuidedActionLabel } : {}),
      ...(appGuidedAuth ? { appGuidedAuth } : {}),
      ...(onboardingScopes.length > 0 ? { onboardingScopes } : {}),
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeConfigUiHints(
  value: unknown,
): Record<string, PluginConfigUiHint> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Record<string, PluginConfigUiHint> = Object.create(null);
  for (const [hintPath, rawHint] of Object.entries(value)) {
    if (!isRecord(rawHint)) {
      continue;
    }
    const hint = { ...rawHint } as Record<string, unknown>;
    if ("presentation" in hint && hint.presentation !== "phone-number") {
      delete hint.presentation;
    }
    normalized[hintPath] = hint as PluginConfigUiHint;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeChannelConfigs(
  value: unknown,
): Record<string, PluginManifestChannelConfig> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Record<string, PluginManifestChannelConfig> = Object.create(null);
  for (const [key, rawEntry] of Object.entries(value)) {
    const channelId = normalizeOptionalString(key) ?? "";
    if (!channelId || isBlockedObjectKey(channelId) || !isRecord(rawEntry)) {
      continue;
    }
    const schema = isRecord(rawEntry.schema) ? rawEntry.schema : null;
    if (!schema) {
      continue;
    }
    const uiHints = normalizeConfigUiHints(rawEntry.uiHints);
    const runtime =
      isRecord(rawEntry.runtime) && typeof rawEntry.runtime.safeParse === "function"
        ? (rawEntry.runtime as ChannelConfigRuntimeSchema)
        : undefined;
    const label = normalizeOptionalString(rawEntry.label) ?? "";
    const description = normalizeOptionalString(rawEntry.description) ?? "";
    const preferOver = normalizeTrimmedStringList(rawEntry.preferOver);
    const commandDefaults = normalizeManifestChannelCommandDefaults(rawEntry.commands);
    normalized[channelId] = {
      schema,
      ...(uiHints ? { uiHints } : {}),
      ...(runtime ? { runtime } : {}),
      ...(label ? { label } : {}),
      ...(description ? { description } : {}),
      ...(preferOver.length > 0 ? { preferOver } : {}),
      ...(commandDefaults ? { commands: commandDefaults } : {}),
    };
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeManifestChannelCommandDefaults(
  value: unknown,
): PluginManifestChannelCommandDefaults | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const nativeCommandsAutoEnabled =
    typeof value.nativeCommandsAutoEnabled === "boolean"
      ? value.nativeCommandsAutoEnabled
      : undefined;
  const nativeSkillsAutoEnabled =
    typeof value.nativeSkillsAutoEnabled === "boolean" ? value.nativeSkillsAutoEnabled : undefined;
  return nativeCommandsAutoEnabled !== undefined || nativeSkillsAutoEnabled !== undefined
    ? {
        ...(nativeCommandsAutoEnabled !== undefined ? { nativeCommandsAutoEnabled } : {}),
        ...(nativeSkillsAutoEnabled !== undefined ? { nativeSkillsAutoEnabled } : {}),
      }
    : undefined;
}
