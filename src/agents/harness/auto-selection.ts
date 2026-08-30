import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { AgentHarness, AgentHarnessSupport } from "./types.js";

/** Returns a prepared negative auto-selection fact, or undefined when full support needs probing. */
export function resolveAgentHarnessAutoSelectionHint(params: {
  harness: AgentHarness;
  provider: string;
}): AgentHarnessSupport | undefined {
  const providerIds = params.harness.autoSelection?.providerIds;
  if (providerIds === undefined) {
    return undefined;
  }
  const provider = normalizeProviderId(params.provider);
  if (providerIds.some((id) => normalizeProviderId(id) === provider)) {
    return undefined;
  }
  return {
    supported: false,
    reason:
      providerIds.length === 0 ? "harness is explicit-only" : "provider is not auto-selectable",
  };
}
