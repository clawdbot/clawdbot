import { normalizeToolName } from "../tool-policy.js";

/** CLI backends cannot enforce runtime caps; keep only real restrictions. */
export function resolveCliRuntimeToolsAllow(
  toolsAllow?: string[],
  toolsAllowIsDefault?: boolean,
): string[] | undefined {
  if (toolsAllow === undefined || toolsAllowIsDefault) {
    return undefined;
  }
  return toolsAllow.some((toolName) => normalizeToolName(toolName) === "*")
    ? undefined
    : toolsAllow;
}
