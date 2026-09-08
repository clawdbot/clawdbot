// Model reference formatting helpers for auto-reply runtime status.
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions.js";

type ModelRef = {
  provider: string;
  model: string;
  label: string;
};

function normalizeModelRef(
  rawModel: string,
  fallbackProvider: string,
  parseEmbeddedProvider = false,
): ModelRef {
  const trimmed = normalizeOptionalString(rawModel) ?? "";
  const slashIndex = parseEmbeddedProvider ? trimmed.indexOf("/") : -1;
  if (slashIndex > 0) {
    const provider = normalizeOptionalString(trimmed.slice(0, slashIndex)) ?? "";
    const model = normalizeOptionalString(trimmed.slice(slashIndex + 1)) ?? "";
    if (provider && model) {
      return {
        provider,
        model,
        label: `${provider}/${model}`,
      };
    }
  }
  // With a separate provider, the model ID is already provider-local; its prefix is literal.
  const provider = normalizeOptionalString(fallbackProvider) ?? "";
  return {
    provider,
    model: trimmed,
    label: provider ? buildModelCatalogRef(provider, trimmed) : trimmed,
  };
}

/** Compare configured selected model with the active model stored on a session. */
export function resolveSelectedAndActiveModel(params: {
  selectedProvider: string;
  selectedModel: string;
  sessionEntry?: Pick<SessionEntry, "modelProvider" | "model">;
  parseSelectedProvider?: boolean;
}): {
  selected: ModelRef;
  active: ModelRef;
  activeDiffers: boolean;
} {
  const selected = normalizeModelRef(
    params.selectedModel,
    params.selectedProvider,
    params.parseSelectedProvider,
  );
  const runtimeModel = normalizeOptionalString(params.sessionEntry?.model);
  const runtimeProvider = normalizeOptionalString(params.sessionEntry?.modelProvider);

  const active = runtimeModel
    ? normalizeModelRef(runtimeModel, runtimeProvider || selected.provider, !runtimeProvider)
    : selected;
  const activeDiffers = active.provider !== selected.provider || active.model !== selected.model;

  return {
    selected,
    active,
    activeDiffers,
  };
}
