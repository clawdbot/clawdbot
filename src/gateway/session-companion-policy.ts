import type { OpenClawConfig } from "../config/types.openclaw.js";

export const SESSION_COMPANION_TOOLS = ["read", "sessions_history", "sessions_search"] as const;

export function buildSessionCompanionRunConfig(cfg: OpenClawConfig): OpenClawConfig {
  const toolSearch = cfg.tools?.toolSearch;
  const codeMode = cfg.tools?.codeMode;
  return {
    ...cfg,
    tools: {
      ...cfg.tools,
      sessions: { ...cfg.tools?.sessions, visibility: "self" },
      fs: { ...cfg.tools?.fs, workspaceOnly: true },
      toolSearch: { ...(typeof toolSearch === "object" ? toolSearch : {}), enabled: false },
      codeMode: { ...(typeof codeMode === "object" ? codeMode : {}), enabled: false },
    },
  };
}
