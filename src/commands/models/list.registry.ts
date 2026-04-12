import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { shouldSuppressBuiltInModel } from "../../agents/model-suppression.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  formatErrorWithStack,
  MODEL_AVAILABILITY_UNAVAILABLE_CODE,
  shouldFallbackToAuthHeuristics,
} from "./list.errors.js";
import {
  discoverAuthStorage,
  discoverModels,
  hasUsableCustomProviderApiKey,
  listProfilesForProvider,
  resolveAwsSdkEnvVarName,
  resolveEnvApiKey,
  resolveOpenClawAgentDir,
} from "./list.runtime.js";
import type { ModelRow } from "./list.types.js";
import { isLocalBaseUrl, modelKey } from "./shared.js";

const hasAuthForProvider = (
  provider: string,
  cfg?: OpenClawConfig,
  authStore?: AuthProfileStore,
) => {
  if (!cfg || !authStore) {
    return false;
  }
  if (listProfilesForProvider(authStore, provider).length > 0) {
    return true;
  }
  if (provider === "amazon-bedrock" && resolveAwsSdkEnvVarName()) {
    return true;
  }
  if (resolveEnvApiKey(provider)) {
    return true;
  }
  if (hasUsableCustomProviderApiKey(cfg, provider)) {
    return true;
  }
  return false;
};

function createAvailabilityUnavailableError(message: string): Error {
  const err = new Error(message);
  (err as { code?: string }).code = MODEL_AVAILABILITY_UNAVAILABLE_CODE;
  return err;
}

function normalizeAvailabilityError(err: unknown): Error {
  if (shouldFallbackToAuthHeuristics(err) && err instanceof Error) {
    return err;
  }
  return createAvailabilityUnavailableError(
    `Model availability unavailable: getAvailable() failed.\n${formatErrorWithStack(err)}`,
  );
}

function validateAvailableModels(availableModels: unknown): Model<Api>[] {
  if (!Array.isArray(availableModels)) {
    throw createAvailabilityUnavailableError(
      "Model availability unavailable: getAvailable() returned a non-array value.",
    );
  }

  for (const model of availableModels) {
    if (
      !model ||
      typeof model !== "object" ||
      typeof (model as { provider?: unknown }).provider !== "string" ||
      typeof (model as { id?: unknown }).id !== "string"
    ) {
      throw createAvailabilityUnavailableError(
        "Model availability unavailable: getAvailable() returned invalid model entries.",
      );
    }
  }

  return availableModels as Model<Api>[];
}

function loadAvailableModels(registry: ModelRegistry, cfg: OpenClawConfig): Model<Api>[] {
  let availableModels: unknown;
  try {
    availableModels = registry.getAvailable();
  } catch (err) {
    throw normalizeAvailabilityError(err);
  }
  try {
    return validateAvailableModels(availableModels).filter(
      (model) =>
        !shouldSuppressBuiltInModel({
          provider: model.provider,
          id: model.id,
          baseUrl: model.baseUrl,
          config: cfg,
        }),
    );
  } catch (err) {
    throw normalizeAvailabilityError(err);
  }
}

export async function loadModelRegistry(
  cfg: OpenClawConfig,
  _opts?: { sourceConfig?: OpenClawConfig },
) {
  const agentDir = resolveOpenClawAgentDir();
  const authStorage = discoverAuthStorage(agentDir);
  const registry = discoverModels(authStorage, agentDir);
  const models = registry.getAll().filter(
    (model) =>
      !shouldSuppressBuiltInModel({
        provider: model.provider,
        id: model.id,
        baseUrl: model.baseUrl,
        config: cfg,
      }),
  );
  let availableKeys: Set<string> | undefined;
  let availabilityErrorMessage: string | undefined;

  try {
    const availableModels = loadAvailableModels(registry, cfg);
    availableKeys = new Set(availableModels.map((model) => modelKey(model.provider, model.id)));
  } catch (err) {
    if (!shouldFallbackToAuthHeuristics(err)) {
      throw err;
    }

    // Some providers can report model-level availability as unavailable.
    // Fall back to provider-level auth heuristics when availability is undefined.
    availableKeys = undefined;
    if (!availabilityErrorMessage) {
      availabilityErrorMessage = formatErrorWithStack(err);
    }
  }
  return { registry, models, availableKeys, availabilityErrorMessage };
}

export function toModelRow(params: {
  model?: Model<Api>;
  key: string;
  tags: string[];
  aliases?: string[];
  availableKeys?: Set<string>;
  cfg?: OpenClawConfig;
  authStore?: AuthProfileStore;
  allowProviderAvailabilityFallback?: boolean;
}): ModelRow {
  const {
    model,
    key,
    tags,
    aliases = [],
    availableKeys,
    cfg,
    authStore,
    allowProviderAvailabilityFallback = false,
  } = params;
  if (!model) {
    return {
      key,
      name: key,
      input: "-",
      contextWindow: null,
      local: null,
      available: null,
      tags: [...tags, "missing"],
      missing: true,
    };
  }

  const input = model.input.join("+") || "text";
  const local = isLocalBaseUrl(model.baseUrl);
  const modelIsAvailable = availableKeys?.has(modelKey(model.provider, model.id)) ?? false;
  // Prefer model-level registry availability when present.
  // Fall back to provider-level auth heuristics only if registry availability isn't available,
  // or if the caller marks this as a synthetic/forward-compat model that won't appear in getAvailable().
  const available =
    availableKeys !== undefined && !allowProviderAvailabilityFallback
      ? modelIsAvailable
      : modelIsAvailable ||
        (cfg && authStore ? hasAuthForProvider(model.provider, cfg, authStore) : false);
  const aliasTags = aliases.length > 0 ? [`alias:${aliases.join(",")}`] : [];
  const mergedTags = new Set(tags);
  if (aliasTags.length > 0) {
    for (const tag of mergedTags) {
      if (tag === "alias" || tag.startsWith("alias:")) {
        mergedTags.delete(tag);
      }
    }
    for (const tag of aliasTags) {
      mergedTags.add(tag);
    }
  }

  return {
    key,
    name: model.name || model.id,
    input,
    contextWindow: model.contextWindow ?? null,
    local,
    available,
    tags: Array.from(mergedTags),
    missing: false,
  };
}
