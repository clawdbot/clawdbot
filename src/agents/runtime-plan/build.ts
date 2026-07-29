/**
 * Builds prepared runtime plans consumed by embedded agent runs. A plan
 * centralizes provider hooks, auth, tool schema policy, transcript policy,
 * transport params, delivery, and observability for one attempt.
 */
import type { TSchema } from "typebox";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import {
  isPluginMetadataSnapshotCompatible,
  resolvePluginMetadataSnapshot,
} from "../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import {
  resolveProviderRuntimePluginHandle,
  type ProviderRuntimePluginHandle,
} from "../../plugins/provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  resolveProviderFollowupFallbackRoute,
  resolveProviderSystemPromptContribution,
  resolveProviderTextTransforms,
  transformProviderSystemPrompt,
} from "../../plugins/provider-runtime.js";
import { resolvePreparedExtraParams } from "../embedded-agent-runner/extra-params.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "../embedded-agent-runner/result-fallback-classifier.js";
import {
  logProviderToolSchemaDiagnostics,
  normalizeProviderToolSchemas,
} from "../embedded-agent-runner/tool-schema-runtime.js";
import type { AgentTool } from "../runtime/index.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import { buildAgentRuntimeAuthPlan } from "./auth.js";
import type {
  AgentRuntimeDeliveryPlan,
  AgentRuntimeOutcomePlan,
  AgentRuntimePlan,
  BuildAgentRuntimeDeliveryPlanParams,
  BuildAgentRuntimePlanParams,
} from "./types.js";

function formatResolvedRef(params: { provider: string; modelId: string }): string {
  return `${params.provider}/${params.modelId}`;
}

function asOpenClawConfig(value: unknown): OpenClawConfig | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as OpenClawConfig)
    : undefined;
}

function asProviderRuntimeModel(
  value: BuildAgentRuntimePlanParams["model"],
): ProviderRuntimeModel | undefined {
  return value !== undefined ? (value as ProviderRuntimeModel) : undefined;
}

type RuntimePlanMetadataParams = BuildAgentRuntimeDeliveryPlanParams & {
  metadataSnapshot?: BuildAgentRuntimePlanParams["metadataSnapshot"];
};

function resolveCompatibleMetadataSnapshot(
  params: RuntimePlanMetadataParams,
  config: OpenClawConfig | undefined = asOpenClawConfig(params.config),
): PluginMetadataSnapshot | undefined {
  const metadataSnapshot = params.metadataSnapshot as PluginMetadataSnapshot | undefined;
  return metadataSnapshot &&
    metadataSnapshot.pluginIds === undefined &&
    isPluginMetadataSnapshotCompatible({
      snapshot: metadataSnapshot,
      config,
      env: process.env,
      workspaceDir: params.workspaceDir,
    })
    ? metadataSnapshot
    : undefined;
}

function resolvePreparedProviderRuntimeHandle(
  params: RuntimePlanMetadataParams,
): ProviderRuntimePluginHandle & { modelId: string; prepared: true } {
  if (
    params.providerRuntimeHandle?.prepared === true &&
    params.providerRuntimeHandle.provider === params.provider &&
    params.providerRuntimeHandle.modelId === params.modelId &&
    params.providerRuntimeHandle.workspaceDir === params.workspaceDir
  ) {
    return params.providerRuntimeHandle as ProviderRuntimePluginHandle & {
      modelId: string;
      prepared: true;
    };
  }
  const compatibleMetadataSnapshot = resolveCompatibleMetadataSnapshot(params);
  return {
    ...resolveProviderRuntimePluginHandle({
      provider: params.provider,
      modelId: params.modelId,
      config: asOpenClawConfig(params.config),
      workspaceDir: params.workspaceDir,
      env: process.env,
      ...(compatibleMetadataSnapshot ? { pluginMetadataSnapshot: compatibleMetadataSnapshot } : {}),
    }),
    modelId: params.modelId,
    prepared: true,
  };
}

/** Build delivery-specific runtime decisions for one provider/model. */
export function buildAgentRuntimeDeliveryPlan(
  params: BuildAgentRuntimeDeliveryPlanParams,
): AgentRuntimeDeliveryPlan {
  const config = asOpenClawConfig(params.config);
  const providerRuntimeHandle = resolvePreparedProviderRuntimeHandle(params);
  return {
    isSilentPayload(payload): boolean {
      return (
        isSilentReplyPayloadText(payload.text, SILENT_REPLY_TOKEN) &&
        !hasReplyPayloadContent({ ...payload, text: undefined }, { trimText: true })
      );
    },
    resolveFollowupRoute(routeParams) {
      return resolveProviderFollowupFallbackRoute({
        provider: params.provider,
        config,
        workspaceDir: params.workspaceDir,
        runtimeHandle: providerRuntimeHandle,
        context: {
          config,
          agentDir: params.agentDir,
          workspaceDir: params.workspaceDir,
          provider: params.provider,
          modelId: params.modelId,
          payload: routeParams.payload,
          originatingChannel: routeParams.originatingChannel,
          originatingTo: routeParams.originatingTo,
          originRoutable: routeParams.originRoutable,
          dispatcherAvailable: routeParams.dispatcherAvailable,
        },
      });
    },
  };
}

/** Build run-outcome classification hooks for model fallback decisions. */
function buildAgentRuntimeOutcomePlan(): AgentRuntimeOutcomePlan {
  return {
    classifyRunResult: classifyEmbeddedAgentRunResultForModelFallback,
  };
}

/** Build the complete runtime plan for an embedded agent attempt. */
export function buildAgentRuntimePlan(params: BuildAgentRuntimePlanParams): AgentRuntimePlan {
  const config = asOpenClawConfig(params.config);
  const model = asProviderRuntimeModel(params.model);
  const modelApi = params.modelApi ?? params.model?.api ?? undefined;
  const transport = params.resolvedTransport;
  const toolPlanningConfig = config ? projectConfigOntoRuntimeSourceSnapshot(config) : undefined;
  const toolPlanningMetadataSnapshot = resolveCompatibleMetadataSnapshot(
    params,
    toolPlanningConfig,
  );
  const preparedPlanning = toolPlanningMetadataSnapshot
    ? { metadataSnapshot: toolPlanningMetadataSnapshot }
    : {
        loadMetadataSnapshot: () =>
          resolvePluginMetadataSnapshot({
            config: toolPlanningConfig,
            ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
            env: process.env,
          }),
      };
  const providerRuntimeHandleForPlugins = resolvePreparedProviderRuntimeHandle(params);
  const auth =
    params.preparedAuthPlan ??
    buildAgentRuntimeAuthPlan({
      provider: params.provider,
      modelId: params.modelId,
      authProfileProvider: params.authProfileProvider,
      authProfileMode: params.authProfileMode,
      sessionAuthProfileId: params.sessionAuthProfileId,
      sessionAuthProfileSource: params.sessionAuthProfileSource,
      sessionAuthProfileCandidateIds: params.sessionAuthProfileCandidateIds,
      modelRoute: params.modelRoute,
      config,
      workspaceDir: params.workspaceDir,
      harnessId: params.harnessId,
      harnessRuntime: params.harnessRuntime,
      allowHarnessAuthProfileForwarding: params.allowHarnessAuthProfileForwarding,
    });
  const resolvedRef = {
    provider: params.provider,
    modelId: params.modelId,
    ...(modelApi ? { modelApi } : {}),
    ...(params.harnessId ? { harnessId: params.harnessId } : {}),
    ...(transport ? { transport } : {}),
  };
  const toolContext = {
    provider: params.provider,
    config,
    workspaceDir: params.workspaceDir,
    env: process.env,
    runtimeHandle: providerRuntimeHandleForPlugins,
    modelId: params.modelId,
    modelApi,
    model,
  };
  const resolveToolContext = (overrides?: {
    workspaceDir?: string;
    modelApi?: string;
    model?: BuildAgentRuntimePlanParams["model"];
  }) => ({
    ...toolContext,
    ...(overrides?.workspaceDir !== undefined ? { workspaceDir: overrides.workspaceDir } : {}),
    ...(overrides?.modelApi !== undefined ? { modelApi: overrides.modelApi } : {}),
    ...(overrides?.model !== undefined ? { model: asProviderRuntimeModel(overrides.model) } : {}),
  });
  const resolveTranscriptRuntimePolicy = (overrides?: {
    workspaceDir?: string;
    modelApi?: string;
    model?: BuildAgentRuntimePlanParams["model"];
  }) =>
    resolveTranscriptPolicy({
      provider: params.provider,
      modelId: params.modelId,
      config,
      workspaceDir: overrides?.workspaceDir ?? params.workspaceDir,
      env: process.env,
      runtimeHandle: providerRuntimeHandleForPlugins,
      modelApi: overrides?.modelApi ?? modelApi,
      model: asProviderRuntimeModel(overrides?.model) ?? model,
    });
  const resolveTransportExtraParams = (
    overrides: Parameters<AgentRuntimePlan["transport"]["resolveExtraParams"]>[0] = {},
  ) =>
    resolvePreparedExtraParams({
      cfg: config,
      provider: params.provider,
      modelId: params.modelId,
      agentDir: params.agentDir,
      workspaceDir: overrides.workspaceDir ?? params.workspaceDir,
      extraParamsOverride: overrides.extraParamsOverride ?? params.extraParamsOverride,
      thinkingLevel: overrides.thinkingLevel ?? params.thinkingLevel,
      agentId: overrides.agentId ?? params.agentId,
      model: asProviderRuntimeModel(overrides.model) ?? model,
      resolvedTransport: overrides.resolvedTransport ?? transport,
      providerRuntimeHandle: providerRuntimeHandleForPlugins,
    });
  let memoizedTranscriptPolicy: ReturnType<typeof resolveTranscriptRuntimePolicy> | undefined;
  let memoizedTransportExtraParams: ReturnType<typeof resolveTransportExtraParams> | undefined;
  const resolveDefaultTranscriptPolicy = () => {
    // Default getters are memoized, while override resolvers remain fresh for
    // callers that intentionally vary workspace/model details.
    memoizedTranscriptPolicy ??= resolveTranscriptRuntimePolicy();
    return memoizedTranscriptPolicy;
  };
  const resolveDefaultTransportExtraParams = () => {
    memoizedTransportExtraParams ??= resolveTransportExtraParams();
    return memoizedTransportExtraParams;
  };
  const providerTextTransforms = resolveProviderTextTransforms({
    provider: params.provider,
    config,
    workspaceDir: params.workspaceDir,
    env: process.env,
    runtimeHandle: providerRuntimeHandleForPlugins,
  });

  return {
    resolvedRef,
    providerRuntimeHandle: providerRuntimeHandleForPlugins,
    auth,
    prompt: {
      provider: params.provider,
      modelId: params.modelId,
      textTransforms: providerTextTransforms,
      resolveSystemPromptContribution(context) {
        return resolveProviderSystemPromptContribution({
          provider: params.provider,
          config,
          workspaceDir: context.workspaceDir ?? params.workspaceDir,
          runtimeHandle: providerRuntimeHandleForPlugins,
          context: {
            ...context,
            config: asOpenClawConfig(context.config),
          },
        });
      },
      transformSystemPrompt(context) {
        return transformProviderSystemPrompt({
          provider: params.provider,
          config,
          workspaceDir: context.workspaceDir ?? params.workspaceDir,
          runtimeHandle: providerRuntimeHandleForPlugins,
          context: {
            ...context,
            config: asOpenClawConfig(context.config),
          },
        });
      },
    },
    tools: {
      preparedPlanning,
      normalize<TSchemaType extends TSchema = TSchema, TResult = unknown>(
        tools: AgentTool<TSchemaType, TResult>[],
        overrides?: {
          workspaceDir?: string;
          modelApi?: string;
          model?: BuildAgentRuntimePlanParams["model"];
        },
      ): AgentTool<TSchemaType, TResult>[] {
        return normalizeProviderToolSchemas({
          ...resolveToolContext(overrides),
          tools,
        });
      },
      logDiagnostics(
        tools: AgentTool[],
        overrides?: {
          workspaceDir?: string;
          modelApi?: string;
          model?: BuildAgentRuntimePlanParams["model"];
        },
      ): void {
        logProviderToolSchemaDiagnostics({
          ...resolveToolContext(overrides),
          tools,
        });
      },
    },
    transcript: {
      get policy() {
        return resolveDefaultTranscriptPolicy();
      },
      resolvePolicy: resolveTranscriptRuntimePolicy,
    },
    delivery: buildAgentRuntimeDeliveryPlan({
      ...params,
      providerRuntimeHandle: providerRuntimeHandleForPlugins,
    }),
    outcome: buildAgentRuntimeOutcomePlan(),
    transport: {
      get extraParams() {
        return resolveDefaultTransportExtraParams();
      },
      resolveExtraParams: resolveTransportExtraParams,
    },
    observability: {
      resolvedRef: formatResolvedRef({
        provider: params.provider,
        modelId: params.modelId,
      }),
      provider: params.provider,
      modelId: params.modelId,
      ...(modelApi ? { modelApi } : {}),
      ...(params.harnessId ? { harnessId: params.harnessId } : {}),
      ...(auth.forwardedAuthProfileId ? { authProfileId: auth.forwardedAuthProfileId } : {}),
      ...(transport ? { transport } : {}),
    },
  };
}
