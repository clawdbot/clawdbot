type OpenClawCodingToolsFactory =
  (typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"];

/** Mutable dependency seam shared by dynamic-tool construction and its behavioral tests. */
export const dynamicToolBuildState: {
  openClawCodingToolsFactory?: OpenClawCodingToolsFactory;
} = {};
