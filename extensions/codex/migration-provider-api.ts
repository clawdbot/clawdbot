// Lightweight Codex migration provider surface for control-plane callers.
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

function isAuthOnlyMigration(ctx: MigrationProviderContext): boolean {
  return Boolean(
    ctx.itemKinds && ctx.itemKinds.length > 0 && ctx.itemKinds.every((kind) => kind === "auth"),
  );
}

export function buildMigrationProvider(
  params: { runtime?: MigrationProviderContext["runtime"] } = {},
): MigrationProviderPlugin {
  return {
    id: "codex",
    label: "Codex",
    description:
      "Import Codex memory and skills while keeping Codex native plugins and hooks explicit.",
    supportedItemKinds: ["memory", "auth"],
    async detect(ctx) {
      const { discoverCodexSource, hasCodexSource } = await import("./src/migration/source.js");
      const memoryOnly = isMemoryOnlyMigration(ctx);
      const authOnly = isAuthOnlyMigration(ctx);
      const source = await discoverCodexSource({
        input: ctx.source,
        memoryOnly,
        authOnly,
      });
      const found = memoryOnly
        ? source.memoryFiles.length > 0
        : authOnly
          ? Boolean(source.authPath)
          : hasCodexSource(source);
      return {
        found,
        source: source.root,
        label: "Codex",
        confidence: found ? source.confidence : "low",
        message: found ? "Codex state found." : "Codex state not found.",
      };
    },
    async plan(ctx) {
      const { buildCodexMigrationPlan } = await import("./src/migration/plan.js");
      return await buildCodexMigrationPlan(ctx);
    },
    deferredApply: { retrySafe: true },
    prepareApply(ctx) {
      if (isMemoryOnlyMigration(ctx) || isAuthOnlyMigration(ctx)) {
        return undefined;
      }
      return import("./src/migration/apply.js").then(({ prepareTargetCodexAppServer }) =>
        prepareTargetCodexAppServer(ctx),
      );
    },
    async apply(ctx, plan?: MigrationPlan) {
      const { applyCodexMigrationPlan } = await import("./src/migration/apply.js");
      return await applyCodexMigrationPlan({ ctx, plan, runtime: params.runtime });
    },
  };
}
