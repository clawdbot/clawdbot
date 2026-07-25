import { resolveConfiguredModelPolicyAllow } from "../../agents/model-selection-shared.js";
/** Resolves provider/model precedence for isolated cron runs. */
import type { AgentConfig } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { CronJob } from "../types.js";
import { buildCronAgentDefaultsConfig } from "./run-config.js";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  getModelRefStatus,
  loadPreparedModelCatalogOwnerSnapshot,
  normalizeModelSelection,
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveAllowedModelRef,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
  resolveSubagentModelConfigSelectionResult,
} from "./run-model-selection.runtime.js";

type CronSessionModelOverrides = {
  modelOverride?: string;
  providerOverride?: string;
};

type CronModelSelectionSource = "default" | "subagent" | "agent" | "hook" | "payload" | "session";

/** Inputs used to resolve the model for one isolated cron run. */
type CronModelSelectionOwner = {
  config: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  catalog: Awaited<
    ReturnType<typeof loadPreparedModelCatalogOwnerSnapshot>
  >["modelCatalog"]["entries"];
};

type ResolveCronModelSelectionParams = {
  cfg: OpenClawConfig;
  owner?: CronModelSelectionOwner;
  agentConfigOverride?: Pick<AgentConfig, "model" | "subagents">;
  sessionEntry: CronSessionModelOverrides;
  payload: CronJob["payload"];
  isGmailHook: boolean;
  agentId?: string;
  agentDir: string;
  workspaceDir: string;
};

/** Resolved provider/model pair plus the precedence source that selected it. */
type ResolveCronModelSelectionResult =
  | {
      ok: true;
      provider: string;
      model: string;
      modelSource: CronModelSelectionSource;
      cfgWithAgentDefaults: OpenClawConfig;
      owner: CronModelSelectionOwner;
    }
  | {
      ok: false;
      error: string;
    };

function formatAllowedModelRefs(params: { cfg: OpenClawConfig; agentId?: string }): string {
  const configured = resolveConfiguredModelPolicyAllow(params).refs;
  if (configured && configured.length > 0) {
    return configured.toSorted().join(", ");
  }
  return "(none configured)";
}

function formatCronPayloadModelRejection(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  modelOverride: string;
  error: string;
}): string {
  const { modelOverride, error } = params;
  if (error.startsWith("model not allowed:")) {
    const modelRef = error.slice("model not allowed:".length).trim();
    const policy = resolveConfiguredModelPolicyAllow(params);
    const policyPath = policy.configPath ?? "agents.defaults.modelPolicy.allow";
    return `cron payload.model '${modelOverride}' rejected by ${policyPath}: ${modelRef} is not in [${formatAllowedModelRefs(params)}]`;
  }
  return `cron payload.model '${modelOverride}' rejected: ${error}`;
}

export async function resolveCronModelSelectionOwner(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  requiredAgentId?: string;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<CronModelSelectionOwner> {
  const owner = await loadPreparedModelCatalogOwnerSnapshot({
    config: params.cfg,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    readOnly: true,
  });
  if (!owner.agentId) {
    throw new Error(`cron model catalog owner did not identify an agent (${owner.agentDir})`);
  }
  if (
    params.requiredAgentId &&
    normalizeAgentId(owner.agentId) !== normalizeAgentId(params.requiredAgentId)
  ) {
    throw new Error(
      `cron model catalog owner changed from ${normalizeAgentId(params.requiredAgentId)} to ${normalizeAgentId(owner.agentId)}`,
    );
  }
  return {
    config: owner.config,
    agentId: owner.agentId,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir ?? resolveAgentWorkspaceDir(owner.config, owner.agentId),
    catalog: owner.modelCatalog.entries,
  };
}

/** Resolves the effective model for an isolated cron run across defaults, agents, hooks, payload, and session state. */
export async function resolveCronModelSelection(
  params: ResolveCronModelSelectionParams,
): Promise<ResolveCronModelSelectionResult> {
  const owner =
    params.owner ??
    (await resolveCronModelSelectionOwner({
      cfg: params.cfg,
      ...(params.agentId
        ? {
            agentId: params.agentId,
            requiredAgentId: params.agentId,
            agentDir: params.agentDir,
            workspaceDir: params.workspaceDir,
          }
        : {}),
    }));
  const ownerAgentId = owner.agentId;
  const ownerAgentConfigOverride = params.agentConfigOverride
    ? owner.config === params.cfg && (!params.agentId || ownerAgentId === params.agentId)
      ? params.agentConfigOverride
      : resolveAgentConfig(owner.config, ownerAgentId)
    : undefined;
  const ownerAgentDefaults = buildCronAgentDefaultsConfig({
    defaults: owner.config.agents?.defaults,
    agentConfigOverride: ownerAgentConfigOverride,
  });
  const cfgWithAgentDefaults: OpenClawConfig = {
    ...owner.config,
    agents: Object.assign({}, owner.config.agents, { defaults: ownerAgentDefaults }),
  };
  const catalog = owner.catalog;
  const resolvedDefault = resolveConfiguredModelRef({
    cfg: cfgWithAgentDefaults,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  let provider = resolvedDefault.provider;
  let model = resolvedDefault.model;
  let modelSource: CronModelSelectionSource = "default";

  const subagentModelConfigSelection = resolveSubagentModelConfigSelectionResult({
    cfg: owner.config,
    agentId: ownerAgentId,
    agentConfigOverride: ownerAgentConfigOverride,
  });
  const subagentModelRaw = normalizeModelSelection(subagentModelConfigSelection?.raw);
  const subagentModelSource: CronModelSelectionSource =
    subagentModelConfigSelection?.source === "agent" ? "agent" : "subagent";
  if (subagentModelRaw) {
    // Subagent/agent model config is advisory here: invalid refs fall back to
    // defaults so an agent config typo does not prevent unrelated cron runs.
    const resolvedSubagent = resolveAllowedModelRef({
      cfg: owner.config,
      catalog,
      raw: subagentModelRaw,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
      agentId: ownerAgentId,
    });
    if (!("error" in resolvedSubagent)) {
      provider = resolvedSubagent.ref.provider;
      model = resolvedSubagent.ref.model;
      modelSource = subagentModelSource;
    }
  }

  let hooksGmailModelApplied = false;
  const hooksGmailModelRef = params.isGmailHook
    ? resolveHooksGmailModel({
        cfg: owner.config,
        defaultProvider: DEFAULT_PROVIDER,
      })
    : null;
  if (hooksGmailModelRef) {
    // Gmail hook models are specialized defaults: apply them only when the
    // configured ref is allowed, otherwise keep the broader cron default.
    const status = getModelRefStatus({
      cfg: owner.config,
      catalog,
      ref: hooksGmailModelRef,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
      agentId: ownerAgentId,
    });
    if (status.allowed) {
      provider = hooksGmailModelRef.provider;
      model = hooksGmailModelRef.model;
      hooksGmailModelApplied = true;
      modelSource = "hook";
    }
  }

  const modelOverrideRaw = params.payload.kind === "agentTurn" ? params.payload.model : undefined;
  const modelOverride = typeof modelOverrideRaw === "string" ? modelOverrideRaw.trim() : undefined;
  if (modelOverride !== undefined && modelOverride.length > 0) {
    // Payload model overrides are explicit cron config, so reject disallowed
    // refs instead of silently falling back to defaults.
    const resolvedOverride = resolveAllowedModelRef({
      cfg: owner.config,
      catalog,
      raw: modelOverride,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
      agentId: ownerAgentId,
    });
    if ("error" in resolvedOverride) {
      return {
        ok: false,
        error: formatCronPayloadModelRejection({
          cfg: owner.config,
          agentId: ownerAgentId,
          modelOverride,
          error: resolvedOverride.error,
        }),
      };
    }
    provider = resolvedOverride.ref.provider;
    model = resolvedOverride.ref.model;
    modelSource = "payload";
  }

  if (!modelOverride && !hooksGmailModelApplied) {
    const sessionModelOverride = params.sessionEntry.modelOverride?.trim();
    if (sessionModelOverride) {
      // Stored session overrides are lowest precedence so explicit cron payload
      // and hook-specific models can intentionally move a run away from history.
      const sessionProviderOverride =
        params.sessionEntry.providerOverride?.trim() || resolvedDefault.provider;
      const resolvedSessionOverride = resolveAllowedModelRef({
        cfg: owner.config,
        catalog,
        raw: `${sessionProviderOverride}/${sessionModelOverride}`,
        defaultProvider: resolvedDefault.provider,
        defaultModel: resolvedDefault.model,
        agentId: ownerAgentId,
      });
      if (!("error" in resolvedSessionOverride)) {
        provider = resolvedSessionOverride.ref.provider;
        model = resolvedSessionOverride.ref.model;
        modelSource = "session";
      }
    }
  }

  return {
    ok: true,
    provider,
    model,
    modelSource,
    cfgWithAgentDefaults,
    owner,
  };
}
