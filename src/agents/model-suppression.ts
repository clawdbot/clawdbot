import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildManifestBuiltInModelSuppressionResolver,
  resolveManifestBuiltInModelSuppression,
} from "../plugins/manifest-model-suppression.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeProviderId } from "./provider-id.js";

function resolveBuiltInModelSuppressionFromManifest(params: {
  provider?: string | null;
  id?: string | null;
  baseUrl?: string | null;
  config?: OpenClawConfig;
  unconditionalOnly?: boolean;
}) {
  const provider = normalizeProviderId(params.provider ?? "");
  const modelId = normalizeLowercaseStringOrEmpty(params.id);
  if (!provider || !modelId) {
    return undefined;
  }
  return resolveManifestBuiltInModelSuppression({
    provider,
    id: modelId,
    ...(params.config ? { config: params.config } : {}),
    ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
    unconditionalOnly: params.unconditionalOnly,
    env: process.env,
  });
}

function resolveBuiltInModelSuppression(params: {
  provider?: string | null;
  id?: string | null;
  baseUrl?: string | null;
  config?: OpenClawConfig;
}) {
  const manifestResult = resolveBuiltInModelSuppressionFromManifest(params);
  if (manifestResult?.suppress) {
    return manifestResult;
  }
  const provider = normalizeProviderId(params.provider ?? "");
  const modelId = normalizeLowercaseStringOrEmpty(params.id);
  if (!provider || !modelId) {
    return undefined;
  }
  return undefined;
}

export function shouldSuppressBuiltInModelFromManifest(params: {
  provider?: string | null;
  id?: string | null;
  config?: OpenClawConfig;
}) {
  return resolveBuiltInModelSuppressionFromManifest(params)?.suppress ?? false;
}

export function shouldSuppressBuiltInModel(params: {
  provider?: string | null;
  id?: string | null;
  baseUrl?: string | null;
  config?: OpenClawConfig;
}) {
  return resolveBuiltInModelSuppression(params)?.suppress ?? false;
}

// Checks only unconditional suppressions (no `when` clause). Used for inline
// model entries where user configuration may override conditional suppressions
// (e.g. custom endpoint overrides) but not absolute provider capability blocks.
export function shouldUnconditionallySuppress(params: {
  provider?: string | null;
  id?: string | null;
  config?: OpenClawConfig;
}): boolean {
  return (
    resolveBuiltInModelSuppressionFromManifest({ ...params, unconditionalOnly: true })?.suppress ??
    false
  );
}

export function buildSuppressedBuiltInModelError(params: {
  provider?: string | null;
  id?: string | null;
  baseUrl?: string | null;
  config?: OpenClawConfig;
}): string | undefined {
  return resolveBuiltInModelSuppression(params)?.errorMessage;
}

export function buildShouldSuppressBuiltInModel(params: {
  config?: OpenClawConfig;
}): (input: { provider?: string | null; id?: string | null; baseUrl?: string | null }) => boolean {
  const resolver = buildManifestBuiltInModelSuppressionResolver({
    config: params.config,
    env: process.env,
  });

  return (input) => {
    const provider = normalizeProviderId(input.provider ?? "");
    const id = normalizeLowercaseStringOrEmpty(input.id);
    if (!provider || !id) {
      return false;
    }
    return resolver({ ...input, provider, id })?.suppress ?? false;
  };
}
