import { resolveBootstrapMaxChars } from "../agents/embedded-agent-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export function describeToolsMdMergedBootstrapLimit(params: {
  cfg: OpenClawConfig;
  agentId: string;
  mergedChars: number;
}): string | undefined {
  const bootstrapMaxChars = resolveBootstrapMaxChars(params.cfg, params.agentId);
  if (params.mergedChars <= bootstrapMaxChars) {
    return undefined;
  }
  return `Agent "${params.agentId}" TOOLS.md migration will produce a ${params.mergedChars}-character AGENTS.md, exceeding its configured bootstrapMaxChars limit of ${bootstrapMaxChars}. Raise \`agents.entries.*.bootstrapMaxChars\` for this agent, or \`agents.defaults.bootstrapMaxChars\` as fallback, to preserve all migrated instructions.`;
}
