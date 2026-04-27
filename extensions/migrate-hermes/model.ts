import {
  resolveAgentEffectiveModelPrimary,
  resolveDefaultAgentId,
  setAgentEffectiveModelPrimary,
} from "openclaw/plugin-sdk/agent-runtime";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { readString } from "./helpers.js";
import {
  HERMES_REASON_ALREADY_CONFIGURED,
  HERMES_REASON_CONFIG_RUNTIME_UNAVAILABLE,
  HERMES_REASON_DEFAULT_MODEL_CONFIGURED,
  hermesItemConflict,
  hermesItemError,
  hermesItemSkipped,
  readHermesModelDetails,
} from "./items.js";

export function resolveHermesModelRef(config: Record<string, unknown>): string | undefined {
  const model = config.model;
  if (typeof model === "string" && model.trim()) {
    const rawModel = model.trim();
    const provider = readString(config.provider);
    if (provider && !rawModel.includes("/")) {
      return `${provider}/${rawModel}`;
    }
    return rawModel;
  }
  if (model && typeof model === "object" && !Array.isArray(model)) {
    const modelRecord = model as Record<string, unknown>;
    const rawModel = readString(modelRecord.default) ?? readString(modelRecord.model);
    const provider = readString(modelRecord.provider);
    if (rawModel && provider && !rawModel.includes("/")) {
      return `${provider}/${rawModel}`;
    }
    return rawModel;
  }
  const rootModel = readString(config.default_model) ?? readString(config.model_name);
  const rootProvider = readString(config.provider);
  if (rootModel && rootProvider && !rootModel.includes("/")) {
    return `${rootProvider}/${rootModel}`;
  }
  return rootModel;
}

function resolveDefaultAgentModelState(config: MigrationProviderContext["config"]): {
  agentId: string;
  effectivePrimary?: string;
} {
  const agentId = resolveDefaultAgentId(config);
  const effectivePrimary = resolveAgentEffectiveModelPrimary(config, agentId);
  return {
    agentId,
    effectivePrimary,
  };
}

export function resolveCurrentModelRef(ctx: MigrationProviderContext): string | undefined {
  return resolveDefaultAgentModelState(ctx.config).effectivePrimary;
}

export async function applyModelItem(
  ctx: MigrationProviderContext,
  item: MigrationItem,
): Promise<MigrationItem> {
  const details = readHermesModelDetails(item);
  if (!details || item.status !== "planned") {
    return item;
  }
  try {
    if (!ctx.runtime?.config.writeConfigFile) {
      return hermesItemError(item, HERMES_REASON_CONFIG_RUNTIME_UNAVAILABLE);
    }
    const nextConfig = structuredClone(ctx.runtime?.config.loadConfig?.() ?? ctx.config);
    const currentState = resolveDefaultAgentModelState(nextConfig);
    if (currentState.effectivePrimary === details.model) {
      return hermesItemSkipped(item, HERMES_REASON_ALREADY_CONFIGURED);
    }
    if (currentState.effectivePrimary && !ctx.overwrite) {
      return hermesItemConflict(item, HERMES_REASON_DEFAULT_MODEL_CONFIGURED);
    }
    setAgentEffectiveModelPrimary(nextConfig, currentState.agentId, details.model);
    await ctx.runtime.config.writeConfigFile(nextConfig);
    return { ...item, status: "migrated" };
  } catch (err) {
    return hermesItemError(item, err instanceof Error ? err.message : String(err));
  }
}
