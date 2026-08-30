/**
 * Normalizes resolved provider/model ids on model records.
 */
import type { Model } from "../../llm/types.js";
import { normalizeModelCompat } from "../../plugins/provider-model-compat.js";

/**
 * Applies provider compatibility normalization to a resolved model record.
 */
export function normalizeResolvedProviderModel(params: { provider: string; model: Model }): Model {
  return normalizeModelCompat(params.model);
}
