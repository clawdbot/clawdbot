/**
 * Runtime SDK subpath for building model-provider command replies.
 */
import {
  buildPreparedModelsProviderData,
  type ModelsProviderData,
} from "../auto-reply/reply/commands-models.js";

export {
  buildPreparedModelsProviderData,
  formatModelsAvailableHeader,
  resolveModelsCommandReply,
} from "../auto-reply/reply/commands-models.js";
export type {
  ModelsProviderData,
  ModelsRuntimeChoice,
} from "../auto-reply/reply/commands-models.js";

// v2026.7.1-2 plugins construct old-shape results and typed builder adapters.
// Keep this signature until an explicitly approved SDK-breaking boundary.
export function buildModelsProviderData(
  ...args: Parameters<typeof buildPreparedModelsProviderData>
): Promise<ModelsProviderData> {
  return buildPreparedModelsProviderData(...args);
}
