// Codex provider module implements model/runtime integration.
import type {
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";

function isMemoryOnlyMigration(ctx: MigrationProviderContext): boolean {
  return Boolean(
    ctx.itemKinds && ctx.itemKinds.length > 0 && ctx.itemKinds.every((kind) => kind === "memory"),
  );
}

export function buildCodexMigrationProvider(
  params: {
    runtime?: MigrationProviderContext["runtime"];
  } = {},
): MigrationProviderPlugin {
  return {
    id: "codex",
    label: "Codex",
    description:
      "Import Codex memory and skills while keeping Codex native plugins and hooks explicit.",
    supportedItemKinds: ["memory"],
    async detect(ctx) {
      const { discoverCodexSource, hasCodexSource } = await import("./source.js");
      const source = await discoverCodexSource({
        input: ctx.source,
        memoryOnly: isMemoryOnlyMigration(ctx),
      });
      const memoryOnly = isMemoryOnlyMigration(ctx);
      const found = memoryOnly ? source.memoryFiles.length > 0 : hasCodexSource(source);
      return {
        found,
        source: source.root,
        label: "Codex",
        confidence: found ? source.confidence : "low",
        message: found ? "Codex state found." : "Codex state not found.",
      };
    },
    async plan(ctx) {
      const { buildCodexMigrationPlan } = await import("./plan.js");
      return buildCodexMigrationPlan(ctx);
    },
    deferredApply: { retrySafe: true },
    prepareApply(ctx) {
      if (isMemoryOnlyMigration(ctx)) {
        return undefined;
      }
      return import("./apply.js").then(({ prepareTargetCodexAppServer }) =>
        prepareTargetCodexAppServer(ctx),
      );
    },
    async apply(ctx, plan?: MigrationPlan) {
      const { applyCodexMigrationPlan } = await import("./apply.js");
      return await applyCodexMigrationPlan({ ctx, plan, runtime: params.runtime });
    },
  };
}
