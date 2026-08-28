import { readFileSync } from "node:fs";
import { homedir as readHomeDir } from "node:os";
import path from "node:path";
import { resolveProviderIdForAuth } from "openclaw/plugin-sdk/agent-runtime";
import { parse as parseToml } from "smol-toml";
import type {
  CodexAppServerHomeScope,
  CodexModelBackedReviewerContext,
  ProviderAuthAliasConfig,
} from "./config-contracts.js";
import {
  firstTomlTableOffset,
  parseInlineOpenAIModelProviderBaseUrl,
  parseTomlStringValue,
  parseTomlTableSection,
  stripTomlLineComments,
} from "./config-requirements.js";
import { readNonEmptyString, readRecord } from "./config-utils.js";
import type { CodexConfigReadParams, CodexConfigReadResponse } from "./protocol-control-plane.js";

const CODEX_APP_SERVER_HOME_DIRNAME = "codex-home";
const CODEX_CONFIG_TOML_FILENAME = "config.toml";

/** Cloud/system config can redirect reviews after local home/profile checks have passed. */
export async function assertCodexModelBackedReviewerEffectiveConfig(params: {
  client: {
    request: (
      method: "config/read",
      params: CodexConfigReadParams,
      options: { signal?: AbortSignal },
    ) => Promise<CodexConfigReadResponse>;
  };
  approvalsReviewer: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (
    params.approvalsReviewer !== "auto_review" &&
    params.approvalsReviewer !== "guardian_subagent"
  ) {
    return;
  }
  const response = await params.client.request(
    "config/read",
    { cwd: path.resolve(params.cwd), includeLayers: false },
    { signal: params.signal },
  );
  const effectiveConfig = readRecord(readRecord(response)?.config);
  if (!effectiveConfig) {
    throw new Error("Codex config/read returned an invalid model-backed reviewer config");
  }
  const modelProvider = effectiveConfig.model_provider;
  const providers = effectiveConfig.model_providers;
  const providerRecords = providers == null ? undefined : readRecord(providers);
  const provider = providerRecords?.openai;
  const openAIProvider = provider == null ? undefined : readRecord(provider);
  if (
    (modelProvider != null && modelProvider !== "openai") ||
    (providers != null && !providerRecords) ||
    (provider != null && !openAIProvider) ||
    !isTrustedOptionalReviewerEndpoint(effectiveConfig.openai_base_url, isNativeOpenAIBaseUrl) ||
    !isTrustedOptionalReviewerEndpoint(effectiveConfig.chatgpt_base_url, isNativeChatGPTBaseUrl) ||
    !isTrustedOptionalReviewerEndpoint(openAIProvider?.base_url, isNativeOpenAIBaseUrl)
  ) {
    throw new Error(
      "Codex model-backed approval reviewer requires the running server to use a trusted OpenAI endpoint",
    );
  }
}

function isTrustedOptionalReviewerEndpoint(
  value: unknown,
  isTrusted: (value: unknown) => boolean,
): boolean {
  return value == null || (typeof value === "string" && isTrusted(value));
}

export function canUseCodexModelBackedApprovalsReviewerForModel(
  params: CodexModelBackedReviewerContext,
): boolean {
  const explicitProvider = params.modelProvider?.trim().toLowerCase();
  const inferredProvider = inferProviderFromModelRef(params.model);
  if (explicitProvider && explicitProvider !== "codex") {
    return (
      isTrustedCodexModelBackedApprovalsReviewerProvider(explicitProvider, params) &&
      (inferredProvider === undefined ||
        isTrustedCodexModelBackedApprovalsReviewerProvider(inferredProvider, params))
    );
  }
  if (inferredProvider !== undefined) {
    return isTrustedCodexModelBackedApprovalsReviewerProvider(inferredProvider, params);
  }
  return isTrustedCodexModelBackedApprovalsReviewerProvider(explicitProvider, params);
}

function isTrustedCodexModelBackedOpenAIProvider(params: {
  config?: ProviderAuthAliasConfig;
  env?: NodeJS.ProcessEnv;
  model?: string;
  agentDir?: string;
  codexConfigToml?: string | null;
  homeScope?: CodexAppServerHomeScope;
  codexArgs?: readonly string[];
}): boolean {
  if (!openAIBaseUrlEnvOverridesAreTrustedForModelBackedReview(params.env)) {
    return false;
  }
  const codexBaseUrlOverrides = readCodexBaseUrlOverridesForModelBackedReview(params);
  if (
    codexBaseUrlOverrides === false ||
    !codexBaseUrlOverrides.openAI.every(isNativeOpenAIBaseUrl) ||
    !codexBaseUrlOverrides.chatGPT.every(isNativeChatGPTBaseUrl)
  ) {
    return false;
  }
  const openAIProviders = readConfiguredOpenAIProvidersForModelBackedReview(params.config);
  if (openAIProviders.length === 0) {
    return true;
  }
  return openAIProviders.every((openAIProvider) =>
    configuredOpenAIProviderIsTrustedForModelBackedReview(openAIProvider, params.model),
  );
}

export function resolveCodexModelBackedReviewerPolicyContext(params: {
  provider?: string;
  model?: string;
  bindingModelProvider?: string;
  bindingModel?: string;
  nativeAuthProfile?: boolean;
}): CodexModelBackedReviewerContext {
  const provider = params.provider?.trim();
  if (provider && provider.toLowerCase() !== "codex") {
    return {
      modelProvider: normalizeCodexModelBackedReviewerPolicyProvider(provider),
      model: params.model,
    };
  }
  const bindingModelProvider = params.bindingModelProvider?.trim();
  const currentModel = params.model?.trim();
  const bindingModel = params.bindingModel?.trim();
  if (bindingModelProvider && currentModel && bindingModel && currentModel === bindingModel) {
    return {
      modelProvider: normalizeCodexModelBackedReviewerPolicyProvider(bindingModelProvider),
      model: params.model ?? params.bindingModel,
    };
  }
  const currentModelProvider = inferProviderFromModelRef(params.model);
  if (currentModelProvider) {
    return {
      modelProvider: normalizeCodexModelBackedReviewerPolicyProvider(currentModelProvider),
      model: params.model,
    };
  }
  if (bindingModelProvider) {
    return {
      modelProvider: normalizeCodexModelBackedReviewerPolicyProvider(bindingModelProvider),
      model: params.model ?? params.bindingModel,
    };
  }
  return {
    modelProvider: params.nativeAuthProfile === true ? "openai" : undefined,
    model: params.model ?? params.bindingModel,
  };
}

function isCodexModelBackedApprovalsReviewerProvider(provider: string | undefined): boolean {
  const normalized = provider?.trim().toLowerCase();
  return normalized === "openai";
}

function isTrustedCodexModelBackedApprovalsReviewerProvider(
  provider: string | undefined,
  params: CodexModelBackedReviewerContext,
): boolean {
  return (
    isCodexModelBackedApprovalsReviewerProvider(provider) &&
    isTrustedCodexModelBackedOpenAIProvider({
      config: params.config,
      env: params.env,
      model: params.model,
      agentDir: params.agentDir,
      codexConfigToml: params.codexConfigToml,
      homeScope: params.homeScope,
      codexArgs: params.codexArgs,
    })
  );
}

function readCodexBaseUrlOverridesForModelBackedReview(
  params: Pick<
    CodexModelBackedReviewerContext,
    "agentDir" | "codexArgs" | "codexConfigToml" | "env" | "homeScope"
  >,
): { openAI: string[]; chatGPT: string[] } | false {
  const configToml = readCodexAppServerConfigToml(params);
  if (configToml === false) {
    return false;
  }
  const configTomls = configToml === undefined ? [] : [configToml];
  const nativeOverrides = readNativeCodexReviewerConfigOverrides(params);
  if (nativeOverrides === false) {
    return false;
  }
  configTomls.push(...nativeOverrides);
  const openAI: Array<string | undefined | false> = [];
  const chatGPT: Array<string | undefined | false> = [];
  for (const content of configTomls) {
    const topLevelContent = stripTomlLineComments(content).slice(0, firstTomlTableOffset(content));
    const modelProviderOpenAISection = parseTomlTableSection(content, "model_providers.openai");
    const modelProvider = parseTomlStringValue(topLevelContent, "model_provider");
    if (modelProvider === false || (modelProvider && modelProvider !== "openai")) {
      return false;
    }
    openAI.push(
      parseTomlStringValue(topLevelContent, "openai_base_url"),
      parseTomlStringValue(topLevelContent, "model_providers.openai.base_url"),
      parseInlineOpenAIModelProviderBaseUrl(topLevelContent),
      modelProviderOpenAISection
        ? parseTomlStringValue(modelProviderOpenAISection, "base_url")
        : undefined,
    );
    chatGPT.push(parseTomlStringValue(topLevelContent, "chatgpt_base_url"));
  }
  if ([...openAI, ...chatGPT].includes(false)) {
    return false;
  }
  return {
    openAI: openAI.filter((entry): entry is string => typeof entry === "string"),
    chatGPT: chatGPT.filter((entry): entry is string => typeof entry === "string"),
  };
}

function readNativeCodexReviewerConfigOverrides(
  params: Pick<CodexModelBackedReviewerContext, "agentDir" | "codexArgs" | "env" | "homeScope">,
): string[] | false {
  const overrides: string[] = [];
  let profile: string | undefined;
  const args = params.codexArgs ?? [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      return false;
    }
    if (arg === "--profile" || arg === "-p") {
      profile = args[++index];
    } else if (arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length);
    } else if (arg === "-c" || arg === "--config") {
      const override = args[++index];
      if (!override) {
        return false;
      }
      overrides.push(`${override}\n`);
    } else if (arg.startsWith("--config=")) {
      overrides.push(`${arg.slice("--config=".length)}\n`);
    }
  }
  if (profile) {
    if (path.basename(profile) !== profile || profile === "." || profile === "..") {
      return false;
    }
    const configPath = resolveCodexAppServerConfigPath(params);
    if (!configPath) {
      return false;
    }
    try {
      overrides.unshift(
        readFileSync(path.join(path.dirname(configPath), `${profile}.config.toml`), "utf8"),
      );
    } catch (error) {
      if (readErrorCode(error) !== "ENOENT") {
        return false;
      }
    }
  }
  return overrides;
}

function readCodexAppServerConfigToml(
  params: Pick<
    CodexModelBackedReviewerContext,
    "agentDir" | "codexConfigToml" | "env" | "homeScope"
  >,
): string | undefined | false {
  if (params.codexConfigToml !== undefined) {
    return params.codexConfigToml ?? undefined;
  }
  const configPath = resolveCodexAppServerConfigPath(params);
  if (!configPath) {
    return undefined;
  }
  try {
    return readFileSync(configPath, "utf8");
  } catch (error) {
    return readErrorCode(error) === "ENOENT" ? undefined : false;
  }
}

export function codexConfigEnablesNativeComputerUse(
  params: Pick<
    CodexModelBackedReviewerContext,
    "agentDir" | "codexConfigToml" | "env" | "homeScope"
  > & { pluginNames: readonly string[] },
): boolean {
  const configToml = readCodexAppServerConfigToml(params);
  if (configToml === false) {
    return true;
  }
  if (configToml === undefined) {
    return false;
  }
  let parsedConfig: Record<string, unknown>;
  try {
    parsedConfig = parseToml(configToml, { integersAsBigInt: true }) as Record<string, unknown>;
  } catch {
    return true;
  }
  const rawPlugins = parsedConfig.plugins;
  if (rawPlugins === undefined) {
    return false;
  }
  const plugins = readRecord(rawPlugins);
  if (!plugins) {
    return true;
  }
  for (const [pluginId, rawPluginConfig] of Object.entries(plugins)) {
    const matchesManagedIdentity = params.pluginNames.some(
      (pluginName) => pluginId === pluginName || pluginId.startsWith(`${pluginName}@`),
    );
    if (!matchesManagedIdentity) {
      continue;
    }
    const pluginConfig = readRecord(rawPluginConfig);
    if (!pluginConfig) {
      return true;
    }
    if (pluginConfig.enabled === false) {
      continue;
    }
    // Codex defaults omitted enablement to true; malformed state stays conservative.
    return true;
  }
  return false;
}

function resolveCodexAppServerConfigPath(
  params: Pick<CodexModelBackedReviewerContext, "agentDir" | "env" | "homeScope">,
): string | undefined {
  if (params.homeScope === "user") {
    return path.join(resolveCodexAppServerUserHomeDir(params.env), CODEX_CONFIG_TOML_FILENAME);
  }
  const agentDir = readNonEmptyString(params.agentDir);
  const codexHome = agentDir
    ? path.join(path.resolve(agentDir), CODEX_APP_SERVER_HOME_DIRNAME)
    : undefined;
  return codexHome ? path.join(codexHome, CODEX_CONFIG_TOML_FILENAME) : undefined;
}

/** Resolves the native user Codex home used by Desktop and the CLI. */
export function resolveCodexAppServerUserHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = readHomeDir,
): string {
  const configured = readNonEmptyString(env.CODEX_HOME);
  return path.resolve(configured ?? path.join(homedir(), ".codex"));
}

function readErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function readConfiguredOpenAIProvidersForModelBackedReview(
  config: ProviderAuthAliasConfig | undefined,
): Array<Record<string, unknown>> {
  const providerRecords = readRecord(readRecord(readRecord(config)?.models)?.providers);
  if (!providerRecords) {
    return [];
  }
  const openAIProviders: Array<Record<string, unknown>> = [];
  for (const [providerId, providerConfig] of Object.entries(providerRecords)) {
    if (resolveProviderIdForAuth(providerId, { config }) !== "openai") {
      continue;
    }
    const record = readRecord(providerConfig);
    if (record) {
      openAIProviders.push(record);
    }
  }
  return openAIProviders;
}

function configuredOpenAIProviderIsTrustedForModelBackedReview(
  openAIProvider: Record<string, unknown>,
  modelInput: string | undefined,
): boolean {
  if (
    readRecord(openAIProvider.localService) ||
    hasNonEmptyRecord(openAIProvider.headers) ||
    hasNonEmptyRecord(openAIProvider.request) ||
    typeof openAIProvider.authHeader === "boolean" ||
    !isNativeOpenAIBaseUrl(openAIProvider.baseUrl)
  ) {
    return false;
  }
  const models = openAIProvider.models;
  if (!Array.isArray(models)) {
    return true;
  }
  const modelId = normalizeOpenAIModelBackedReviewerModelId(modelInput);
  if (!modelId) {
    return false;
  }
  for (const entry of models) {
    const model = readRecord(entry);
    if (typeof model?.id !== "string" || !matchesConfiguredOpenAIModelId(modelId, model.id)) {
      continue;
    }
    if (
      hasNonEmptyRecord(model.headers) ||
      hasNonEmptyRecord(model.request) ||
      !isNativeOpenAIBaseUrl(model.baseUrl)
    ) {
      return false;
    }
  }
  return true;
}

function normalizeOpenAIModelBackedReviewerModelId(modelInput: string | undefined): string {
  const normalized = modelInput?.trim() ?? "";
  const authProfileIndex = normalized.indexOf("@");
  const withoutAuthProfile =
    authProfileIndex > 0 ? normalized.slice(0, authProfileIndex) : normalized;
  const slashIndex = withoutAuthProfile.indexOf("/");
  return slashIndex > 0 ? withoutAuthProfile.slice(slashIndex + 1).trim() : withoutAuthProfile;
}

function matchesConfiguredOpenAIModelId(modelId: string, configuredModelId: string): boolean {
  const configured = normalizeOpenAIModelBackedReviewerModelId(configuredModelId);
  return Boolean(configured) && (modelId === configured || modelId.startsWith(`${configured}@`));
}

function hasNonEmptyRecord(value: unknown): boolean {
  const record = readRecord(value);
  return record !== undefined && Object.keys(record).length > 0;
}

function isNativeOpenAIBaseUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return true;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

function openAIBaseUrlEnvOverridesAreTrustedForModelBackedReview(
  env: NodeJS.ProcessEnv | undefined,
): boolean {
  return [env?.OPENAI_BASE_URL, env?.OPENAI_API_BASE].every(isNativeOpenAIBaseUrl);
}

function isNativeChatGPTBaseUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return true;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "chatgpt.com";
  } catch {
    return false;
  }
}

function normalizeCodexModelBackedReviewerPolicyProvider(provider: string): string {
  return provider.toLowerCase() === "openai" ? "openai" : provider;
}

function inferProviderFromModelRef(model: string | undefined): string | undefined {
  const normalized = model?.trim().toLowerCase();
  const slashIndex = normalized?.indexOf("/") ?? -1;
  return slashIndex > 0 ? normalized?.slice(0, slashIndex) : undefined;
}
