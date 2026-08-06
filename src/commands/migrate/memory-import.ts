/** Canonical memory-only migration planning and apply policy for embedded surfaces. */
import { MAX_MEMORY_MIGRATION_ITEMS } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { bindMemoryMigrationPlanSources } from "../../plugin-sdk/memory-migration-source.js";
import { summarizeMigrationItems } from "../../plugin-sdk/migration.js";
import {
  ensureStandaloneMigrationProviderRegistryLoaded,
  resolvePluginMigrationProviders,
} from "../../plugins/migration-provider-runtime.js";
import type {
  MigrationApplyResult,
  MigrationDetection,
  MigrationPlan,
  MigrationProviderPlugin,
} from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { runMigrationApply } from "./apply.js";
import { buildMigrationContext } from "./context.js";

const MEMORY_ITEM_KIND = "memory";
const silentRuntime: RuntimeEnv = {
  log() {},
  error() {},
  exit(code) {
    throw new Error(`migration exited with ${code}`);
  },
};

export function listMemoryMigrationProviders(config: OpenClawConfig): MigrationProviderPlugin[] {
  ensureStandaloneMigrationProviderRegistryLoaded({ cfg: config });
  return resolvePluginMigrationProviders({ cfg: config }).filter((provider) =>
    provider.supportedItemKinds?.includes(MEMORY_ITEM_KIND),
  );
}

function shapeMemoryOnlyPlan(plan: MigrationPlan): MigrationPlan {
  const items = plan.items.filter((item) => item.kind === MEMORY_ITEM_KIND);
  if (items.length > MAX_MEMORY_MIGRATION_ITEMS) {
    throw new Error(
      `memory import found ${items.length} items; the maximum is ${MAX_MEMORY_MIGRATION_ITEMS}. Narrow or split the source memory before importing.`,
    );
  }
  // Selection is id-based; duplicates would make one reviewed id execute multiple items.
  const itemIds = new Set<string>();
  for (const item of items) {
    if (itemIds.has(item.id)) {
      throw new Error(`duplicate memory migration item id "${item.id}"`);
    }
    itemIds.add(item.id);
  }
  const unsupported = items.find(
    (item) => (item.status === "planned" || item.status === "conflict") && item.action !== "copy",
  );
  if (unsupported) {
    throw new Error(
      `memory import only supports copy actions; ${unsupported.id} uses ${unsupported.action}`,
    );
  }
  return { ...plan, items, summary: summarizeMigrationItems(items) };
}

export async function planProviderMemoryImport(params: {
  provider: MigrationProviderPlugin;
  config: OpenClawConfig;
  agentId: string;
  overwrite?: boolean;
  runtime?: RuntimeEnv;
}): Promise<{ detection: MigrationDetection | undefined; plan: MigrationPlan }> {
  const ctx = buildMigrationContext({
    runtime: params.runtime ?? silentRuntime,
    configOverride: params.config,
    targetAgentId: params.agentId,
    itemKinds: [MEMORY_ITEM_KIND],
    overwrite: params.overwrite,
    json: true,
  });
  const detection = await params.provider.detect?.(ctx);
  if (detection && !detection.found) {
    // Providers may reject planning an absent source; a negative detection is
    // already the canonical "nothing to import" answer.
    return {
      detection,
      plan: {
        providerId: params.provider.id,
        source: detection.source ?? "",
        summary: summarizeMigrationItems([]),
        items: [],
      },
    };
  }
  const plan = await bindMemoryMigrationPlanSources(
    shapeMemoryOnlyPlan(await params.provider.plan(ctx)),
    { includeConflicts: params.overwrite === true },
  );
  return { detection, plan };
}

export async function applyProviderMemoryImport(params: {
  provider: MigrationProviderPlugin;
  config: OpenClawConfig;
  agentId: string;
  itemIds: string[];
  overwrite?: boolean;
  preflightPlan: MigrationPlan;
  runtime?: RuntimeEnv;
}): Promise<MigrationApplyResult> {
  return await runMigrationApply({
    // Default silent: embedded surfaces (wizard, gateway) render their own
    // summaries; the apply writer would dump raw JSON into their output.
    runtime: params.runtime ?? silentRuntime,
    providerId: params.provider.id,
    provider: params.provider,
    opts: {
      yes: true,
      json: true,
      configOverride: params.config,
      targetAgentId: params.agentId,
      itemKinds: [MEMORY_ITEM_KIND],
      itemIds: params.itemIds,
      overwrite: params.overwrite,
      preflightPlan: params.preflightPlan,
      allowPartialResult: true,
    },
  });
}
