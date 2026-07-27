// Search setup flow configures web search providers and defaults.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import { resolveAgentHarnessPolicy } from "../agents/harness/policy.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { hasAuthProfileForProvider } from "../agents/tools/model-config.helpers.js";
import type { SecretInputMode } from "../commands/onboard-types.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_SECRET_PROVIDER_ALIAS,
  type SecretInput,
  type SecretRef,
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "../config/types.secrets.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import {
  resolveWebSearchInstallCatalogEntries,
  type WebSearchInstallCatalogEntry,
} from "../plugins/web-search-install-catalog.js";
import { resolvePluginWebSearchProviders } from "../plugins/web-search-providers.runtime.js";
import { sortWebSearchProviders } from "../plugins/web-search-providers.shared.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveWebSearchProviderId } from "../web-search/runtime.js";
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { FlowContribution, FlowOption } from "./types.js";
import { sortFlowContributionsByLabel } from "./types.js";

type SearchProvider = NonNullable<
  NonNullable<NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["search"]>["provider"]
>;
type SearchConfig = NonNullable<NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["search"]>;
type MutableSearchConfig = SearchConfig & Record<string, unknown>;

type SearchProviderSetupOption = FlowOption & {
  value: SearchProvider;
};

type SearchProviderSetupContribution = FlowContribution & {
  kind: "search";
  surface: "setup";
  provider: PluginWebSearchProviderEntry;
  option: SearchProviderSetupOption;
  source: "runtime" | "install-catalog";
};

const SEARCH_INSTALL_CATALOG_ENTRY = Symbol("search-install-catalog-entry");
const WEB_SEARCH_DOCS_URL = "https://docs.openclaw.ai/tools/web";
const CODEX_HOSTED_SEARCH_PROVIDER_ID = "codex";

type SearchProviderEntryWithInstall = PluginWebSearchProviderEntry & {
  [SEARCH_INSTALL_CATALOG_ENTRY]?: WebSearchInstallCatalogEntry;
};

function resolveSearchProviderCredentialLabel(
  entry: Pick<PluginWebSearchProviderEntry, "label" | "credentialLabel" | "requiresCredential">,
): string {
  if (entry.requiresCredential === false) {
    return `${entry.label} setup`;
  }
  return normalizeOptionalString(entry.credentialLabel) || `${entry.label} API key`;
}

export function listSearchProviderOptions(
  config?: OpenClawConfig,
): readonly PluginWebSearchProviderEntry[] {
  return resolveSearchProviderOptions(config);
}

function showsSearchProviderInSetup(
  entry: Pick<PluginWebSearchProviderEntry, "onboardingScopes">,
): boolean {
  return entry.onboardingScopes?.includes("text-inference") ?? false;
}

export function resolveSearchProviderOptions(
  config?: OpenClawConfig,
): readonly PluginWebSearchProviderEntry[] {
  return resolveSearchProviderSetupContributions(config).map(
    (contribution) => contribution.provider,
  );
}

function buildSearchProviderSetupContribution(params: {
  provider: PluginWebSearchProviderEntry;
  source: "runtime" | "install-catalog";
}): SearchProviderSetupContribution {
  return {
    id: `search:setup:${params.provider.id}`,
    kind: "search",
    surface: "setup",
    provider: params.provider,
    option: {
      value: params.provider.id,
      label: params.provider.label,
      ...(params.provider.hint ? { hint: params.provider.hint } : {}),
      ...(params.provider.docsUrl ? { docs: { path: params.provider.docsUrl } } : {}),
    },
    source: params.source,
  };
}

function resolveSearchProviderSetupContributions(
  config?: OpenClawConfig,
): SearchProviderSetupContribution[] {
  const runtimeProviders = sortWebSearchProviders(
    resolvePluginWebSearchProviders({
      config,
      env: process.env,
      mode: "setup",
    }),
  );
  const seenProviderIds = new Set(runtimeProviders.map((provider) => provider.id));
  const seenPluginIds = new Set(runtimeProviders.map((provider) => provider.pluginId));
  const normalizedPluginsConfig = normalizePluginsConfig(config?.plugins);
  const installCatalogProviders = resolveWebSearchInstallCatalogEntries()
    .filter(
      (entry) =>
        !seenProviderIds.has(entry.provider.id) &&
        !seenPluginIds.has(entry.pluginId) &&
        resolveEffectiveEnableState({
          id: entry.pluginId,
          origin: "global",
          config: normalizedPluginsConfig,
          rootConfig: config,
          enabledByDefault: true,
        }).enabled,
    )
    .map(
      (entry): SearchProviderEntryWithInstall =>
        Object.assign({}, entry.provider, { [SEARCH_INSTALL_CATALOG_ENTRY]: entry }),
    );
  const providers = sortWebSearchProviders([...runtimeProviders, ...installCatalogProviders]);
  return sortFlowContributionsByLabel(
    providers.filter(showsSearchProviderInSetup).map((provider) =>
      buildSearchProviderSetupContribution({
        provider,
        source: SEARCH_INSTALL_CATALOG_ENTRY in provider ? "install-catalog" : "runtime",
      }),
    ),
  );
}

function defaultModelUsesCodexRuntime(config: OpenClawConfig): boolean {
  const configuredPrimary = resolveAgentModelPrimaryValue(config.agents?.defaults?.model);
  if (!configuredPrimary) {
    return false;
  }
  const defaultModel = resolveDefaultModelForAgent({ cfg: config });
  if (defaultModel.provider === CODEX_HOSTED_SEARCH_PROVIDER_ID) {
    return true;
  }
  return (
    resolveAgentHarnessPolicy({
      provider: defaultModel.provider,
      modelId: defaultModel.model,
      config,
    }).runtime === "codex"
  );
}

function prioritizeSearchProvider(
  providers: readonly PluginWebSearchProviderEntry[],
  preferredProvider: string | undefined,
): PluginWebSearchProviderEntry[] {
  if (!preferredProvider) {
    return [...providers];
  }
  const preferred = providers.find((provider) => provider.id === preferredProvider);
  if (!preferred) {
    return [...providers];
  }
  return [preferred, ...providers.filter((provider) => provider.id !== preferredProvider)];
}

function resolveSearchProviderEntry(
  config: OpenClawConfig,
  provider: SearchProvider,
): PluginWebSearchProviderEntry | undefined {
  return resolveSearchProviderOptions(config).find((entry) => entry.id === provider);
}

export function hasKeyInEnv(entry: Pick<PluginWebSearchProviderEntry, "envVars">): boolean {
  return entry.envVars.some((k) => Boolean(normalizeOptionalString(process.env[k])));
}

function providerNeedsCredential(
  entry: Pick<PluginWebSearchProviderEntry, "requiresCredential">,
): boolean {
  return entry.requiresCredential !== false;
}

function formatAuthProviderLabel(providerId: string): string {
  return providerId === "xai" ? "xAI" : providerId;
}

function providerIsReady(
  config: OpenClawConfig,
  entry: Pick<
    PluginWebSearchProviderEntry,
    "id" | "authProviderId" | "envVars" | "requiresCredential"
  >,
): boolean {
  if (!providerNeedsCredential(entry)) {
    return true;
  }
  if (
    entry.authProviderId &&
    hasAuthProfileForProvider({
      provider: entry.authProviderId,
      agentDir: resolveDefaultAgentDir(config),
    })
  ) {
    return true;
  }
  return hasExistingKey(config, entry.id) || hasKeyInEnv(entry);
}

function formatSearchProviderOptionLabel(label: string, note: string): string {
  const normalizedNote = normalizeOptionalString(note);
  return normalizedNote ? `${label} (${normalizedNote})` : label;
}

function rawKeyValue(config: OpenClawConfig, provider: SearchProvider): unknown {
  const entry = resolveSearchProviderEntry(config, provider);
  return entry?.getConfiguredCredentialValue?.(config);
}

export function resolveExistingKey(
  config: OpenClawConfig,
  provider: SearchProvider,
): string | undefined {
  return normalizeSecretInputString(rawKeyValue(config, provider));
}

export function hasExistingKey(config: OpenClawConfig, provider: SearchProvider): boolean {
  return hasConfiguredSecretInput(rawKeyValue(config, provider));
}

function buildSearchEnvRef(config: OpenClawConfig, provider: SearchProvider): SecretRef {
  const entry =
    resolveSearchProviderEntry(config, provider) ??
    listSearchProviderOptions(config).find((candidate) => candidate.id === provider) ??
    listSearchProviderOptions().find((candidate) => candidate.id === provider);
  const resolvedEnvVar =
    entry?.envVars.find((k) => Boolean(normalizeOptionalString(process.env[k]))) ??
    entry?.envVars[0];
  if (!resolvedEnvVar) {
    throw new Error(
      `No env var mapping for search provider "${provider}" at ${entry?.credentialPath ?? "unknown path"} in secret-input-mode=ref.`,
    );
  }
  return { source: "env", provider: DEFAULT_SECRET_PROVIDER_ALIAS, id: resolvedEnvVar };
}

function resolveSearchSecretInput(
  config: OpenClawConfig,
  provider: SearchProvider,
  key: string,
  secretInputMode?: SecretInputMode,
): SecretInput {
  const useSecretRefMode = secretInputMode === "ref"; // pragma: allowlist secret
  if (useSecretRefMode) {
    return buildSearchEnvRef(config, provider);
  }
  return key;
}

export function applySearchKey(
  config: OpenClawConfig,
  provider: SearchProvider,
  key: SecretInput,
): OpenClawConfig {
  const providerEntry = resolveSearchProviderEntry(config, provider);
  if (!providerEntry) {
    return config;
  }
  const search: MutableSearchConfig = { ...config.tools?.web?.search, provider, enabled: true };
  const nextBase: OpenClawConfig = {
    ...config,
    tools: {
      ...config.tools,
      web: { ...config.tools?.web, search },
    },
  };
  const next = applySearchProviderSelectionConfig(nextBase, providerEntry);
  providerEntry.setConfiguredCredentialValue?.(next, key);
  return next;
}

function applySearchProviderSelectionConfig(
  config: OpenClawConfig,
  providerEntry: Pick<PluginWebSearchProviderEntry, "pluginId" | "applySelectionConfig">,
): OpenClawConfig {
  if (providerEntry.applySelectionConfig) {
    return providerEntry.applySelectionConfig(config);
  }
  if (providerEntry.pluginId) {
    return enablePluginInConfig(config, providerEntry.pluginId).config;
  }
  return config;
}

export function applySearchProviderSelection(
  config: OpenClawConfig,
  provider: SearchProvider,
): OpenClawConfig {
  const providerEntry = resolveSearchProviderEntry(config, provider);
  if (!providerEntry) {
    return config;
  }
  const search: MutableSearchConfig = {
    ...config.tools?.web?.search,
    provider,
    enabled: true,
  };
  const nextBase: OpenClawConfig = {
    ...config,
    tools: {
      ...config.tools,
      web: {
        ...config.tools?.web,
        search,
      },
    },
  };
  return applySearchProviderSelectionConfig(nextBase, providerEntry);
}

function preserveDisabledState(original: OpenClawConfig, result: OpenClawConfig): OpenClawConfig {
  if (original.tools?.web?.search?.enabled !== false) {
    return result;
  }

  const next: OpenClawConfig = {
    ...result,
    tools: {
      ...result.tools,
      web: { ...result.tools?.web, search: { ...result.tools?.web?.search, enabled: false } },
    },
  };

  const provider = next.tools?.web?.search?.provider;
  if (typeof provider !== "string") {
    return next;
  }
  const providerEntry = resolveSearchProviderEntry(original, provider);
  if (!providerEntry?.pluginId) {
    return next;
  }

  const pluginId = providerEntry.pluginId;
  const originalPluginEntry = (
    original.plugins?.entries as Record<string, Record<string, unknown>> | undefined
  )?.[pluginId];
  const resultPluginEntry = (
    next.plugins?.entries as Record<string, Record<string, unknown>> | undefined
  )?.[pluginId];

  const nextPlugins = { ...next.plugins } as Record<string, unknown>;

  if (Array.isArray(original.plugins?.allow)) {
    nextPlugins.allow = [...original.plugins.allow];
  } else {
    delete nextPlugins.allow;
  }

  if (resultPluginEntry || originalPluginEntry) {
    const nextEntries = {
      ...(nextPlugins.entries as Record<string, Record<string, unknown>> | undefined),
    };
    const patchedEntry = { ...resultPluginEntry };
    if (typeof originalPluginEntry?.enabled === "boolean") {
      patchedEntry.enabled = originalPluginEntry.enabled;
    } else {
      delete patchedEntry.enabled;
    }
    nextEntries[pluginId] = patchedEntry;
    nextPlugins.entries = nextEntries;
  }

  return {
    ...next,
    plugins: nextPlugins as OpenClawConfig["plugins"],
  };
}

type SetupSearchOptions = {
  quickstartDefaults?: boolean;
  preserveDisabledSearchState?: boolean;
  secretInputMode?: SecretInputMode;
};

async function finalizeSearchProviderSetup(params: {
  originalConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  entry: SearchProviderEntryWithInstall;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  opts?: SetupSearchOptions;
}): Promise<OpenClawConfig> {
  let next = params.nextConfig;
  const installEntry = params.entry[SEARCH_INSTALL_CATALOG_ENTRY];
  if (installEntry && next.tools?.web?.search?.enabled !== false) {
    const { ensureOnboardingPluginInstalled } =
      await import("../commands/onboarding-plugin-install.js");
    const installed = await ensureOnboardingPluginInstalled({
      cfg: next,
      entry: {
        pluginId: installEntry.pluginId,
        label: installEntry.label,
        install: installEntry.install,
        ...(installEntry.trustedSourceLinkedOfficialInstall
          ? { trustedSourceLinkedOfficialInstall: true }
          : {}),
      },
      prompter: params.prompter,
      runtime: params.runtime,
      autoConfirmSingleSource: true,
    });
    if (!installed.installed) {
      return params.originalConfig;
    }
    next = installed.cfg;
  }
  if (params.opts?.preserveDisabledSearchState !== false) {
    next = preserveDisabledState(params.originalConfig, next);
  }
  if (!params.entry.runSetup) {
    return next;
  }
  next = await params.entry.runSetup({
    config: next,
    runtime: params.runtime,
    prompter: params.prompter,
    quickstartDefaults: params.opts?.quickstartDefaults,
    secretInputMode: params.opts?.secretInputMode,
  });
  return params.opts?.preserveDisabledSearchState === false
    ? next
    : preserveDisabledState(params.originalConfig, next);
}

export async function runSearchSetupFlow(
  config: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  opts?: SetupSearchOptions,
): Promise<OpenClawConfig> {
  const availableProviderOptions = resolveSearchProviderOptions(config);
  const codexRecommended =
    defaultModelUsesCodexRuntime(config) &&
    availableProviderOptions.some((entry) => entry.id === CODEX_HOSTED_SEARCH_PROVIDER_ID);
  const providerOptions = prioritizeSearchProvider(
    availableProviderOptions,
    codexRecommended ? CODEX_HOSTED_SEARCH_PROVIDER_ID : undefined,
  );
  if (providerOptions.length === 0) {
    await prompter.note(
      [
        t("wizard.search.noProvidersByPolicy"),
        t("wizard.search.noProvidersAction"),
        t("wizard.search.docsLine", { url: WEB_SEARCH_DOCS_URL }),
      ].join("\n"),
      t("wizard.search.title"),
    );
    return config;
  }

  await prompter.note(
    [
      t("wizard.search.intro"),
      t("wizard.search.chooseProvider"),
      t("wizard.search.docsLine", { url: WEB_SEARCH_DOCS_URL }),
    ].join("\n"),
    t("wizard.search.title"),
  );

  const existingProvider = config.tools?.web?.search?.provider;

  const defaultChoice: SearchProvider = (() => {
    if (existingProvider && providerOptions.some((entry) => entry.id === existingProvider)) {
      return existingProvider;
    }
    if (codexRecommended) {
      return CODEX_HOSTED_SEARCH_PROVIDER_ID;
    }
    // Mirror runtime auto-detect only when it has a concrete configured signal.
    // Keyless providers are selectable, but never preselected; pressing through
    // setup should not opt the user into a third-party search destination.
    // Resolve over the providers actually shown in setup (`providerOptions`) so
    // the default can't pick an option that isn't listed or force-load runtime
    // code for an install-catalog-only provider.
    // Clear any existing provider id before auto-detecting: the valid-existing
    // case already returned above, so a leftover value here is stale/invalid/
    // disabled and would otherwise make the resolver short-circuit to that
    // invalid selection. Keep the rest of the search config so configured
    // credentials are still detected.
    const searchForAutoDetect = {
      ...config.tools?.web?.search,
      provider: undefined,
    } as Parameters<typeof resolveWebSearchProviderId>[0]["search"];
    const autoDetectedId = resolveWebSearchProviderId({
      config,
      search: searchForAutoDetect,
      providers: [...providerOptions],
    });
    const autoDetected = providerOptions.find((entry) => entry.id === autoDetectedId);
    if (autoDetected) {
      return autoDetected.id;
    }
    const detected = providerOptions.find(
      (entry) => providerNeedsCredential(entry) && providerIsReady(config, entry),
    );
    if (detected) {
      return detected.id;
    }
    return "__skip__";
  })();

  const options = providerOptions.map((entry) => {
    const credentialHint =
      entry.requiresCredential === false
        ? t("wizard.search.keyFree")
        : providerIsReady(config, entry)
          ? t("wizard.search.configured")
          : entry.credentialLabel
            ? // Some providers need a non-key credential (e.g. SearXNG's base
              // URL); a generic "API key required" suffix contradicts the hint.
              t("wizard.search.credentialRequired", { label: entry.credentialLabel })
            : t("wizard.search.apiKeyRequired");
    const hint = [normalizeOptionalString(entry.hint), credentialHint].filter(Boolean).join(" · ");
    return { value: entry.id, label: formatSearchProviderOptionLabel(entry.label, hint) };
  });

  const choice = await prompter.select({
    message: t("wizard.search.providerPrompt"),
    options: [
      ...options,
      {
        value: "__skip__" as const,
        label: t("common.skipForNow"),
        hint: t("wizard.search.configureLaterHint"),
      },
    ],
    initialValue: defaultChoice,
    searchable: true,
  });

  if (choice === "__skip__") {
    return config;
  }

  const entry =
    resolveSearchProviderEntry(config, choice) ?? providerOptions.find((e) => e.id === choice);
  if (!entry) {
    return config;
  }
  const finalizeSelection = (nextConfig: OpenClawConfig) =>
    finalizeSearchProviderSetup({
      originalConfig: config,
      nextConfig,
      entry,
      runtime,
      prompter,
      opts,
    });
  const credentialLabel = resolveSearchProviderCredentialLabel(entry);
  const existingKey = resolveExistingKey(config, choice);
  const keyConfigured = hasExistingKey(config, choice);
  const envAvailable = hasKeyInEnv(entry);
  const agentDir = resolveDefaultAgentDir(config);
  const authProviderId = entry.authProviderId;
  const providerAuthProfileAvailable = authProviderId
    ? hasAuthProfileForProvider({ provider: authProviderId, agentDir })
    : false;
  const oauthAuthProfileAvailable =
    authProviderId && providerAuthProfileAvailable
      ? hasAuthProfileForProvider({
          provider: authProviderId,
          agentDir,
          type: "oauth",
        })
      : false;
  const needsCredential = providerNeedsCredential(entry);

  if (opts?.quickstartDefaults && (providerAuthProfileAvailable || keyConfigured || envAvailable)) {
    const result = existingKey
      ? applySearchKey(config, choice, existingKey)
      : applySearchProviderSelection(config, choice);
    return await finalizeSelection(result);
  }

  if (!needsCredential) {
    await prompter.note(
      [
        `${entry.label} works without an API key.`,
        "OpenClaw will enable the plugin and use it as your web_search provider.",
        `Docs: ${entry.docsUrl ?? "https://docs.openclaw.ai/tools/web"}`,
      ].join("\n"),
      "Web search",
    );
    return await finalizeSelection(applySearchProviderSelection(config, choice));
  }

  if (entry.credentialNote) {
    await prompter.note(entry.credentialNote, entry.label);
  }

  if (oauthAuthProfileAvailable && authProviderId) {
    const authProviderLabel = formatAuthProviderLabel(authProviderId);
    await prompter.note(
      [
        `${entry.label} can use your existing ${authProviderLabel} OAuth sign-in for web_search.`,
        "No separate API key is required; API-key auth remains available as a fallback.",
        `Docs: ${entry.docsUrl ?? WEB_SEARCH_DOCS_URL}`,
      ].join("\n"),
      "Web search",
    );
    return await finalizeSelection(applySearchProviderSelection(config, choice));
  }

  if (providerAuthProfileAvailable && authProviderId) {
    const authProviderLabel = formatAuthProviderLabel(authProviderId);
    await prompter.note(
      [
        `${entry.label} can use your existing ${authProviderLabel} auth profile for web_search.`,
        "No separate web-search key is required; API-key auth remains available as a fallback.",
        `Docs: ${entry.docsUrl ?? WEB_SEARCH_DOCS_URL}`,
      ].join("\n"),
      "Web search",
    );
    return await finalizeSelection(applySearchProviderSelection(config, choice));
  }

  const useSecretRefMode = opts?.secretInputMode === "ref"; // pragma: allowlist secret
  if (useSecretRefMode) {
    if (keyConfigured) {
      return await finalizeSelection(applySearchProviderSelection(config, choice));
    }
    const ref = buildSearchEnvRef(config, choice);
    await prompter.note(
      [
        "Secret references enabled — OpenClaw will store a reference instead of the API key.",
        `Env var: ${ref.id}${envAvailable ? " (detected)" : ""}.`,
        ...(envAvailable ? [] : [`Set ${ref.id} in the Gateway environment.`]),
        "Docs: https://docs.openclaw.ai/tools/web",
      ].join("\n"),
      "Web search",
    );
    return await finalizeSelection(applySearchKey(config, choice, ref));
  }

  const keyInput = await prompter.text({
    message: keyConfigured
      ? `${credentialLabel} (leave blank to keep current)`
      : envAvailable
        ? `${credentialLabel} (leave blank to use env var)`
        : credentialLabel,
    placeholder: keyConfigured ? "Leave blank to keep current" : entry.placeholder,
    sensitive: true,
  });

  const key = normalizeOptionalString(keyInput) ?? "";
  if (key) {
    const secretInput = resolveSearchSecretInput(config, choice, key, opts?.secretInputMode);
    return await finalizeSelection(applySearchKey(config, choice, secretInput));
  }

  if (existingKey) {
    return await finalizeSelection(applySearchKey(config, choice, existingKey));
  }

  if (keyConfigured || envAvailable) {
    return await finalizeSelection(applySearchProviderSelection(config, choice));
  }

  await prompter.note(
    [
      `No ${credentialLabel} stored — web_search won't work until a key is available.`,
      `Get your key at: ${entry.signupUrl}`,
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );

  const search: SearchConfig = {
    ...config.tools?.web?.search,
    enabled: false,
    provider: choice,
  };
  return applySearchProviderSelectionConfig(
    {
      ...config,
      tools: {
        ...config.tools,
        web: {
          ...config.tools?.web,
          search,
        },
      },
    },
    entry,
  );
}
