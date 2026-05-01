import type { MigrationPlan, MigrationProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { applyCodexMigrationPlan } from "./apply.js";
import { buildCodexMigrationPlan } from "./plan.js";
import { discoverCodexSource, hasCodexSource } from "./source.js";

export function buildCodexMigrationProvider(): MigrationProviderPlugin {
  return {
    id: "codex",
    label: "Codex",
    description:
      "Inventory and promote Codex CLI skills while keeping Codex native plugins and hooks explicit.",
    async detect(ctx) {
      const source = await discoverCodexSource(ctx.source);
      const found = hasCodexSource(source);
      return {
        found,
        source: source.root,
        label: "Codex",
        confidence: found ? source.confidence : "low",
        message: found ? "Codex state found." : "Codex state not found.",
      };
    },
    plan: buildCodexMigrationPlan,
    async apply(ctx, plan?: MigrationPlan) {
      return await applyCodexMigrationPlan({ ctx, plan });
    },
  };
}
