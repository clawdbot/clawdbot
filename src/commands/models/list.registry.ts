import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveDefaultAgentDir } from "../../agents/agent-scope.js";
import {
  shouldSuppressBuiltInModel,
  shouldSuppressBuiltInModelFromManifest,
} from "../../agents/model-suppression.js";
import { discoverAuthStorage, discoverModels } from "../../agents/pi-model-discovery.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  formatErrorWithStack,
  MODEL_AVAILABILITY_UNAVAILABLE_CODE,
  shouldFallbackToAuthHeuristics,
} from "./list.errors.js";
import { toModelRow as toModelRowBase } from "./list.model-row.js";
import type { ModelRow } from "./list.types.js";
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

function loadAvailableModels(
  registry: ModelRegistry,
  cfg: OpenClawConfig,
  opts?: { runtimeSuppression?: boolean },
): Model<Api>[] {
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

export async function loadModelRegistry(
  cfg: OpenClawConfig,
  opts?: {
    providerFilter?: string;
    normalizeModels?: boolean;
    loadAvailability?: boolean;
    workspaceDir?: string;
  },
) {
  const runtimeSuppression = opts?.normalizeModels !== false;
  const agentDir = resolveDefaultAgentDir(cfg);
  const authStorage = discoverAuthStorage(agentDir, {
    readOnly: true,
    skipCredentials: opts?.loadAvailability === false,
    config: cfg,
    workspaceDir: opts?.workspaceDir,
  });
  const registry = discoverModels(authStorage, agentDir, {
    providerFilter: opts?.providerFilter,
    normalizeModels: opts?.normalizeModels,
  });
  const models = registry.getAll().filter((model) =>
    runtimeSuppression
      ? !shouldSuppressBuiltInModel({
          provider: model.provider,
          id: model.id,
          baseUrl: model.baseUrl,
          config: cfg,
        })
      : !shouldSuppressBuiltInModelFromManifest({
          provider: model.provider,
          id: model.id,
          config: cfg,
        }),
  );
  let availableKeys: Set<string> | undefined;
  let availabilityErrorMessage: string | undefined;

  if (opts?.loadAvailability !== false) {
    try {
      const availableModels = loadAvailableModels(registry, cfg, { runtimeSuppression });
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

export function toModelRow(params: Parameters<typeof toModelRowBase>[0]): ModelRow {
  return toModelRowBase(params);
}
