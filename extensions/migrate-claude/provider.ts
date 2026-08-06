// Migrate Claude provider module implements model/runtime integration.
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
    description: "Import Claude Code auto-memory, instructions, MCP servers, and skills.",
    supportedItemKinds: ["memory"],
    async detect(ctx) {
      const source = await discoverClaudeSource(ctx.source);
      const memoryOnly = ctx.itemKinds?.length === 1 && ctx.itemKinds[0] === "memory";
      const found = memoryOnly ? source.autoMemorySources.length > 0 : hasClaudeSource(source);
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
