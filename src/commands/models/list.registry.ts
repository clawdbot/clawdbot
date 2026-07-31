import {
  shouldSuppressBuiltInModel,
  shouldSuppressBuiltInModelFromManifest,
} from "../../agents/model-suppression.js";
/** Model registry access helpers for `openclaw models list`. */
import { loadPreparedAgentModelRegistry as loadAgentModelRegistry } from "../../agents/prepared-model-registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ModelRegistry } from "../../llm/model-registry.js";
import type { Model } from "../../llm/types.js";
import {
  formatErrorWithStack,
  MODEL_AVAILABILITY_UNAVAILABLE_CODE,
  shouldFallbackToAuthHeuristics,
} from "./list.errors.js";
import { modelKey } from "./shared.js";

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

function validateAvailableModels(availableModels: unknown): Model[] {
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

  return availableModels as Model[];
}

function loadAvailableModels(
  registry: ModelRegistry,
  cfg: OpenClawConfig,
  opts?: { runtimeSuppression?: boolean },
): Model[] {
  let availableModels: unknown;
  try {
    availableModels = registry.getAvailable();
  } catch (err) {
    throw normalizeAvailabilityError(err);
  }
  try {
    return validateAvailableModels(availableModels).filter((model) =>
      opts?.runtimeSuppression === false
        ? !shouldSuppressBuiltInModelFromManifest({
            provider: model.provider,
            id: model.id,
            baseUrl: model.baseUrl,
            config: cfg,
          })
        : !shouldSuppressBuiltInModel({
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

/** Loads registry models and optional availability keys with suppression applied. */
export async function loadModelRegistry(
  cfg: OpenClawConfig,
  opts?: {
    agentId?: string;
    agentDir?: string;
    providerFilter?: string;
    normalizeModels?: boolean;
    loadAvailability?: boolean;
    workspaceDir?: string;
  },
) {
  const runtimeSuppression = opts?.normalizeModels !== false;
  const skipDiscovery = opts?.loadAvailability === false;
  const { config: runtimeConfig, registry } = await loadAgentModelRegistry(cfg, {
    ...(opts?.agentId ? { agentId: opts.agentId } : {}),
    ...(opts?.agentDir ? { agentDir: opts.agentDir } : {}),
    skipCredentials: skipDiscovery,
    workspaceDir: opts?.workspaceDir,
    providerFilter: opts?.providerFilter,
    normalizeModels: opts?.normalizeModels,
  });
  const models = registry.getAll().filter((model) =>
    runtimeSuppression
      ? !shouldSuppressBuiltInModel({
          provider: model.provider,
          id: model.id,
          baseUrl: model.baseUrl,
          config: runtimeConfig,
        })
      : !shouldSuppressBuiltInModelFromManifest({
          provider: model.provider,
          id: model.id,
          baseUrl: model.baseUrl,
          config: runtimeConfig,
        }),
  );
  let availableKeys: Set<string> | undefined;
  let availabilityErrorMessage: string | undefined;

  if (opts?.loadAvailability !== false) {
    try {
      const availableModels = loadAvailableModels(registry, runtimeConfig, { runtimeSuppression });
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
  }
  return { registry, models, availableKeys, availabilityErrorMessage };
}
