// Applies Tool Search overlays on top of the selected runtime config.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isLocalModelLeanEnabled } from "./local-model-lean.js";
import { resolveAgentRuntimeToolConfig } from "./tool-runtime-config.js";

export function resolveAgentToolSearchRuntimeConfig(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  model?: { toolSearchMode?: "tools" | false };
  completionPrivateMessageOnly?: boolean;
}): OpenClawConfig | undefined {
  // Select before overlay cloning; cloning source config first loses snapshot identity and can
  // reintroduce unresolved SecretRefs into plugin tool factories.
  const runtimeConfig = resolveAgentRuntimeToolConfig(params.config);
  if (params.completionPrivateMessageOnly) {
    return runtimeConfig;
  }
  if (
    !runtimeConfig ||
    runtimeConfig.tools?.toolSearch !== undefined ||
    (params.model?.toolSearchMode !== "tools" &&
      !isLocalModelLeanEnabled({ ...params, config: runtimeConfig }))
  ) {
    return runtimeConfig;
  }
  return {
    ...runtimeConfig,
    tools: {
      ...runtimeConfig.tools,
      toolSearch: { enabled: true, mode: "tools", searchDefaultLimit: 5, maxSearchLimit: 10 },
    },
  };
}
