import type {
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import { applyClaudePlan } from "./apply.js";
import { buildClaudePlan } from "./plan.js";
import { discoverClaudeSource, hasClaudeSource } from "./source.js";

export function buildClaudeMigrationProvider(
  params: {
    runtime?: MigrationProviderContext["runtime"];
  } = {},
): MigrationProviderPlugin {
  return {
    id: "claude",
    label: "Claude",
    description: "Import Claude Code and Claude Desktop instructions, MCP servers, and skills.",
    async detect(ctx) {
      const source = await discoverClaudeSource(ctx.source);
      const found = hasClaudeSource(source);
      return {
        found,
        source: source.root,
        label: "Claude",
        confidence: found ? source.confidence : "low",
        message: found ? "Claude state found." : "Claude state not found.",
      };
    },
    plan: buildClaudePlan,
    async apply(ctx, plan?: MigrationPlan) {
      return await applyClaudePlan({ ctx, plan, runtime: params.runtime });
    },
  };
}
