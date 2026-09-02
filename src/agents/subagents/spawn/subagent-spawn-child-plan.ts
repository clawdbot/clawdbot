import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { inheritSessionCreationPolicy } from "../../../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import { resolveUserPath } from "../../../utils.js";
import { resolveAgentDir } from "../../agent-scope-config.js";
import { findModelCatalogEntry } from "../../model-catalog-lookup.js";
import type { ModelCatalogEntry } from "../../model-catalog.types.js";
import {
  findNormalizedProviderValue,
  resolveAllowedModelRef,
  resolveDefaultModelForAgent,
} from "../../model-selection.js";
import { supportsModelTools } from "../../model-tool-support.js";
import { summarizeSpawnError } from "../../spawn-pipeline.js";
import { resolveSpawnSandboxError, mintSpawnSessionKey } from "../../spawn-plan.js";
import { resolveRequesterOriginForChild } from "../../spawn-requester-origin.js";
import {
  mapToolContextToSpawnedRunMetadata,
  resolveSpawnedWorkspaceInheritance,
} from "../../spawned-context.js";
import type { SubagentLaunchAuthorization } from "./subagent-launch-authorization.js";
import type {
  SpawnSubagentContext,
  SpawnSubagentParams,
  SpawnSubagentResult,
} from "./subagent-spawn-contract.js";
import { getSubagentSpawnDeps } from "./subagent-spawn-deps.js";
import { resolveSubagentModelAndThinkingPlan, splitModelRef } from "./subagent-spawn-plan.js";
import {
  readRequesterFastMode,
  readRequesterThinkingLevel,
} from "./subagent-spawn-requester-prefs.js";
import {
  normalizeDeliveryContext,
  resolveAgentConfig,
  resolveSandboxRuntimeStatus,
} from "./subagent-spawn.runtime.js";

function buildResolvedSubagentModelMetadata(resolvedModel?: string): {
  resolvedModel?: string;
  resolvedProvider?: string;
} {
  const modelRef = resolvedModel?.trim();
  if (!modelRef) {
    return {};
  }
  const { provider } = splitModelRef(modelRef);
  return {
    resolvedModel: modelRef,
    ...(provider ? { resolvedProvider: provider } : {}),
  };
}

async function resolveSpawnModelError(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  targetAgentDir: string;
  workspaceDir?: string;
  request: SpawnSubagentParams;
  resolvedModel?: string;
}): Promise<string | undefined> {
  const { cfg, targetAgentId } = params;
  const requestedModel = normalizeOptionalString(params.request.model);
  if (!requestedModel && !params.request.outputSchema) {
    return undefined;
  }
  const defaults = resolveDefaultModelForAgent({ cfg, agentId: targetAgentId });
  const selected = splitModelRef(params.resolvedModel);
  const provider = selected.provider ?? defaults.provider;
  let catalog: ModelCatalogEntry[];
  try {
    catalog = await getSubagentSpawnDeps().loadPreparedModelCatalog({
      config: params.cfg,
      agentDir: params.targetAgentDir,
      workspaceDir: params.workspaceDir,
      readOnly: true,
      providerDiscoveryProviderIds: [provider],
      scopedLiveProviderDiscovery: true,
    });
  } catch (error) {
    return `sessions_spawn could not verify ${requestedModel ? "the requested model" : "outputSchema model capabilities"}: ${summarizeSpawnError(error)}`;
  }

  if (!requestedModel) {
    const model = selected.model ?? defaults.model;
    const entry = model && findModelCatalogEntry(catalog, { provider, modelId: model });
    return entry && !supportsModelTools(entry)
      ? `sessions_spawn outputSchema requires a tool-capable target model; "${provider}/${model}" declares compat.supportsTools=false.`
      : undefined;
  }
  const selection = {
    cfg,
    catalog,
    defaultProvider: defaults.provider,
    defaultModel: defaults.model,
    agentId: targetAgentId,
  };
  const resolved = resolveAllowedModelRef({
    ...selection,
    raw: requestedModel,
  });
  if ("error" in resolved) {
    return `sessions_spawn model "${requestedModel}" is not usable: ${resolved.error}`;
  }

  const entry = findModelCatalogEntry(catalog, {
    provider: resolved.ref.provider,
    modelId: resolved.ref.model,
  });
  if (!entry) {
    const resolvedProvider = resolved.ref.provider;
    const knownProvider =
      findNormalizedProviderValue(cfg.models?.providers, resolvedProvider) ||
      catalog.some((catalogEntry) => catalogEntry.provider === resolvedProvider) ||
      getSubagentSpawnDeps().resolveProviderRefOwnership({
        provider: resolvedProvider,
        config: cfg,
        workspaceDir: params.workspaceDir,
      }).status === "owned";
    if (!knownProvider) {
      return `sessions_spawn model "${requestedModel}" is not usable: unknown model provider "${resolvedProvider}"`;
    }
  }
  if (params.request.outputSchema && entry && !supportsModelTools(entry)) {
    return `sessions_spawn outputSchema requires a tool-capable target model; "${resolved.ref.provider}/${resolved.ref.model}" declares compat.supportsTools=false.`;
  }
  return undefined;
}

type ResolvedSubagentChildPlan = {
  spawnedCwd?: string;
  toolSpawnMetadata: ReturnType<typeof mapToolContextToSpawnedRunMetadata>;
  spawnedWorkspaceDir?: string;
  requesterOrigin: ReturnType<typeof normalizeDeliveryContext>;
  childSessionOrigin: ReturnType<typeof resolveRequesterOriginForChild>;
  incognito: boolean;
  childSessionKey: string;
  childRuntimeSandboxed: boolean;
  creationPolicy: ReturnType<typeof inheritSessionCreationPolicy>;
  targetAgentDir: string;
  modelPlan: Extract<ReturnType<typeof resolveSubagentModelAndThinkingPlan>, { status: "ok" }>;
  launchAuthorization?: SubagentLaunchAuthorization;
  resolvedModelMetadata: ReturnType<typeof buildResolvedSubagentModelMetadata>;
};

type ResolveSubagentChildPlanResult =
  | { ok: false; result: SpawnSubagentResult }
  | { ok: true; resolved: ResolvedSubagentChildPlan };

export async function resolveSubagentChildPlan(params: {
  request: SpawnSubagentParams;
  ctx: SpawnSubagentContext;
  cfg: OpenClawConfig;
  requesterInternalKey: string;
  requesterAgentId: string;
  targetAgentId: string;
  sandboxMode: "require" | "inherit";
  swarmEnabled: boolean;
}): Promise<ResolveSubagentChildPlanResult> {
  const requestedCwd = normalizeOptionalString(params.request.cwd);
  const spawnedCwd = requestedCwd ? resolveUserPath(requestedCwd) : undefined;
  const toolSpawnMetadata = mapToolContextToSpawnedRunMetadata({
    agentGroupId: params.ctx.agentGroupId,
    agentGroupChannel: params.ctx.agentGroupChannel,
    agentGroupSpace: params.ctx.agentGroupSpace,
    workspaceDir: params.ctx.workspaceDir,
  });
  const inheritedWorkspaceDir =
    params.targetAgentId !== params.requesterAgentId ? undefined : toolSpawnMetadata.workspaceDir;
  const spawnedWorkspaceDir = resolveSpawnedWorkspaceInheritance({
    config: params.cfg,
    targetAgentId: params.targetAgentId,
    explicitWorkspaceDir: inheritedWorkspaceDir,
  });
  const requesterOrigin = normalizeDeliveryContext({
    channel: params.ctx.agentChannel,
    accountId: params.ctx.agentAccountId,
    to: params.ctx.agentTo,
    ...(params.ctx.agentThreadId != null && params.ctx.agentThreadId !== ""
      ? { threadId: params.ctx.agentThreadId }
      : {}),
  });
  const childSessionOrigin = resolveRequesterOriginForChild({
    cfg: params.cfg,
    targetAgentId: params.targetAgentId,
    requesterAgentId: params.requesterAgentId,
    requesterChannel: params.ctx.agentChannel,
    requesterAccountId: params.ctx.agentAccountId,
    requesterTo: params.ctx.agentTo,
    requesterThreadId: params.ctx.agentThreadId,
    requesterGroupSpace: params.ctx.agentGroupSpace,
    requesterMemberRoleIds: params.ctx.agentMemberRoleIds,
  });
  const incognito = isIncognitoSessionKey(params.requesterInternalKey);
  const mintedChildSessionKey = mintSpawnSessionKey({
    targetAgentId: params.targetAgentId,
    backend: "subagent",
  });
  const childSessionKey = incognito
    ? mintedChildSessionKey.replace(":subagent:", ":subagent:incognito-")
    : mintedChildSessionKey;
  const requesterRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.requesterInternalKey,
    agentId: params.requesterAgentId,
  });
  const creationPolicy = inheritSessionCreationPolicy(
    {
      sandbox: requesterRuntime.sandboxRequired ? "required" : undefined,
      createdActor: requesterRuntime.createdActor,
    },
    { type: "agent", id: params.requesterAgentId },
  );
  // A fresh child has no stored row yet; admission must include its inherited isolation.
  const childRuntimeSandboxed =
    creationPolicy.sandbox === "required" ||
    resolveSandboxRuntimeStatus({ cfg: params.cfg, sessionKey: childSessionKey }).sandboxed;
  const sandboxError = resolveSpawnSandboxError({
    backend: "subagent",
    requesterSandboxed: requesterRuntime.sandboxed,
    childSandboxed: childRuntimeSandboxed,
    sandbox: params.sandboxMode,
  });
  if (sandboxError) {
    return { ok: false, result: { status: "forbidden", error: sandboxError } };
  }
  const spawnedWorkspaceCwd = spawnedWorkspaceDir
    ? resolveUserPath(spawnedWorkspaceDir)
    : undefined;
  if (childRuntimeSandboxed && spawnedCwd && spawnedCwd !== spawnedWorkspaceCwd) {
    return {
      ok: false,
      result: {
        status: "forbidden",
        error:
          "cwd override is not supported for sandboxed subagent runs; omit cwd or use the target agent workspace as cwd",
      },
    };
  }
  const targetAgentDir = resolveAgentDir(params.cfg, params.targetAgentId);
  const requesterAgentConfig = resolveAgentConfig(params.cfg, params.requesterAgentId);
  const targetAgentConfig = resolveAgentConfig(params.cfg, params.targetAgentId);
  // The active turn owns inherited effort; saved preferences may already describe
  // a later turn and cannot represent one-shot overrides.
  const callerThinkingRaw =
    params.ctx.requesterThinkingLevel ??
    readRequesterThinkingLevel({
      cfg: params.cfg,
      requesterInternalKey: params.requesterInternalKey,
      requesterAgentId: params.requesterAgentId,
    });
  const inheritedFastMode =
    params.swarmEnabled && params.request.fastMode === undefined
      ? readRequesterFastMode({
          cfg: params.cfg,
          requesterInternalKey: params.requesterInternalKey,
          requesterAgentId: params.requesterAgentId,
        })
      : params.request.fastMode;
  const modelPlan = resolveSubagentModelAndThinkingPlan({
    cfg: params.cfg,
    targetAgentId: params.targetAgentId,
    requesterAgentConfig,
    targetAgentConfig,
    modelOverride: params.request.model,
    thinkingOverrideRaw: params.request.thinking,
    callerThinkingRaw,
    fastMode: inheritedFastMode,
  });
  if (modelPlan.status === "error") {
    return {
      ok: false,
      result: {
        status: "error",
        error: modelPlan.error,
      },
    };
  }
  const { resolvedModel } = modelPlan;
  const modelError = await resolveSpawnModelError({
    cfg: params.cfg,
    targetAgentId: params.targetAgentId,
    targetAgentDir,
    workspaceDir: spawnedWorkspaceDir,
    request: params.request,
    resolvedModel,
  });
  if (modelError) {
    return {
      ok: false,
      result: {
        status: "error",
        error: modelError,
        ...(params.request.outputSchema ? { childSessionKey } : {}),
      },
    };
  }
  const resolvedLaunchModel = splitModelRef(resolvedModel);
  const launchAuthorization: SubagentLaunchAuthorization | undefined =
    params.request.model?.trim() && resolvedLaunchModel.model
      ? {
          modelOverride: {
            ...(resolvedLaunchModel.provider ? { provider: resolvedLaunchModel.provider } : {}),
            model: resolvedLaunchModel.model,
          },
        }
      : undefined;
  return {
    ok: true,
    resolved: {
      spawnedCwd,
      toolSpawnMetadata,
      spawnedWorkspaceDir,
      requesterOrigin,
      childSessionOrigin,
      incognito,
      childSessionKey,
      childRuntimeSandboxed,
      creationPolicy,
      targetAgentDir,
      modelPlan,
      launchAuthorization,
      resolvedModelMetadata: buildResolvedSubagentModelMetadata(resolvedModel),
    },
  };
}
