import { vi } from "vitest";

export {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
} from "../../../agents/agent-scope.js";
export { getRegisteredAgentHarness } from "../../../agents/harness/registry.js";
export { resolveReplyToMode } from "../../../auto-reply/reply/reply-threading.js";
export { resolveRuntimeConfigCacheKey } from "../../../config/config.js";
export { deliveryContextFromSession } from "../../../utils/delivery-context.shared.js";
export { loadSessionEntryReadOnly, resolveSessionModelRef } from "../../session-utils.js";

export const toolsEffectiveGlobalAgentRuntimeMocks = {
  resolveEffectiveToolInventory: vi.fn(
    (params: { agentId: string; modelProvider?: string; modelId?: string }) => ({
      agentId: params.agentId,
      profile: "coding",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            {
              id: "exec",
              label: "Exec",
              description: "Run shell commands",
              source: "core",
            },
          ],
        },
      ],
      modelProvider: params.modelProvider,
      modelId: params.modelId,
    }),
  ),
  resolveEffectiveToolInventoryRuntimeModelContext: vi.fn((_params?: unknown) => ({
    modelApi: "openai-responses",
    runtimeModel: {
      id: "work-model",
      name: "Work model",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    },
  })),
  resolveEffectiveToolInventoryRuntimeModelContextAsync: vi.fn(async (params: unknown) =>
    toolsEffectiveGlobalAgentRuntimeMocks.resolveEffectiveToolInventoryRuntimeModelContext(params),
  ),
};

export const toolsEffectiveRuntimeMockModule = {
  resolveEffectiveToolInventory:
    toolsEffectiveGlobalAgentRuntimeMocks.resolveEffectiveToolInventory,
  resolveEffectiveToolInventoryRuntimeModelContextAsync:
    toolsEffectiveGlobalAgentRuntimeMocks.resolveEffectiveToolInventoryRuntimeModelContextAsync,
  resolveSessionMcpConfigSummary: vi.fn(() => ({
    fingerprint: "mcp:0",
    serverNames: [] as string[],
  })),
  buildBundleMcpToolsFromCatalog: vi.fn(() => []),
  applyFinalEffectiveToolPolicy: vi.fn(
    (params: { bundledTools: unknown[] }) => params.bundledTools,
  ),
  getActivePluginRegistryVersion: vi.fn(() => 1),
  getActivePluginChannelRegistryVersion: vi.fn(() => 1),
  peekSessionMcpRuntime: vi.fn(() => undefined),
};
