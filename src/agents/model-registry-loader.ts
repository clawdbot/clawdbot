/** Lifecycle-backed model-registry view for command paths. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadPreparedAgentModelRegistry,
  type LoadPreparedAgentModelRegistryOptions,
} from "./prepared-model-registry.js";
import type { ModelRegistry } from "./sessions/index.js";

/** Options controlling the prepared registry view. */
type LoadAgentModelRegistryOptions = LoadPreparedAgentModelRegistryOptions & {
  readOnly?: boolean;
};

/** Forks a registry from the generation prepared by the owning command lifecycle. */
export async function loadAgentModelRegistry(
  config: OpenClawConfig,
  options: LoadAgentModelRegistryOptions = {},
): Promise<{ agentDir: string; config: OpenClawConfig; registry: ModelRegistry }> {
  return await loadPreparedAgentModelRegistry(config, options);
}
