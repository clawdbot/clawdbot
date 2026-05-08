import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeGooglePreviewModelId } from "../plugin-sdk/provider-model-id-normalize.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import { liveProvidersShareOwningPlugin } from "./live-provider-owner.js";
import { normalizeProviderId } from "./provider-id.js";

type ModelTarget = {
  raw: string;
  provider?: string;
  modelId: string;
};

const GOOGLE_LIVE_TARGET_PROVIDERS = new Set(["google", "google-gemini-cli", "google-vertex"]);

function normalizeLiveTargetModelId(provider: string, modelId: string): string {
  const trimmed = modelId.trim();
  return GOOGLE_LIVE_TARGET_PROVIDERS.has(provider)
    ? normalizeGooglePreviewModelId(trimmed)
    : trimmed;
}

function normalizeCsvSet(values: Set<string> | null): Set<string> | null {
  if (!values) {
    return null;
  }
  const normalized = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    normalized.add(trimmed);
  }
  return normalized.size > 0 ? normalized : null;
}

function parseModelTarget(raw: string): ModelTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    return {
      raw: trimmed,
      modelId: normalizeLowercaseStringOrEmpty(trimmed),
    };
  }
  const provider = normalizeProviderId(trimmed.slice(0, slash));
  const modelId = normalizeLowercaseStringOrEmpty(
    normalizeLiveTargetModelId(provider, trimmed.slice(slash + 1)),
  );
  if (!provider || !modelId) {
    return null;
  }
  return {
    raw: trimmed,
    provider,
    modelId,
  };
}

export function createLiveTargetMatcher(params: {
  providerFilter: Set<string> | null;
  modelFilter: Set<string> | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const providerFilter = normalizeCsvSet(params.providerFilter);
  const modelTargets = [...(normalizeCsvSet(params.modelFilter) ?? [])]
    .map((value) => parseModelTarget(value))
    .filter((value): value is ModelTarget => value !== null);
  const ownerCache = new Map<string, readonly string[]>();

  return {
    matchesProvider(provider: string): boolean {
      if (!providerFilter) {
        return true;
      }
      const normalizedProvider = normalizeProviderId(provider);
      for (const requested of providerFilter) {
        const normalizedRequested = normalizeProviderId(requested);
        if (normalizedRequested === normalizedProvider) {
          return true;
        }
        if (
          liveProvidersShareOwningPlugin(normalizedRequested, normalizedProvider, {
            config: params.config,
            workspaceDir: params.workspaceDir,
            env: params.env,
            ownerCache,
          })
        ) {
          return true;
        }
      }
      return false;
    },
    matchesModel(provider: string, modelId: string): boolean {
      if (modelTargets.length === 0) {
        return true;
      }
      const normalizedProvider = normalizeProviderId(provider);
      const normalizedModelId = normalizeOptionalLowercaseString(modelId);
      if (!normalizedModelId) {
        return false;
      }
      const directRef = `${normalizedProvider}/${normalizedModelId}`;
      for (const target of modelTargets) {
        if (normalizeOptionalLowercaseString(target.raw) === directRef) {
          return true;
        }
        if (target.modelId !== normalizedModelId) {
          continue;
        }
        if (!target.provider) {
          return true;
        }
        if (target.provider === normalizedProvider) {
          return true;
        }
        if (
          liveProvidersShareOwningPlugin(target.provider, normalizedProvider, {
            config: params.config,
            workspaceDir: params.workspaceDir,
            env: params.env,
            ownerCache,
          })
        ) {
          return true;
        }
      }
      return false;
    },
  };
}
