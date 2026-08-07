type OpenClawCodingToolsFactory =
  (typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"];
export type AgentHarnessCodingToolsFactory =
  (typeof import("openclaw/plugin-sdk/agent-harness-tool-authority-runtime"))["createOpenClawCodingToolsForAgentHarness"];

/** Mutable dependency seam shared by dynamic-tool construction and its behavioral tests. */
export const dynamicToolBuildState: {
  openClawCodingToolsFactory?: OpenClawCodingToolsFactory;
  agentHarnessCodingToolsFactory?: AgentHarnessCodingToolsFactory;
} = {};
