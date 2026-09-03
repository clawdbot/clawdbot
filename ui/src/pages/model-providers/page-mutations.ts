// Config patches, probe merging, and error copy owned by the Models settings page.
import type { FastMode, ModelsProbeResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { ModelProviderRowMessage } from "./view.ts";

export type ModelBehaviorConfig = {
  thinkingLevel: string | undefined;
  thinkingOverridden: boolean;
  fastMode: FastMode | undefined;
  fastModeOverridden: boolean;
};

export type ModelProviderConfigMutation = {
  key: string;
  raw: Record<string, unknown>;
  note: string;
  success: string;
  replacePaths?: string[];
};

export type ModelProviderConfigMutationResult =
  | { ok: false }
  | { ok: true; agentEpoch: number; warning: string | null };

type ModelProviderConfigMutationOwner = {
  runtimeConfig: RuntimeConfigCapability;
  agentEpoch: number;
  isCurrentClient: () => boolean;
  isCurrentAgent: () => boolean;
  refreshProviders: () => Promise<void>;
  setBusy: (busy: boolean) => void;
  setMessage: (message: ModelProviderRowMessage | null) => void;
};

const PROBE_FAILURE_PRIORITY: readonly ModelsProbeResult["status"][] = [
  "auth",
  "billing",
  "rate_limit",
  "timeout",
  "format",
  "no_model",
  "unknown",
];

export function modelProviderErrorMessage(error: unknown): string {
  return formatUiError(error, t("modelProviders.requestFailed"));
}

export function readModelBehaviorConfig(
  agentsDefaults: Record<string, unknown> | null,
): ModelBehaviorConfig {
  const thinkingValue = agentsDefaults?.thinkingDefault;
  const fastValue = agentsDefaults?.fastModeDefault;
  return {
    thinkingLevel: typeof thinkingValue === "string" ? thinkingValue : undefined,
    thinkingOverridden: agentsDefaults !== null && Object.hasOwn(agentsDefaults, "thinkingDefault"),
    fastMode: fastValue === "auto" || typeof fastValue === "boolean" ? fastValue : undefined,
    fastModeOverridden: agentsDefaults !== null && Object.hasOwn(agentsDefaults, "fastModeDefault"),
  };
}

export function buildProviderApiKeyPatch(provider: string, apiKey: string | null) {
  return {
    models: {
      providers: {
        [provider]: { apiKey },
      },
    },
  };
}

/**
 * Removing or reordering fallbacks shrinks a config array; the gateway's
 * destructive-array guard rejects such merge patches unless the exact path is
 * confirmed via replacePaths.
 */
export const DEFAULT_MODELS_REPLACE_PATHS = ["agents.defaults.model.fallbacks"];

export function buildDefaultsPatch(params: {
  primary: string;
  fallbacks: readonly string[];
  utilityModel: string | null;
  thinkingLevel: string | undefined;
  thinkingOverridden: boolean;
  fastMode: FastMode | undefined;
  fastModeOverridden: boolean;
}) {
  return {
    agents: {
      defaults: {
        ...(params.primary
          ? {
              model:
                params.fallbacks.length > 0
                  ? { primary: params.primary, fallbacks: [...params.fallbacks] }
                  : params.primary,
              utilityModel: params.utilityModel,
            }
          : {}),
        thinkingDefault:
          params.thinkingOverridden && params.thinkingLevel ? params.thinkingLevel : null,
        fastModeDefault:
          params.fastModeOverridden && params.fastMode !== undefined ? params.fastMode : null,
      },
    },
  };
}

export function isMissingMethodError(error: unknown): boolean {
  return /method (?:not found|not supported)|unknown method/iu.test(
    modelProviderErrorMessage(error),
  );
}

export function mergeProbeResults(cardId: string, results: ModelsProbeResult[]): ModelsProbeResult {
  if (results.length === 1) {
    return results[0]!;
  }
  const status = results.some((result) => result.status === "ok")
    ? "ok"
    : (PROBE_FAILURE_PRIORITY.find((candidate) =>
        results.some((result) => result.status === candidate),
      ) ?? "unknown");
  const error = results.find((result) => result.status === status)?.error;
  return {
    provider: cardId,
    status,
    ...(error ? { error } : {}),
    results: results.flatMap((result) =>
      result.results.map((target) => ({
        ...target,
        label: `${result.provider}: ${target.label}`,
      })),
    ),
  };
}

/**
 * Config patches are global; the initiating agent owns only busy/message UI.
 * Refresh warnings must preserve an already acknowledged mutation.
 */
export async function runModelProviderConfigMutation(
  owner: ModelProviderConfigMutationOwner,
  params: ModelProviderConfigMutation,
): Promise<ModelProviderConfigMutationResult> {
  const { agentEpoch, runtimeConfig } = owner;
  owner.setBusy(true);
  owner.setMessage(null);
  try {
    await runtimeConfig.ensureLoaded();
    if (!owner.isCurrentClient()) {
      return { ok: false };
    }
    const patched = await runtimeConfig.patch({
      raw: params.raw,
      note: params.note,
      ...(params.replacePaths ? { replacePaths: params.replacePaths } : {}),
    });
    if (!owner.isCurrentClient()) {
      return { ok: false };
    }
    if (!patched) {
      if (owner.isCurrentAgent()) {
        owner.setMessage({
          kind: "error",
          text: runtimeConfig.state.lastError ?? t("modelProviders.configUnavailable"),
        });
      }
      return { ok: false };
    }

    let warning: string | null = null;
    try {
      await runtimeConfig.refresh();
      // The config owner records ordinary config.get failures in lastError
      // and resolves refresh(), so rejection alone cannot detect them.
      warning = runtimeConfig.state.lastError;
      if (!warning && owner.isCurrentClient()) {
        await owner.refreshProviders();
      }
    } catch (error) {
      // An acknowledged config patch is already committed; a later refresh
      // failure must not turn it into a failed credential edit.
      warning = modelProviderErrorMessage(error);
    }
    if (!owner.isCurrentClient()) {
      return { ok: false };
    }
    if (owner.isCurrentAgent()) {
      owner.setMessage({
        kind: "success",
        text: params.success,
        ...(warning ? { warning } : {}),
      });
    }
    return { ok: true, agentEpoch, warning };
  } catch (error) {
    if (owner.isCurrentClient() && owner.isCurrentAgent()) {
      owner.setMessage({ kind: "error", text: modelProviderErrorMessage(error) });
    }
    return { ok: false };
  } finally {
    if (owner.isCurrentClient() && owner.isCurrentAgent()) {
      owner.setBusy(false);
    }
  }
}
