import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import { resolveUserPath } from "../../../utils.js";
import { resolveAgentDir } from "../../agent-scope-config.js";
import { findModelCatalogEntry } from "../../model-catalog-lookup.js";
import { resolveDefaultModelForAgent } from "../../model-selection.js";
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
  loadPreparedModelCatalog,
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

async function resolveCollectorOutputModelError(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  targetAgentDir: string;
  workspaceDir?: string;
  resolvedModel?: string;
}): Promise<string | undefined> {
  const selected = splitModelRef(params.resolvedModel);
  const fallback = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.targetAgentId,
  });
  const provider = selected.provider ?? fallback.provider;
  const model = selected.model ?? fallback.model;
  if (!provider || !model) {
    return undefined;
  }
  let catalog: Awaited<ReturnType<typeof loadPreparedModelCatalog>>;
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
    return `sessions_spawn could not verify outputSchema model capabilities: ${summarizeSpawnError(error)}`;
  }
  const entry = findModelCatalogEntry(catalog, { provider, modelId: model });
  if (!entry || supportsModelTools(entry)) {
    return undefined;
  }
  return `sessions_spawn outputSchema requires a tool-capable target model; "${provider}/${model}" declares compat.supportsTools=false.`;
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
  });
  const childRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: childSessionKey,
  });
  const sandboxError = resolveSpawnSandboxError({
    backend: "subagent",
    requesterSandboxed: requesterRuntime.sandboxed,
    childSandboxed: childRuntime.sandboxed,
    sandbox: params.sandboxMode,
  });
  if (sandboxError) {
    return { ok: false, result: { status: "forbidden", error: sandboxError } };
  }
  const spawnedWorkspaceCwd = spawnedWorkspaceDir
    ? resolveUserPath(spawnedWorkspaceDir)
    : undefined;
  if (childRuntime.sandboxed && spawnedCwd && spawnedCwd !== spawnedWorkspaceCwd) {
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
  const callerThinkingRaw = readRequesterThinkingLevel({
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
  if (params.request.outputSchema) {
    const outputModelError = await resolveCollectorOutputModelError({
      cfg: params.cfg,
      targetAgentId: params.targetAgentId,
      targetAgentDir,
      workspaceDir: spawnedWorkspaceDir,
      resolvedModel,
    });
    if (outputModelError) {
      return {
        ok: false,
        result: { status: "error", error: outputModelError, childSessionKey },
      };
    }
  }
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
      childRuntimeSandboxed: childRuntime.sandboxed,
      targetAgentDir,
      modelPlan,
      launchAuthorization,
      resolvedModelMetadata: buildResolvedSubagentModelMetadata(resolvedModel),
    },
  };
}
