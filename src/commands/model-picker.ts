import {
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "../agents/auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  getCustomProviderApiKey,
  resolveEnvApiKey,
} from "../agents/model-auth.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  modelKey,
  normalizeProviderId,
  resolveConfiguredModelRef,
} from "../agents/model-selection.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { WizardPrompter, WizardSelectOption } from "../wizard/prompts.js";
import { formatTokenK } from "./models/shared.js";

const KEEP_VALUE = "__keep__";
const MANUAL_VALUE = "__manual__";
const PROVIDER_FILTER_THRESHOLD = 30;

type PromptDefaultModelParams = {
  config: ClawdbotConfig;
  prompter: WizardPrompter;
  allowKeep?: boolean;
  includeManual?: boolean;
  ignoreAllowlist?: boolean;
  preferredProvider?: string;
  agentDir?: string;
  message?: string;
};

type PromptDefaultModelResult = { model?: string };

function hasAuthForProvider(
  provider: string,
  cfg: ClawdbotConfig,
  store: ReturnType<typeof ensureAuthProfileStore>,
) {
  if (listProfilesForProvider(store, provider).length > 0) return true;
  if (resolveEnvApiKey(provider)) return true;
  if (getCustomProviderApiKey(cfg, provider)) return true;
  return false;
}

function resolveConfiguredModelRaw(cfg: ClawdbotConfig): string {
  const raw = cfg.agents?.defaults?.model as
    | { primary?: string }
    | string
    | undefined;
  if (typeof raw === "string") return raw.trim();
  return raw?.primary?.trim() ?? "";
}

async function promptManualModel(params: {
  prompter: WizardPrompter;
  allowBlank: boolean;
  initialValue?: string;
}): Promise<PromptDefaultModelResult> {
  const modelInput = await params.prompter.text({
    message: params.allowBlank
      ? "Default model (blank to keep)"
      : "Default model",
    initialValue: params.initialValue,
    placeholder: "provider/model",
    validate: params.allowBlank
      ? undefined
      : (value) => (value?.trim() ? undefined : "Required"),
  });
  const model = String(modelInput ?? "").trim();
  if (!model) return {};
  return { model };
}

export async function promptDefaultModel(
  params: PromptDefaultModelParams,
): Promise<PromptDefaultModelResult> {
  const cfg = params.config;
  const allowKeep = params.allowKeep ?? true;
  const includeManual = params.includeManual ?? true;
  const ignoreAllowlist = params.ignoreAllowlist ?? false;
  const preferredProviderRaw = params.preferredProvider?.trim();
  const preferredProvider = preferredProviderRaw
    ? normalizeProviderId(preferredProviderRaw)
    : undefined;
  const configuredRaw = resolveConfiguredModelRaw(cfg);

  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const resolvedKey = modelKey(resolved.provider, resolved.model);
  const configuredKey = configuredRaw ? resolvedKey : "";

  const catalog = await loadModelCatalog({ config: cfg });
  if (catalog.length === 0) {
    return promptManualModel({
      prompter: params.prompter,
      allowBlank: allowKeep,
      initialValue: configuredRaw || resolvedKey || undefined,
    });
  }

  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  let models = catalog;
  if (!ignoreAllowlist) {
    const { allowedCatalog } = buildAllowedModelSet({
      cfg,
      catalog,
      defaultProvider: DEFAULT_PROVIDER,
    });
    models = allowedCatalog.length > 0 ? allowedCatalog : catalog;
  }

  if (models.length === 0) {
    return promptManualModel({
      prompter: params.prompter,
      allowBlank: allowKeep,
      initialValue: configuredRaw || resolvedKey || undefined,
    });
  }

  const providers = Array.from(
    new Set(models.map((entry) => entry.provider)),
  ).sort((a, b) => a.localeCompare(b));

  const hasPreferredProvider = preferredProvider
    ? providers.includes(preferredProvider)
    : false;
  const shouldPromptProvider =
    !hasPreferredProvider &&
    providers.length > 1 &&
    models.length > PROVIDER_FILTER_THRESHOLD;
  if (shouldPromptProvider) {
    const selection = await params.prompter.select({
      message: "Filter models by provider",
      options: [
        { value: "*", label: "All providers" },
        ...providers.map((provider) => {
          const count = models.filter(
            (entry) => entry.provider === provider,
          ).length;
          return {
            value: provider,
            label: provider,
            hint: `${count} model${count === 1 ? "" : "s"}`,
          };
        }),
      ],
    });
    if (selection !== "*") {
      models = models.filter((entry) => entry.provider === selection);
    }
  }

  if (hasPreferredProvider && preferredProvider) {
    models = models.filter((entry) => entry.provider === preferredProvider);
  }

  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const authCache = new Map<string, boolean>();
  const hasAuth = (provider: string) => {
    const cached = authCache.get(provider);
    if (cached !== undefined) return cached;
    const value = hasAuthForProvider(provider, cfg, authStore);
    authCache.set(provider, value);
    return value;
  };

  const options: WizardSelectOption<string>[] = [];
  if (allowKeep) {
    options.push({
      value: KEEP_VALUE,
      label: configuredRaw
        ? `Keep current (${configuredRaw})`
        : `Keep current (default: ${resolvedKey})`,
      hint:
        configuredRaw && configuredRaw !== resolvedKey
          ? `resolves to ${resolvedKey}`
          : undefined,
    });
  }
  if (includeManual) {
    options.push({ value: MANUAL_VALUE, label: "Enter model manually" });
  }

  const seen = new Set<string>();
  const addModelOption = (entry: {
    provider: string;
    id: string;
    name?: string;
    contextWindow?: number;
    reasoning?: boolean;
  }) => {
    const key = modelKey(entry.provider, entry.id);
    if (seen.has(key)) return;
    const hints: string[] = [];
    if (entry.name && entry.name !== entry.id) hints.push(entry.name);
    if (entry.contextWindow)
      hints.push(`ctx ${formatTokenK(entry.contextWindow)}`);
    if (entry.reasoning) hints.push("reasoning");
    const aliases = aliasIndex.byKey.get(key);
    if (aliases?.length) hints.push(`alias: ${aliases.join(", ")}`);
    if (!hasAuth(entry.provider)) hints.push("auth missing");
    options.push({
      value: key,
      label: key,
      hint: hints.length > 0 ? hints.join(" · ") : undefined,
    });
    seen.add(key);
  };

  for (const entry of models) addModelOption(entry);

  if (configuredKey && !seen.has(configuredKey)) {
    options.push({
      value: configuredKey,
      label: configuredKey,
      hint: "current (not in catalog)",
    });
  }

  let initialValue: string | undefined = allowKeep
    ? KEEP_VALUE
    : configuredKey || undefined;
  if (
    allowKeep &&
    hasPreferredProvider &&
    preferredProvider &&
    resolved.provider !== preferredProvider
  ) {
    const firstModel = models[0];
    if (firstModel) {
      initialValue = modelKey(firstModel.provider, firstModel.id);
    }
  }

  const selection = await params.prompter.select({
    message: params.message ?? "Default model",
    options,
    initialValue,
  });

  if (selection === KEEP_VALUE) return {};
  if (selection === MANUAL_VALUE) {
    return promptManualModel({
      prompter: params.prompter,
      allowBlank: false,
      initialValue: configuredRaw || resolvedKey || undefined,
    });
  }
  return { model: String(selection) };
}

export function applyPrimaryModel(
  cfg: ClawdbotConfig,
  model: string,
): ClawdbotConfig {
  const defaults = cfg.agents?.defaults;
  const existingModel = defaults?.model;
  const existingModels = defaults?.models;
  const fallbacks =
    typeof existingModel === "object" &&
    existingModel !== null &&
    "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks
      : undefined;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        model: {
          ...(fallbacks ? { fallbacks } : undefined),
          primary: model,
        },
        models: {
          ...existingModels,
          [model]: existingModels?.[model] ?? {},
        },
      },
    },
  };
}
