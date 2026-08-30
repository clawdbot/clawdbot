/** Prepares explicitly raw model operands for model-selection unit fixtures. */
import { normalizeModelRef } from "../../agents/model-ref-shared.js";
import { resolveRuntimeNormalization } from "./model-runtime-normalization.js";
import type { createModelSelectionState } from "./model-selection.js";

type ModelSelectionParams = Parameters<typeof createModelSelectionState>[0];
type PreparedOperand = "preparedDefaultModel" | "preparedInitialModel" | "preparedPrimaryModel";

// Config-default regressions pass their original config producer instead of
// normalizing a static display tuple through this raw-input fixture helper.
export function prepareRawModelSelectionFixture(
  params: Omit<ModelSelectionParams, PreparedOperand> &
    Partial<Pick<ModelSelectionParams, PreparedOperand>>,
): ModelSelectionParams {
  const normalization = resolveRuntimeNormalization(params.cfg, params.agentId, params);
  const prepareRawRef = (provider: string, model: string) => {
    let prepared: ReturnType<typeof normalizeModelRef> | undefined;
    return () => (prepared ??= normalizeModelRef(provider, model, normalization));
  };
  return {
    ...params,
    manifestPluginContext: normalization.manifestPluginContext,
    preparedDefaultModel:
      params.preparedDefaultModel ?? prepareRawRef(params.defaultProvider, params.defaultModel),
    preparedInitialModel:
      params.preparedInitialModel ?? prepareRawRef(params.provider, params.model),
    preparedPrimaryModel:
      params.preparedPrimaryModel ??
      prepareRawRef(
        params.primaryProvider ?? params.defaultProvider,
        params.primaryModel ?? params.defaultModel,
      ),
  };
}
