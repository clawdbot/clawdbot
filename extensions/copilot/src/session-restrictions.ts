import type { SessionConfig } from "@github/copilot-sdk";

const COPILOT_ISOLATED_EXCLUDED_TOOLS = ["builtin:*", "mcp:*", "custom:*"] as const;

/** Disable every ambient SDK capability for a prompt-only or settled final turn. */
export function createCopilotIsolatedSessionRestrictions(): Partial<SessionConfig> {
  return {
    availableTools: [],
    coauthorEnabled: false,
    customAgents: [],
    customAgentsLocalOnly: true,
    embeddingCacheStorage: "in-memory",
    enableConfigDiscovery: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableOnDemandInstructionDiscovery: false,
    enableSessionStore: false,
    enableSkills: false,
    excludedTools: [...COPILOT_ISOLATED_EXCLUDED_TOOLS],
    includeSubAgentStreamingEvents: false,
    infiniteSessions: { enabled: false },
    instructionDirectories: [],
    manageScheduleEnabled: false,
    mcpOAuthTokenStorage: "in-memory",
    mcpServers: {},
    memory: { enabled: false },
    pluginDirectories: [],
    remoteSession: "off",
    requestCanvasRenderer: false,
    requestExtensions: false,
    skillDirectories: [],
    skipCustomInstructions: true,
    skipEmbeddingRetrieval: true,
    tools: [],
  };
}
