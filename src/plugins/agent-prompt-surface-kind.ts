import type { AgentPromptSurfaceKind } from "./types.js";

export function normalizeAgentPromptSurfaceKind(
  surface: AgentPromptSurfaceKind,
): AgentPromptSurfaceKind {
  return surface === "pi_main" ? "openclaw_main" : surface;
}

export function isOpenClawMainPromptSurface(surface: AgentPromptSurfaceKind): boolean {
  return normalizeAgentPromptSurfaceKind(surface) === "openclaw_main";
}
