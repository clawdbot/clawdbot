/** Resolves provider/model precedence for isolated cron runs. */
import type { AgentConfig } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../types.js";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  getModelRefStatus,
  loadModelCatalog,
  normalizeModelSelection,
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
type ResolveCronModelSelectionParams = {
  cfg: OpenClawConfig;
  cfgWithAgentDefaults: OpenClawConfig;
  agentConfigOverride?: Pick<AgentConfig, "model" | "subagents">;
  sessionEntry: CronSessionModelOverrides;
  payload: CronJob["payload"];
  isGmailHook: boolean;
  agentId?: string;
};

/** Resolved provider/model pair plus the precedence source that selected it. */
type ResolveCronModelSelectionResult =
  | {
      ok: true;
      provider: string;
      model: string;
      modelSource: CronModelSelectionSource;
    }
  | {
      ok: false;
      error: string;
    };

function formatAllowedModelRefs(params: { cfg: OpenClawConfig }): string {
  const configured = params.cfg.agents?.defaults?.models;
  if (configured && typeof configured === "object" && Object.keys(configured).length > 0) {
    return Object.keys(configured).toSorted().join(", ");
  }
  return "(none configured)";
}

function formatCronPayloadModelRejection(params: {
  cfg: OpenClawConfig;
  modelOverride: string;
  error: string;
}): string {
  const { modelOverride, error } = params;
  if (error.startsWith("model not allowed:")) {
    const modelRef = error.slice("model not allowed:".length).trim();
    return `cron payload.model '${modelOverride}' rejected by agents.defaults.models allowlist: ${modelRef} is not in [${formatAllowedModelRefs({ cfg: params.cfg })}]`;
  }
  return `cron payload.model '${modelOverride}' rejected: ${error}`;
}

/** Resolves the effective model for an isolated cron run across defaults, agents, hooks, payload, and session state. */
export async function resolveCronModelSelection(
  params: ResolveCronModelSelectionParams,
): Promise<ResolveCronModelSelectionResult> {
  const resolvedDefault = resolveConfiguredModelRef({
    cfg: params.cfgWithAgentDefaults,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  let provider = resolvedDefault.provider;
  let model = resolvedDefault.model;
  let modelSource: CronModelSelectionSource = "default";

  let catalog: Awaited<ReturnType<typeof loadModelCatalog>> | undefined;
  const loadCatalogOnce = async () => {
    if (!catalog) {
      catalog = await loadModelCatalog({ config: params.cfgWithAgentDefaults });
    }
    return catalog;
  };

  const subagentModelConfigSelection = resolveSubagentModelConfigSelectionResult({
    cfg: params.cfg,
    agentId: params.agentId,
    agentConfigOverride: params.agentConfigOverride,
  });
  const subagentModelRaw = normalizeModelSelection(subagentModelConfigSelection?.raw);
  const subagentModelSource: CronModelSelectionSource =
    subagentModelConfigSelection?.source === "agent" ? "agent" : "subagent";
  if (subagentModelRaw) {
    // Subagent/agent model config is advisory here: invalid refs fall back to
    // defaults so an agent config typo does not prevent unrelated cron runs.
    const resolvedSubagent = resolveAllowedModelRef({
      cfg: params.cfgWithAgentDefaults,
      catalog: await loadCatalogOnce(),
      raw: subagentModelRaw,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
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
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
      })
    : null;
  if (hooksGmailModelRef) {
    // Gmail hook models are specialized defaults: apply them only when the
    // configured ref is allowed, otherwise keep the broader cron default.
    const status = getModelRefStatus({
      cfg: params.cfg,
      catalog: await loadCatalogOnce(),
      ref: hooksGmailModelRef,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
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
      cfg: params.cfgWithAgentDefaults,
      catalog: await loadCatalogOnce(),
      raw: modelOverride,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if ("error" in resolvedOverride) {
      return {
        ok: false,
        error: formatCronPayloadModelRejection({
          cfg: params.cfgWithAgentDefaults,
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
        cfg: params.cfgWithAgentDefaults,
        catalog: await loadCatalogOnce(),
        raw: `${sessionProviderOverride}/${sessionModelOverride}`,
        defaultProvider: resolvedDefault.provider,
        defaultModel: resolvedDefault.model,
      });
      if (!("error" in resolvedSessionOverride)) {
        provider = resolvedSessionOverride.ref.provider;
        model = resolvedSessionOverride.ref.model;
        modelSource = "session";
      }
    }
  }

  return { ok: true, provider, model, modelSource };
}
