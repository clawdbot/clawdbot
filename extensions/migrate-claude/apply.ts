import path from "node:path";
import { summarizeMigrationItems } from "openclaw/plugin-sdk/migration";
import {
  archiveMigrationItem,
  copyMigrationFileItem,
  writeMigrationReport,
} from "openclaw/plugin-sdk/migration-runtime";
import type {
  MigrationApplyResult,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { applyConfigItem, applyManualItem } from "./config.js";
import { appendItem } from "./helpers.js";
import { buildClaudePlan } from "./plan.js";
import { applyGeneratedSkillItem } from "./skills.js";

function withCachedConfigRuntime(
  runtime: MigrationProviderContext["runtime"] | undefined,
  fallbackConfig: MigrationProviderContext["config"],
): MigrationProviderContext["runtime"] | undefined {
  if (!runtime) {
    return undefined;
  }
  const configApi = runtime.config;
  if (!configApi?.current || !configApi.mutateConfigFile) {
    return runtime;
  }
  let cachedConfig: MigrationProviderContext["config"] | undefined;
  const current = (): ReturnType<typeof configApi.current> => {
    cachedConfig ??= structuredClone(
      (configApi.current() ?? fallbackConfig) as MigrationProviderContext["config"],
    );
    return cachedConfig;
  };
  return {
    ...runtime,
    config: {
      ...runtime.config,
      current,
      mutateConfigFile: async (params) => {
        const result = await configApi.mutateConfigFile({
          ...params,
          mutate: async (draft, context) => {
            const mutationResult = await params.mutate(draft, context);
            cachedConfig = structuredClone(draft);
            return mutationResult;
          },
        });
        cachedConfig = structuredClone(result.nextConfig);
        return result;
      },
      ...(configApi.replaceConfigFile
        ? {
            replaceConfigFile: async (params) => {
              const result = await configApi.replaceConfigFile(params);
              cachedConfig = structuredClone(result.nextConfig);
              return result;
            },
          }
        : {}),
    },
  };
}

export async function applyClaudePlan(params: {
  ctx: MigrationProviderContext;
  plan?: MigrationPlan;
  runtime?: MigrationProviderContext["runtime"];
}): Promise<MigrationApplyResult> {
  const plan = params.plan ?? (await buildClaudePlan(params.ctx));
  const reportDir = params.ctx.reportDir ?? path.join(params.ctx.stateDir, "migration", "claude");
  const runtime = withCachedConfigRuntime(params.ctx.runtime ?? params.runtime, params.ctx.config);
  const applyCtx = { ...params.ctx, runtime };
  const items: MigrationItem[] = [];
  for (const item of plan.items) {
    if (item.status !== "planned") {
      items.push(item);
      continue;
    }
    if (item.kind === "config") {
      items.push(await applyConfigItem(applyCtx, item));
    } else if (item.kind === "manual") {
      items.push(applyManualItem(item));
    } else if (item.action === "archive") {
      items.push(await archiveMigrationItem(item, reportDir));
    } else if (item.action === "append") {
      items.push(await appendItem(item));
    } else if (item.action === "create" && item.kind === "skill") {
      items.push(await applyGeneratedSkillItem(item, { overwrite: params.ctx.overwrite }));
    } else {
      items.push(await copyMigrationFileItem(item, reportDir, { overwrite: params.ctx.overwrite }));
    }
  }
  const result: MigrationApplyResult = {
    ...plan,
    items,
    summary: summarizeMigrationItems(items),
    backupPath: params.ctx.backupPath,
    reportDir,
  };
  await writeMigrationReport(result, { title: "Claude Migration Report" });
  return result;
}
