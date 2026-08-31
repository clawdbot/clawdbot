/** Doctor-only detection result for retired MCP OAuth JSON stores. */
export type LegacyMcpOAuthDetection = {
  sourceDir: string;
  sourcePaths: string[];
  hasLegacy: boolean;
};
