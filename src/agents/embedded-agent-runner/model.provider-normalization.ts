import type { Model } from "../../llm/types.js";
import { normalizeModelCompat } from "../../plugins/provider-model-compat.js";

export function normalizeResolvedProviderModel(params: { provider: string; model: Model }): Model {
  return normalizeModelCompat(params.model);
}
