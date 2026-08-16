import type { AnyAgentTool } from "./tools/common.js";

/**
 * Drops tools whose requiredClientCaps the originating gateway client did not
 * declare. Capability availability is a hard fact, not policy: every tool
 * assembly path (core, plugin-only plans) must apply it or gated tools leak
 * onto surfaces that cannot render them.
 */
export function filterToolsByClientCaps(
  tools: AnyAgentTool[],
  declaredClientCaps: string[] | undefined,
): AnyAgentTool[] {
  const clientCaps = new Set(declaredClientCaps ?? []);
  return tools.filter(
    (tool) => !tool.requiredClientCaps?.some((requiredCap) => !clientCaps.has(requiredCap)),
  );
}
