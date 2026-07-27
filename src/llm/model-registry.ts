// Registers and resolves available LLM models for provider routing.
import type { Model } from "./types.js";

/** Registry abstraction used by model pickers and provider availability checks. */
export type ModelRegistry = {
  getAll(): Model[];
  getAvailable(): Model[];
  find(provider: string, modelId: string): Model | undefined;
  hasConfiguredAuth(model: Model): boolean;
};
