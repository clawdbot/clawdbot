import type {
  buildBundleMcpToolsFromCatalog,
  peekSessionMcpRuntime,
  resolveSessionMcpConfigSummary,
} from "../../agents/agent-bundle-mcp-tools.js";
import type {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import type { applyFinalEffectiveToolPolicy } from "../../agents/embedded-agent-runner/effective-tool-policy.js";
import type { getRegisteredAgentHarness } from "../../agents/harness/registry.js";
import type {
  resolveEffectiveToolInventory,
  resolveEffectiveToolInventoryRuntimeModelContextAsync,
} from "../../agents/tools-effective-inventory.js";
import type { resolveReplyToMode } from "../../auto-reply/reply/reply-threading.js";
import type { resolveRuntimeConfigCacheKey } from "../../config/config.js";
import type { SessionToolOverrides } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  getActivePluginChannelRegistryVersion,
  getActivePluginRegistryVersion,
} from "../../plugins/runtime.js";
import type { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import type { getConnectedNodePluginToolsVersion } from "../node-plugin-tool-snapshot.js";
import type { loadGatewaySessionEntryReadOnly, resolveSessionModelRef } from "../session-utils.js";

type SessionMcpRuntimeView = Pick<
  NonNullable<ReturnType<typeof peekSessionMcpRuntime>>,
  "configFingerprint" | "peekCatalog" | "workspaceDir"
>;

export type ToolsEffectiveDependencies = {
  applyFinalEffectiveToolPolicy: typeof applyFinalEffectiveToolPolicy;
  buildBundleMcpToolsFromCatalog: typeof buildBundleMcpToolsFromCatalog;
  deliveryContextFromSession: typeof deliveryContextFromSession;
  getActivePluginChannelRegistryVersion: typeof getActivePluginChannelRegistryVersion;
  getActivePluginRegistryVersion: typeof getActivePluginRegistryVersion;
  getConnectedNodePluginToolsVersion: typeof getConnectedNodePluginToolsVersion;
  getRegisteredAgentHarness: typeof getRegisteredAgentHarness;
  listAgentIds: (cfg: OpenClawConfig) => string[];
  loadGatewaySessionEntryReadOnly: typeof loadGatewaySessionEntryReadOnly;
  peekSessionMcpRuntime: (
    params: Parameters<typeof peekSessionMcpRuntime>[0],
  ) => SessionMcpRuntimeView | undefined;
  resolveAgentDir: typeof resolveAgentDir;
  resolveAgentWorkspaceDir: typeof resolveAgentWorkspaceDir;
  resolveEffectiveToolInventory: typeof resolveEffectiveToolInventory;
  resolveEffectiveToolInventoryRuntimeModelContextAsync: typeof resolveEffectiveToolInventoryRuntimeModelContextAsync;
  resolveReplyToMode: typeof resolveReplyToMode;
  resolveRuntimeConfigCacheKey: typeof resolveRuntimeConfigCacheKey;
  resolveSessionAgentId: typeof resolveSessionAgentId;
  resolveSessionMcpConfigSummary: typeof resolveSessionMcpConfigSummary;
  resolveSessionModelRef: typeof resolveSessionModelRef;
};

export type TrustedToolsEffectiveContext = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  workspaceDir: string;
  runtimeConfigCacheKey: string;
  pluginRegistryVersion: number;
  channelRegistryVersion: number;
  nodePluginToolsVersion: number;
  modelProvider?: string;
  modelId?: string;
  messageProvider?: string;
  accountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  replyToMode?: "off" | "first" | "all" | "batched";
  spawnedBy?: string | null;
  agentHarnessId?: string;
  toolOverrides?: SessionToolOverrides;
};
