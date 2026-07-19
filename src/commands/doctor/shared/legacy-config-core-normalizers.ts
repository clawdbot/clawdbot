// Core legacy config normalizers for shipped keys retired outside the rule table.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { resolveSingleAccountKeysToMove } from "../../../channels/plugins/setup-promotion-helpers.js";
import { resolveNormalizedProviderModelMaxTokens } from "../../../config/defaults.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { DEFAULT_GOOGLE_API_BASE_URL } from "../../../infra/google-api-base-url.js";
import { DEFAULT_ACCOUNT_ID } from "../../../routing/session-key.js";
import {
  isBlockedLegacyCodexModelRef,
  type LegacyCodexModelIdentity,
} from "./codex-route-model-ref.js";
import { hasOwnKey, isRecord } from "./legacy-config-record-shared.js";
import { isLegacyModelsAddCodexMetadataModel } from "./legacy-models-add-metadata.js";
import {
  legacyRuntimeModelAliasRequiresRuntimePolicy,
  listLegacyRuntimeModelProviderAliases,
  migrateLegacyRuntimeModelRef,
} from "./legacy-runtime-model-providers.js";
export { normalizeLegacyTalkConfig } from "./legacy-talk-config-normalizer.js";

const INHERITED_ACCOUNT_POLICY_KEYS = ["dmPolicy", "allowFrom", "groupPolicy", "groupAllowFrom"];

/** Migrate legacy browser/Chrome relay config to current browser profile settings. */
export function normalizeLegacyBrowserConfig(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const rawBrowser = cfg.browser;
  if (!isRecord(rawBrowser)) {
    return cfg;
  }

  const browser = structuredClone(rawBrowser);
  let browserChanged = false;

  if ("relayBindHost" in browser) {
    delete browser.relayBindHost;
    browserChanged = true;
    changes.push(
      "Removed browser.relayBindHost (legacy Chrome extension relay setting; the extension relay binds loopback on the profile cdpPort).",
    );
  }

  // driver "extension" is a live driver again (Chrome extension relay v2). Old
  // relay-era profiles could carry a cdpUrl pointing at the retired gateway
  // relay endpoint; the new driver owns its endpoint, so drop the stale URL
  // instead of failing schema validation.
  const rawProfiles = browser.profiles;
  if (isRecord(rawProfiles)) {
    const profiles = { ...rawProfiles };
    let profilesChanged = false;
    for (const [profileName, rawProfile] of Object.entries(rawProfiles)) {
      if (!isRecord(rawProfile)) {
        continue;
      }
      const rawDriver = normalizeOptionalString(rawProfile.driver) ?? "";
      if (rawDriver !== "extension" || !normalizeOptionalString(rawProfile.cdpUrl)) {
        continue;
      }
      const nextProfile = { ...rawProfile };
      delete nextProfile.cdpUrl;
      profiles[profileName] = nextProfile;
      profilesChanged = true;
      changes.push(
        `Removed browser.profiles.${profileName}.cdpUrl (extension driver profiles own their relay endpoint).`,
      );
    }
    if (profilesChanged) {
      browser.profiles = profiles;
      browserChanged = true;
    }
  }

  const rawSsrFPolicy = browser.ssrfPolicy;
  if (isRecord(rawSsrFPolicy) && "allowPrivateNetwork" in rawSsrFPolicy) {
    const legacyAllowPrivateNetwork = rawSsrFPolicy.allowPrivateNetwork;
    const currentDangerousAllowPrivateNetwork = rawSsrFPolicy.dangerouslyAllowPrivateNetwork;

    let resolvedDangerousAllowPrivateNetwork: unknown = currentDangerousAllowPrivateNetwork;
    if (
      typeof legacyAllowPrivateNetwork === "boolean" ||
      typeof currentDangerousAllowPrivateNetwork === "boolean"
    ) {
      resolvedDangerousAllowPrivateNetwork =
        legacyAllowPrivateNetwork === true || currentDangerousAllowPrivateNetwork === true;
    } else if (currentDangerousAllowPrivateNetwork === undefined) {
      resolvedDangerousAllowPrivateNetwork = legacyAllowPrivateNetwork;
    }

    const nextSsrFPolicy: Record<string, unknown> = { ...rawSsrFPolicy };
    delete nextSsrFPolicy.allowPrivateNetwork;
    if (resolvedDangerousAllowPrivateNetwork !== undefined) {
      nextSsrFPolicy.dangerouslyAllowPrivateNetwork = resolvedDangerousAllowPrivateNetwork;
    }
    browser.ssrfPolicy = nextSsrFPolicy;
    browserChanged = true;
    changes.push(
      `Moved browser.ssrfPolicy.allowPrivateNetwork → browser.ssrfPolicy.dangerouslyAllowPrivateNetwork (${String(resolvedDangerousAllowPrivateNetwork)}).`,
    );
  }

  if (!browserChanged) {
    return cfg;
  }

  return {
    ...cfg,
    browser: browser as OpenClawConfig["browser"],
  };
}

/** Move single-account channel fields into accounts.default when account maps exist. */
export function seedMissingDefaultAccountsFromSingleAccountBase(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  if (!channels) {
    return cfg;
  }

  let channelsChanged = false;
  const nextChannels = { ...channels };
  for (const [channelId, rawChannel] of Object.entries(channels)) {
    if (!isRecord(rawChannel)) {
      continue;
    }
    const rawAccounts = rawChannel.accounts;
    if (!isRecord(rawAccounts)) {
      continue;
    }
    const accountKeys = Object.keys(rawAccounts);
    if (accountKeys.length === 0) {
      continue;
    }
    const hasDefault = accountKeys.some(
      (key) => normalizeOptionalLowercaseString(key) === DEFAULT_ACCOUNT_ID,
    );
    if (hasDefault) {
      continue;
    }
    const keysToMove = resolveSingleAccountKeysToMove({
      channelKey: channelId,
      channel: rawChannel,
    });
    if (keysToMove.length === 0) {
      continue;
    }

    const defaultAccount: Record<string, unknown> = {};
    for (const key of keysToMove) {
      const value = rawChannel[key];
      defaultAccount[key] = value && typeof value === "object" ? structuredClone(value) : value;
    }
    const nextChannel: Record<string, unknown> = {
      ...rawChannel,
    };
    for (const key of keysToMove) {
      delete nextChannel[key];
    }
    const inheritedPolicyKeys = INHERITED_ACCOUNT_POLICY_KEYS.filter((key) =>
      keysToMove.includes(key),
    );
    const nextAccounts: Record<string, unknown> = {
      ...rawAccounts,
      [DEFAULT_ACCOUNT_ID]: defaultAccount,
    };
    if (inheritedPolicyKeys.length > 0) {
      for (const [accountId, rawAccount] of Object.entries(rawAccounts)) {
        if (!isRecord(rawAccount)) {
          continue;
        }
        const nextAccount = { ...rawAccount };
        let accountChanged = false;
        for (const key of inheritedPolicyKeys) {
          if (hasOwnKey(nextAccount, key)) {
            continue;
          }
          const value = rawChannel[key];
          nextAccount[key] = value && typeof value === "object" ? structuredClone(value) : value;
          accountChanged = true;
        }
        if (accountChanged) {
          nextAccounts[accountId] = nextAccount;
        }
      }
    }
    nextChannel.accounts = nextAccounts;

    nextChannels[channelId] = nextChannel;
    channelsChanged = true;
    changes.push(
      `Moved channels.${channelId} single-account top-level values into channels.${channelId}.accounts.default.`,
    );
  }

  if (!channelsChanged) {
    return cfg;
  }

  return {
    ...cfg,
    channels: nextChannels as OpenClawConfig["channels"],
  };
}

type ModelProviderEntry = Partial<
  NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]
>;
type ModelsConfigPatch = Partial<NonNullable<OpenClawConfig["models"]>>;
type ModelDefinitionEntry = NonNullable<ModelProviderEntry["models"]>[number];
type SelectedRuntimeRef = {
  ref: string;
  runtime: string;
  requiresRuntimePolicy: boolean;
};

const LEGACY_CODEX_CLI_RUNTIME_ID = "codex-cli";
const CODEX_APP_SERVER_RUNTIME_ID = "codex";

function resolveLegacyWholeAgentRuntimePolicy(raw: unknown):
  | {
      provider: string;
      runtime: string;
      requiresRuntimePolicy: boolean;
    }
  | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const runtime = normalizeOptionalLowercaseString(raw.id);
  if (!runtime || runtime === "auto" || runtime === "openclaw") {
    return undefined;
  }
  const alias = listLegacyRuntimeModelProviderAliases().find(
    (entry) => entry.cli && normalizeProviderId(entry.runtime) === runtime,
  );
  return alias
    ? {
        provider: alias.provider,
        runtime: alias.runtime,
        requiresRuntimePolicy: alias.requiresRuntimePolicy,
      }
    : undefined;
}

function migratedRuntimeRequiresPolicy(legacyProvider: string): boolean {
  return legacyRuntimeModelAliasRequiresRuntimePolicy(legacyProvider);
}

function mergeModelEntry(legacyEntry: unknown, currentEntry: unknown): unknown {
  if (!isRecord(legacyEntry) || !isRecord(currentEntry)) {
    return currentEntry ?? legacyEntry;
  }
  return { ...legacyEntry, ...currentEntry };
}

function normalizeLegacyCodexCliAgentRuntimePolicy(raw: unknown): {
  value?: unknown;
  changed: boolean;
} {
  if (!isRecord(raw)) {
    return { value: raw, changed: false };
  }
  if (normalizeOptionalLowercaseString(raw.id) !== LEGACY_CODEX_CLI_RUNTIME_ID) {
    return { value: raw, changed: false };
  }
  return {
    value: { ...raw, id: CODEX_APP_SERVER_RUNTIME_ID },
    changed: true,
  };
}

function normalizeLegacyRuntimeAgentModelConfig(
  raw: unknown,
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
): {
  value?: unknown;
  changed: boolean;
  selectedRuntime?: string;
  selectedRuntimeRequiresPolicy: boolean;
  selectedRefs: SelectedRuntimeRef[];
} {
  if (typeof raw === "string") {
    const migrated = isBlockedLegacyCodexModelRef({ modelRef: raw, blockedModelIdentities })
      ? null
      : migrateLegacyRuntimeModelRef(raw);
    return migrated
      ? {
          value: migrated.ref,
          changed: true,
          selectedRuntime: migrated.runtime,
          selectedRuntimeRequiresPolicy: migratedRuntimeRequiresPolicy(migrated.legacyProvider),
          selectedRefs: [
            {
              ref: migrated.ref,
              runtime: migrated.runtime,
              requiresRuntimePolicy: migratedRuntimeRequiresPolicy(migrated.legacyProvider),
            },
          ],
        }
      : { value: raw, changed: false, selectedRuntimeRequiresPolicy: false, selectedRefs: [] };
  }
  if (!isRecord(raw)) {
    return { value: raw, changed: false, selectedRuntimeRequiresPolicy: false, selectedRefs: [] };
  }

  const migratedPrimary =
    typeof raw.primary === "string" &&
    !isBlockedLegacyCodexModelRef({ modelRef: raw.primary, blockedModelIdentities })
      ? migrateLegacyRuntimeModelRef(raw.primary)
      : null;
  let changed = false;
  const next: Record<string, unknown> = { ...raw };
  const selectedRefs: SelectedRuntimeRef[] = [];
  let selectedRuntime = migratedPrimary?.runtime;
  let selectedRuntimeRequiresPolicy =
    migratedPrimary !== null && migratedRuntimeRequiresPolicy(migratedPrimary.legacyProvider);
  if (migratedPrimary) {
    next.primary = migratedPrimary.ref;
    selectedRefs.push({
      ref: migratedPrimary.ref,
      runtime: migratedPrimary.runtime,
      requiresRuntimePolicy: migratedRuntimeRequiresPolicy(migratedPrimary.legacyProvider),
    });
    changed = true;
  }
  if (Array.isArray(raw.fallbacks)) {
    next.fallbacks = raw.fallbacks.map((fallback) => {
      if (typeof fallback !== "string") {
        return fallback;
      }
      const migratedFallback = isBlockedLegacyCodexModelRef({
        modelRef: fallback,
        blockedModelIdentities,
      })
        ? null
        : migrateLegacyRuntimeModelRef(fallback);
      if (
        migratedFallback &&
        (migratedFallback.runtime === selectedRuntime ||
          migratedFallback.legacyProvider === LEGACY_CODEX_CLI_RUNTIME_ID)
      ) {
        selectedRuntime ??= migratedFallback.runtime;
        selectedRuntimeRequiresPolicy ||= migratedRuntimeRequiresPolicy(
          migratedFallback.legacyProvider,
        );
        selectedRefs.push({
          ref: migratedFallback.ref,
          runtime: migratedFallback.runtime,
          requiresRuntimePolicy: migratedRuntimeRequiresPolicy(migratedFallback.legacyProvider),
        });
        changed = true;
        return migratedFallback.ref;
      }
      return fallback;
    });
  }
  if (!changed) {
    return { value: raw, changed: false, selectedRuntimeRequiresPolicy: false, selectedRefs: [] };
  }
  return {
    value: next,
    changed: true,
    selectedRuntime,
    selectedRuntimeRequiresPolicy,
    selectedRefs,
  };
}

function runtimeNeedsExplicitModelPolicy(runtime: string | undefined): runtime is string {
  return Boolean(runtime && runtime !== "codex");
}

function modelEntryWithRuntimePolicy(entry: unknown, runtime: string): Record<string, unknown> {
  const base = isRecord(entry) ? { ...entry } : {};
  const currentRuntime = isRecord(base.agentRuntime)
    ? normalizeOptionalLowercaseString(base.agentRuntime.id)
    : undefined;
  if (!currentRuntime || currentRuntime === "auto") {
    base.agentRuntime = {
      ...(isRecord(base.agentRuntime) ? base.agentRuntime : {}),
      id: runtime,
    };
  }
  return base;
}

function mergeModelEntryWithRuntimePolicy(
  legacyEntry: unknown,
  currentEntry: unknown,
  runtime: string | undefined,
  requiresRuntimePolicy = runtimeNeedsExplicitModelPolicy(runtime),
): unknown {
  const merged = mergeModelEntry(legacyEntry, currentEntry);
  return runtime && requiresRuntimePolicy ? modelEntryWithRuntimePolicy(merged, runtime) : merged;
}

function normalizeLegacyRuntimeAllowlistModels(
  rawModels: unknown,
  selectedRuntime: string | undefined,
  selectedRuntimeRequiresPolicy: boolean,
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
): {
  value?: unknown;
  changed: boolean;
} {
  if (!isRecord(rawModels)) {
    return { value: rawModels, changed: false };
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  const legacyEntries: Array<{
    migratedKey: string;
    entry: unknown;
    runtime: string;
    requiresRuntimePolicy: boolean;
  }> = [];
  for (const [rawKey, entry] of Object.entries(rawModels)) {
    const migrated = isBlockedLegacyCodexModelRef({
      modelRef: rawKey,
      blockedModelIdentities,
    })
      ? null
      : migrateLegacyRuntimeModelRef(rawKey);
    if (
      migrated &&
      (migrated.runtime === selectedRuntime ||
        migrated.legacyProvider === LEGACY_CODEX_CLI_RUNTIME_ID)
    ) {
      changed = true;
      next[rawKey] = mergeModelEntry(entry, next[rawKey]);
      legacyEntries.push({
        migratedKey: migrated.ref,
        entry,
        runtime: migrated.runtime,
        requiresRuntimePolicy: migratedRuntimeRequiresPolicy(migrated.legacyProvider),
      });
      continue;
    }
    next[rawKey] = mergeModelEntry(entry, next[rawKey]);
  }
  for (const { migratedKey, entry, runtime, requiresRuntimePolicy } of legacyEntries) {
    next[migratedKey] = mergeModelEntryWithRuntimePolicy(
      entry,
      next[migratedKey],
      runtime,
      requiresRuntimePolicy || (runtime === selectedRuntime && selectedRuntimeRequiresPolicy),
    );
  }
  return { value: next, changed };
}

function ensureSelectedModelRuntimePolicies(
  rawModels: unknown,
  selectedRefs: readonly SelectedRuntimeRef[],
): { value?: unknown; changed: boolean } {
  if (selectedRefs.length === 0) {
    return { value: rawModels, changed: false };
  }
  const next: Record<string, unknown> = isRecord(rawModels) ? { ...rawModels } : {};
  let changed = false;
  for (const { ref, runtime, requiresRuntimePolicy } of selectedRefs) {
    if (!requiresRuntimePolicy) {
      continue;
    }
    const current = next[ref];
    const updated = modelEntryWithRuntimePolicy(current, runtime);
    if (JSON.stringify(updated) !== JSON.stringify(current ?? {})) {
      next[ref] = updated;
      changed = true;
    }
  }
  return { value: next, changed };
}

function selectedCanonicalModelRefsForRuntimePolicy(
  rawModel: unknown,
  provider: string,
  runtime: string,
  requiresRuntimePolicy: boolean,
): SelectedRuntimeRef[] {
  const refs: SelectedRuntimeRef[] = [];
  const addRef = (rawRef: unknown) => {
    if (typeof rawRef !== "string") {
      return;
    }
    const trimmed = rawRef.trim();
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash >= trimmed.length - 1) {
      return;
    }
    if (normalizeProviderId(trimmed.slice(0, slash)) !== normalizeProviderId(provider)) {
      return;
    }
    refs.push({ ref: trimmed, runtime, requiresRuntimePolicy });
  };

  if (typeof rawModel === "string") {
    addRef(rawModel);
    return refs;
  }
  if (!isRecord(rawModel)) {
    return refs;
  }
  addRef(rawModel.primary);
  if (Array.isArray(rawModel.fallbacks)) {
    for (const fallback of rawModel.fallbacks) {
      addRef(fallback);
    }
  }
  return refs;
}

function normalizeLegacyCodexCliRuntimePinsInModels(
  rawModels: unknown,
  path: string,
  changes: string[],
): { value?: unknown; changed: boolean } {
  if (!isRecord(rawModels)) {
    return { value: rawModels, changed: false };
  }
  let changed = false;
  const next: Record<string, unknown> = { ...rawModels };
  for (const [modelRef, rawEntry] of Object.entries(rawModels)) {
    if (!isRecord(rawEntry)) {
      continue;
    }
    const runtime = normalizeLegacyCodexCliAgentRuntimePolicy(rawEntry.agentRuntime);
    if (!runtime.changed) {
      continue;
    }
    next[modelRef] = { ...rawEntry, agentRuntime: runtime.value };
    changed = true;
    changes.push(
      `Moved ${path}.${sanitizeForLog(modelRef)} agentRuntime.id from codex-cli to codex.`,
    );
  }
  return { value: next, changed };
}

function normalizeLegacyRuntimeAgentContainer(
  raw: Record<string, unknown>,
  path: string,
  changes: string[],
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
): { value: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const next: Record<string, unknown> = { ...raw };
  const legacyWholeAgentRuntime = resolveLegacyWholeAgentRuntimePolicy(raw.agentRuntime);

  const model = normalizeLegacyRuntimeAgentModelConfig(raw.model, blockedModelIdentities);
  if (model.changed) {
    next.model = model.value;
    changed = true;
    const runtimeSuffix = model.selectedRuntime
      ? ` and selected ${model.selectedRuntime} runtime`
      : "";
    changes.push(
      `Moved ${path}.model legacy runtime primary refs to canonical provider refs${runtimeSuffix}.`,
    );
  }

  const models = normalizeLegacyRuntimeAllowlistModels(
    raw.models,
    model.selectedRuntime,
    model.selectedRuntimeRequiresPolicy,
    blockedModelIdentities,
  );
  if (models.changed) {
    next.models = models.value;
    changed = true;
    changes.push(`Moved ${path}.models legacy runtime keys to canonical provider keys.`);
  }

  if (model.selectedRuntime) {
    const modelRuntimes = ensureSelectedModelRuntimePolicies(next.models, model.selectedRefs);
    if (modelRuntimes.changed) {
      next.models = modelRuntimes.value;
      changed = true;
      changes.push(`Selected ${model.selectedRuntime} runtime for ${path}.models entries.`);
    }
  }

  if (legacyWholeAgentRuntime) {
    const selectedRefs = selectedCanonicalModelRefsForRuntimePolicy(
      next.model ?? raw.model,
      legacyWholeAgentRuntime.provider,
      legacyWholeAgentRuntime.runtime,
      legacyWholeAgentRuntime.requiresRuntimePolicy,
    );
    const modelRuntimes = ensureSelectedModelRuntimePolicies(next.models, selectedRefs);
    if (modelRuntimes.changed) {
      next.models = modelRuntimes.value;
      changed = true;
      changes.push(
        `Moved ${path}.agentRuntime.id ${legacyWholeAgentRuntime.runtime} to matching ${legacyWholeAgentRuntime.provider} model runtime policy.`,
      );
    }
  }

  const codexCliRuntimePins = normalizeLegacyCodexCliRuntimePinsInModels(
    next.models,
    `${path}.models`,
    changes,
  );
  if (codexCliRuntimePins.changed) {
    next.models = codexCliRuntimePins.value;
    changed = true;
  }

  return { value: next, changed };
}

function normalizeLegacyCodexCliProviderRuntimePins(
  cfg: OpenClawConfig,
  changes: string[],
): { config: OpenClawConfig; changed: boolean } {
  const rawModels = cfg.models;
  if (!isRecord(rawModels) || !isRecord(rawModels.providers)) {
    return { config: cfg, changed: false };
  }

  let changed = false;
  const nextProviders: Record<string, unknown> = { ...rawModels.providers };
  for (const [providerId, rawProvider] of Object.entries(rawModels.providers)) {
    if (!isRecord(rawProvider)) {
      continue;
    }
    let providerChanged = false;
    const nextProvider: Record<string, unknown> = { ...rawProvider };
    const providerRuntime = normalizeLegacyCodexCliAgentRuntimePolicy(rawProvider.agentRuntime);
    if (providerRuntime.changed) {
      nextProvider.agentRuntime = providerRuntime.value;
      providerChanged = true;
      changes.push(
        `Moved models.providers.${sanitizeForLog(providerId)} agentRuntime.id from codex-cli to codex.`,
      );
    }

    if (Array.isArray(rawProvider.models)) {
      const nextProviderModels = rawProvider.models.map((entry, index) => {
        if (!isRecord(entry)) {
          return entry;
        }
        const runtime = normalizeLegacyCodexCliAgentRuntimePolicy(entry.agentRuntime);
        if (!runtime.changed) {
          return entry;
        }
        providerChanged = true;
        const modelId = normalizeOptionalString(entry.id) ?? `[${index}]`;
        changes.push(
          `Moved models.providers.${sanitizeForLog(providerId)}.models.${sanitizeForLog(modelId)} agentRuntime.id from codex-cli to codex.`,
        );
        return Object.assign({}, entry, { agentRuntime: runtime.value });
      });
      if (providerChanged) {
        nextProvider.models = nextProviderModels;
      }
    }

    if (providerChanged) {
      nextProviders[providerId] = nextProvider;
      changed = true;
    }
  }

  return changed
    ? {
        config: {
          ...cfg,
          models: {
            ...rawModels,
            providers: nextProviders as NonNullable<OpenClawConfig["models"]>["providers"],
          },
        },
        changed: true,
      }
    : { config: cfg, changed: false };
}

/** Move legacy runtime-tagged model/provider refs onto current agentRuntime policy fields. */
export function normalizeLegacyRuntimeModelRefs(
  cfg: OpenClawConfig,
  changes: string[],
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
): OpenClawConfig {
  const providerPinned = normalizeLegacyCodexCliProviderRuntimePins(cfg, changes);
  const cfgWithProviders = providerPinned.config;
  const rawAgents = cfgWithProviders.agents;
  if (!isRecord(rawAgents)) {
    return cfgWithProviders;
  }

  let changed = false;
  const nextAgents: Record<string, unknown> = { ...rawAgents };
  if (isRecord(rawAgents.defaults)) {
    const defaults = normalizeLegacyRuntimeAgentContainer(
      rawAgents.defaults,
      "agents.defaults",
      changes,
      blockedModelIdentities,
    );
    if (defaults.changed) {
      nextAgents.defaults = defaults.value;
      changed = true;
    }
  }

  if (Array.isArray(rawAgents.list)) {
    const nextList = rawAgents.list.map((entry, index) => {
      if (!isRecord(entry)) {
        return entry;
      }
      const agentId = normalizeOptionalString(entry.id);
      const path = agentId ? `agents.list.${sanitizeForLog(agentId)}` : `agents.list[${index}]`;
      const agent = normalizeLegacyRuntimeAgentContainer(
        entry,
        path,
        changes,
        blockedModelIdentities,
      );
      if (agent.changed) {
        changed = true;
        return agent.value;
      }
      return entry;
    });
    if (changed) {
      nextAgents.list = nextList;
    }
  }

  const nextCfg = changed
    ? {
        ...cfgWithProviders,
        agents: nextAgents as OpenClawConfig["agents"],
      }
    : cfgWithProviders;
  return nextCfg;
}

/** Add missing metadata source markers to legacy OpenAI Codex model catalog entries. */
export function normalizeLegacyOpenAICodexModelsAddMetadata(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const rawModels = cfg.models;
  if (!isRecord(rawModels) || !isRecord(rawModels.providers)) {
    return cfg;
  }

  const rawProviders: Record<string, unknown> = rawModels.providers;
  let providersChanged = false;
  const nextProviders: Record<string, unknown> = { ...rawProviders };
  for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
    if (normalizeProviderId(providerId) !== "openai-codex" || !isRecord(rawProvider)) {
      continue;
    }
    const rawProviderModels = rawProvider.models;
    if (!Array.isArray(rawProviderModels)) {
      continue;
    }
    let providerChanged = false;
    const nextModels: typeof rawProviderModels = [];
    for (const model of rawProviderModels) {
      if (
        isRecord(model) &&
        !("metadataSource" in model) &&
        isLegacyModelsAddCodexMetadataModel({
          provider: providerId,
          model: model as Partial<ModelDefinitionEntry>,
        })
      ) {
        providerChanged = true;
        const safeProviderId = sanitizeForLog(providerId);
        const safeModelId = sanitizeForLog(normalizeOptionalString(model.id) ?? "unknown");
        changes.push(
          `Marked models.providers.${safeProviderId}.models.${safeModelId} as /models add metadata so official OpenAI Codex metadata can override it.`,
        );
        nextModels.push(Object.assign({}, model, { metadataSource: "models-add" }));
      } else {
        nextModels.push(model);
      }
    }

    if (!providerChanged) {
      continue;
    }
    nextProviders[providerId] = {
      ...rawProvider,
      models: nextModels,
    } as (typeof nextProviders)[string];
    providersChanged = true;
  }

  if (!providersChanged) {
    return cfg;
  }

  return {
    ...cfg,
    models: {
      ...rawModels,
      providers: nextProviders as NonNullable<OpenClawConfig["models"]>["providers"],
    },
  };
}

/** Rename legacy OpenAI API identifiers to the current completion/chat API ids. */
export function normalizeLegacyOpenAIModelProviderApi(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const rawModels = cfg.models;
  if (!isRecord(rawModels) || !isRecord(rawModels.providers)) {
    return cfg;
  }

  const rawProviders: Record<string, unknown> = rawModels.providers;
  let providersChanged = false;
  const nextProviders: Record<string, unknown> = { ...rawProviders };
  for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
    if (!isRecord(rawProvider)) {
      continue;
    }

    let providerChanged = false;
    const nextProvider: Record<string, unknown> = { ...rawProvider };
    if (nextProvider.api === "openai") {
      nextProvider.api = "openai-completions";
      providerChanged = true;
      changes.push(
        `Moved models.providers.${sanitizeForLog(providerId)}.api "openai" → "openai-completions".`,
      );
    }

    const rawProviderModels = rawProvider.models;
    if (Array.isArray(rawProviderModels)) {
      let modelsChanged = false;
      const nextModels: unknown[] = [];
      rawProviderModels.forEach((model, index) => {
        if (!isRecord(model) || model.api !== "openai") {
          nextModels.push(model);
          return;
        }
        modelsChanged = true;
        changes.push(
          `Moved models.providers.${sanitizeForLog(providerId)}.models[${index}].api "openai" → "openai-completions".`,
        );
        nextModels.push({
          ...model,
          api: "openai-completions",
        });
      });
      if (modelsChanged) {
        nextProvider.models = nextModels;
        providerChanged = true;
      }
    }

    if (!providerChanged) {
      continue;
    }
    nextProviders[providerId] = nextProvider;
    providersChanged = true;
  }

  if (!providersChanged) {
    return cfg;
  }

  return {
    ...cfg,
    models: {
      ...rawModels,
      providers: nextProviders as NonNullable<OpenClawConfig["models"]>["providers"],
    },
  };
}

/** Remove retired bundled nano-banana skill config after migrating image generation models. */
export function normalizeLegacyNanoBananaSkill(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const NANO_BANANA_SKILL_KEY = "nano-banana-pro";
  const NANO_BANANA_MODEL = "google/gemini-3-pro-image-preview";
  const rawSkills = cfg.skills;
  if (!isRecord(rawSkills)) {
    return cfg;
  }

  let next = cfg;
  let skillsChanged = false;
  const skills = structuredClone(rawSkills);

  if (Array.isArray(skills.allowBundled)) {
    const allowBundled = skills.allowBundled.filter(
      (value) => typeof value !== "string" || value.trim() !== NANO_BANANA_SKILL_KEY,
    );
    if (allowBundled.length !== skills.allowBundled.length) {
      if (allowBundled.length === 0) {
        delete skills.allowBundled;
        changes.push(`Removed skills.allowBundled entry for ${NANO_BANANA_SKILL_KEY}.`);
      } else {
        skills.allowBundled = allowBundled;
        changes.push(`Removed ${NANO_BANANA_SKILL_KEY} from skills.allowBundled.`);
      }
      skillsChanged = true;
    }
  }

  const rawEntries = skills.entries;
  if (!isRecord(rawEntries)) {
    if (!skillsChanged) {
      return cfg;
    }
    return {
      ...cfg,
      skills,
    };
  }

  const rawLegacyEntry = rawEntries[NANO_BANANA_SKILL_KEY];
  if (!isRecord(rawLegacyEntry)) {
    if (!skillsChanged) {
      return cfg;
    }
    return {
      ...cfg,
      skills,
    };
  }

  const existingImageGenerationModel = next.agents?.defaults?.imageGenerationModel;
  if (existingImageGenerationModel === undefined) {
    next = {
      ...next,
      agents: {
        ...next.agents,
        defaults: {
          ...next.agents?.defaults,
          imageGenerationModel: {
            primary: NANO_BANANA_MODEL,
          },
        },
      },
    };
    changes.push(
      `Moved skills.entries.${NANO_BANANA_SKILL_KEY} → agents.defaults.imageGenerationModel.primary (${NANO_BANANA_MODEL}).`,
    );
  }

  const legacyEnv = isRecord(rawLegacyEntry.env) ? rawLegacyEntry.env : undefined;
  const legacyEnvApiKey = normalizeOptionalString(legacyEnv?.GEMINI_API_KEY) ?? "";
  const legacyApiKey =
    legacyEnvApiKey ||
    (typeof rawLegacyEntry.apiKey === "string"
      ? normalizeOptionalString(rawLegacyEntry.apiKey)
      : rawLegacyEntry.apiKey && isRecord(rawLegacyEntry.apiKey)
        ? structuredClone(rawLegacyEntry.apiKey)
        : undefined);

  const rawModels = (
    isRecord(next.models) ? structuredClone(next.models) : {}
  ) as ModelsConfigPatch;
  const rawProviders = (isRecord(rawModels.providers) ? { ...rawModels.providers } : {}) as Record<
    string,
    ModelProviderEntry
  >;
  const rawGoogle = (
    isRecord(rawProviders.google) ? { ...rawProviders.google } : {}
  ) as ModelProviderEntry;
  const hasGoogleApiKey = rawGoogle.apiKey !== undefined;
  if (!hasGoogleApiKey && legacyApiKey) {
    rawGoogle.apiKey = legacyApiKey;
    if (!rawGoogle.baseUrl) {
      rawGoogle.baseUrl = DEFAULT_GOOGLE_API_BASE_URL;
    }
    if (!Array.isArray(rawGoogle.models)) {
      rawGoogle.models = [];
    }
    rawProviders.google = rawGoogle;
    rawModels.providers = rawProviders as NonNullable<OpenClawConfig["models"]>["providers"];
    next = {
      ...next,
      models: rawModels as OpenClawConfig["models"],
    };
    changes.push(
      `Moved skills.entries.${NANO_BANANA_SKILL_KEY}.${legacyEnvApiKey ? "env.GEMINI_API_KEY" : "apiKey"} → models.providers.google.apiKey.`,
    );
  }

  const entries = { ...rawEntries };
  delete entries[NANO_BANANA_SKILL_KEY];
  if (Object.keys(entries).length === 0) {
    delete skills.entries;
  } else {
    skills.entries = entries;
  }
  changes.push(`Removed legacy skills.entries.${NANO_BANANA_SKILL_KEY}.`);
  skillsChanged = true;

  if (Object.keys(skills).length === 0) {
    const { skills: _ignored, ...rest } = next;
    return rest;
  }

  if (!skillsChanged) {
    return next;
  }
  return {
    ...next,
    skills,
  };
}

function normalizeConfiguredPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function resolveConfiguredOllamaModelNumCtxBudget(params: {
  model: Record<string, unknown>;
  provider: Record<string, unknown>;
  providerNumCtxApplies: boolean;
}): number | undefined {
  const modelContextWindow = normalizeConfiguredPositiveInteger(params.model.contextWindow);
  if (modelContextWindow !== undefined) {
    return modelContextWindow;
  }

  const providerContextWindow = normalizeConfiguredPositiveInteger(params.provider.contextWindow);
  if (providerContextWindow !== undefined) {
    return params.providerNumCtxApplies ? undefined : providerContextWindow;
  }

  const modelMaxTokens = normalizeConfiguredPositiveInteger(params.model.maxTokens);
  if (modelMaxTokens !== undefined) {
    return modelMaxTokens;
  }

  const providerMaxTokens = normalizeConfiguredPositiveInteger(params.provider.maxTokens);
  if (providerMaxTokens !== undefined) {
    return params.providerNumCtxApplies ? undefined : providerMaxTokens;
  }

  return undefined;
}

function resolveConfiguredOllamaProviderNumCtxBudget(
  provider: Record<string, unknown>,
): number | undefined {
  return (
    normalizeConfiguredPositiveInteger(provider.contextWindow) ??
    normalizeConfiguredPositiveInteger(provider.maxTokens)
  );
}

function isNativeOllamaProviderConfig(
  _providerId: string,
  provider: Record<string, unknown>,
): boolean {
  const providerApi = normalizeOptionalLowercaseString(provider.api);
  return providerApi === "ollama";
}

function isNativeOllamaModelConfig(params: {
  providerId: string;
  provider: Record<string, unknown>;
  model: Record<string, unknown>;
}): boolean {
  const modelApi = normalizeOptionalLowercaseString(params.model.api);
  if (modelApi) {
    return modelApi === "ollama";
  }

  const providerApi = normalizeOptionalLowercaseString(params.provider.api);
  if (providerApi) {
    return providerApi === "ollama";
  }

  return false;
}

function hasConfiguredOllamaProviderNumCtx(provider: Record<string, unknown>): boolean {
  const rawParams = provider.params;
  return isRecord(rawParams) && hasOwnKey(rawParams, "num_ctx");
}

function applyLegacyOllamaProviderNumCtxParams(params: {
  providerId: string;
  provider: Record<string, unknown>;
  changes: string[];
}): { provider: Record<string, unknown>; changed: boolean } {
  if (!isNativeOllamaProviderConfig(params.providerId, params.provider)) {
    return { provider: params.provider, changed: false };
  }

  const rawParams = params.provider.params;
  if (rawParams !== undefined && !isRecord(rawParams)) {
    return { provider: params.provider, changed: false };
  }
  if (rawParams && hasOwnKey(rawParams, "num_ctx")) {
    return { provider: params.provider, changed: false };
  }

  const numCtx = resolveConfiguredOllamaProviderNumCtxBudget(params.provider);
  if (numCtx === undefined) {
    return { provider: params.provider, changed: false };
  }

  params.changes.push(
    `Set models.providers.${sanitizeForLog(params.providerId)}.params.num_ctx to ${numCtx} for native Ollama compatibility.`,
  );
  return {
    provider: {
      ...params.provider,
      params: rawParams ? { ...rawParams, num_ctx: numCtx } : { num_ctx: numCtx },
    },
    changed: true,
  };
}

/** Seed native Ollama num_ctx params from legacy context-token budgets. */
export function normalizeLegacyOllamaNativeNumCtxParams(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const rawProviders = cfg.models?.providers;
  if (!isRecord(rawProviders)) {
    return cfg;
  }

  let providersChanged = false;
  const nextProviders = { ...rawProviders };
  type ProviderConfigMap = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>;
  for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
    if (!isRecord(rawProvider)) {
      continue;
    }
    const rawModels = rawProvider.models;
    if (!Array.isArray(rawModels)) {
      continue;
    }
    const providerParams = applyLegacyOllamaProviderNumCtxParams({
      providerId,
      provider: rawProvider,
      changes,
    });
    const providerNumCtxApplies =
      isNativeOllamaProviderConfig(providerId, providerParams.provider) &&
      hasConfiguredOllamaProviderNumCtx(providerParams.provider);
    if (rawModels.length === 0) {
      if (!providerParams.changed) {
        continue;
      }
      nextProviders[providerId] = providerParams.provider as ProviderConfigMap[string];
      providersChanged = true;
      continue;
    }

    let modelsChanged = false;
    const nextModels = rawModels.map((model, index) => {
      if (!isRecord(model)) {
        return model;
      }
      if (
        !isNativeOllamaModelConfig({
          providerId,
          provider: providerParams.provider,
          model,
        })
      ) {
        return model;
      }

      const rawParams = model.params;
      if (rawParams !== undefined && !isRecord(rawParams)) {
        return model;
      }
      if (rawParams && hasOwnKey(rawParams, "num_ctx")) {
        return model;
      }

      const numCtx = resolveConfiguredOllamaModelNumCtxBudget({
        model,
        provider: providerParams.provider,
        providerNumCtxApplies,
      });
      if (numCtx === undefined) {
        return model;
      }

      modelsChanged = true;
      changes.push(
        `Set models.providers.${sanitizeForLog(providerId)}.models[${index}].params.num_ctx to ${numCtx} for native Ollama compatibility.`,
      );
      return Object.assign({}, model, {
        params: rawParams ? { ...rawParams, num_ctx: numCtx } : { num_ctx: numCtx },
      });
    });

    if (!modelsChanged && !providerParams.changed) {
      continue;
    }

    nextProviders[providerId] = {
      ...providerParams.provider,
      models: nextModels,
    } as ProviderConfigMap[string];
    providersChanged = true;
  }

  if (!providersChanged) {
    return cfg;
  }

  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: nextProviders as NonNullable<OpenClawConfig["models"]>["providers"],
    },
  };
}

const MISTRAL_MODEL_CACHE_READ_COST_BY_ID: Record<string, number> = {
  "codestral-latest": 0.03,
  "devstral-medium-latest": 0.04,
  "magistral-small": 0.05,
  "mistral-large-latest": 0.05,
  "mistral-medium-2508": 0.04,
  "mistral-medium-3-5": 0.15,
  "mistral-small-latest": 0.01,
  "pixtral-large-latest": 0.2,
};

function normalizeLegacyMistralModelCost<T extends Record<string, unknown>>(params: {
  providerId: string;
  model: T;
  modelId: string;
  index: number;
  changes: string[];
}): { model: T; changed: boolean } {
  const cost = params.model.cost;
  if (!isRecord(cost) || cost.cacheRead !== 0) {
    return { model: params.model, changed: false };
  }

  const normalizedCacheRead = MISTRAL_MODEL_CACHE_READ_COST_BY_ID[params.modelId.toLowerCase()];
  if (normalizedCacheRead === undefined) {
    return { model: params.model, changed: false };
  }

  params.changes.push(
    `Normalized models.providers.${sanitizeForLog(params.providerId)}.models[${params.index}].cost.cacheRead (0 → ${normalizedCacheRead}) for Mistral prompt-cache billing.`,
  );
  return {
    model: {
      ...params.model,
      cost: { ...cost, cacheRead: normalizedCacheRead },
    },
    changed: true,
  };
}

/** Normalize stale Mistral model defaults such as prompt-cache read cost. */
export function normalizeLegacyMistralModelDefaults(
  cfg: OpenClawConfig,
  changes: string[],
): OpenClawConfig {
  const rawProviders = cfg.models?.providers;
  if (!isRecord(rawProviders)) {
    return cfg;
  }

  let providersChanged = false;
  const nextProviders = { ...rawProviders };
  for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
    if (normalizeProviderId(providerId) !== "mistral" || !isRecord(rawProvider)) {
      continue;
    }
    const rawModels = rawProvider.models;
    if (!Array.isArray(rawModels)) {
      continue;
    }

    let modelsChanged = false;
    const nextModels = rawModels.map((model, index) => {
      if (!isRecord(model)) {
        return model;
      }
      const modelId = normalizeOptionalString(model.id) ?? "";
      if (!modelId) {
        return model;
      }

      let nextModel = model;
      let modelChanged = false;
      const contextWindow =
        typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
          ? model.contextWindow
          : null;
      const maxTokens =
        typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens)
          ? model.maxTokens
          : null;

      if (contextWindow !== null && maxTokens !== null) {
        const normalizedMaxTokens = resolveNormalizedProviderModelMaxTokens({
          providerId,
          modelId,
          contextWindow,
          rawMaxTokens: maxTokens,
        });
        if (normalizedMaxTokens !== maxTokens) {
          nextModel = Object.assign({}, nextModel, { maxTokens: normalizedMaxTokens });
          modelChanged = true;
          changes.push(
            `Normalized models.providers.${providerId}.models[${index}].maxTokens (${maxTokens} → ${normalizedMaxTokens}) to avoid Mistral context-window rejects.`,
          );
        }
      }

      const costNormalization = normalizeLegacyMistralModelCost({
        providerId,
        model: nextModel,
        modelId,
        index,
        changes,
      });
      if (costNormalization.changed) {
        nextModel = costNormalization.model;
        modelChanged = true;
      }

      if (modelChanged) {
        modelsChanged = true;
      }
      return modelChanged ? nextModel : model;
    });

    if (!modelsChanged) {
      continue;
    }

    nextProviders[providerId] = {
      ...rawProvider,
      models: nextModels,
    };
    providersChanged = true;
  }

  if (!providersChanged) {
    return cfg;
  }

  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: nextProviders as NonNullable<OpenClawConfig["models"]>["providers"],
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
