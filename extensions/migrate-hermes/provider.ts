import type {
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import { applyHermesPlan } from "./apply.js";
import { buildHermesPlan } from "./plan.js";
import { discoverHermesSource, hasHermesSource } from "./source.js";

export function buildHermesMigrationProvider(
  params: {
    runtime?: MigrationProviderContext["runtime"];
  } = {},
): MigrationProviderPlugin {
  return {
    id: "hermes",
    label: "Hermes",
    description: "Import Hermes config, memories, skills, and supported credentials.",
    async detect(ctx) {
      const source = await discoverHermesSource(ctx.source);
      const found = hasHermesSource(source);
      return {
        found,
        source: source.root,
        label: "Hermes",
        confidence: found ? "high" : "low",
        message: found ? "Hermes state found." : "Hermes state not found.",
      };
    },
    plan: buildHermesPlan,
    async apply(ctx, plan?: MigrationPlan) {
      return await applyHermesPlan({ ctx, plan, runtime: params.runtime });
    },
  };
}
