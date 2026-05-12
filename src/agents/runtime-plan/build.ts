import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { TSchema } from "typebox";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
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
import { resolvePreparedExtraParams } from "../pi-embedded-runner/extra-params.js";
import { classifyEmbeddedPiRunResultForModelFallback } from "../pi-embedded-runner/result-fallback-classifier.js";
import {
  logProviderToolSchemaDiagnostics,
  normalizeProviderToolSchemas,
} from "../pi-embedded-runner/tool-schema-runtime.js";
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

function hasMedia(payload: { mediaUrl?: string; mediaUrls?: string[] }): boolean {
  return resolveSendableOutboundReplyParts(payload).hasMedia;
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

function asThinkLevel(value: BuildAgentRuntimePlanParams["thinkingLevel"]): ThinkLevel | undefined {
  return value !== undefined ? (value as ThinkLevel) : undefined;
}

function isProviderRuntimePluginHandle(
  value: BuildAgentRuntimePlanParams["providerRuntimeHandle"] | ProviderRuntimePluginHandle,
): value is ProviderRuntimePluginHandle {
  return value !== undefined && "plugin" in value;
}

function resolveProviderRuntimeHandleForPlugins(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  runtimeHandle?: BuildAgentRuntimePlanParams["providerRuntimeHandle"];
  resolveWhenMissing?: boolean;
}): ProviderRuntimePluginHandle | undefined {
  if (isProviderRuntimePluginHandle(params.runtimeHandle)) {
    return params.runtimeHandle;
  }
  if (!params.runtimeHandle && !params.resolveWhenMissing) {
    return undefined;
  }
  return resolveProviderRuntimePluginHandle({
    provider: params.runtimeHandle?.provider ?? params.provider,
    config: asOpenClawConfig(params.runtimeHandle?.config) ?? params.config,
    workspaceDir: params.runtimeHandle?.workspaceDir ?? params.workspaceDir,
    env: params.runtimeHandle?.env ?? process.env,
    applyAutoEnable: params.runtimeHandle?.applyAutoEnable,
    bundledProviderAllowlistCompat: params.runtimeHandle?.bundledProviderAllowlistCompat,
    bundledProviderVitestCompat: params.runtimeHandle?.bundledProviderVitestCompat,
  });
}

export function buildAgentRuntimeDeliveryPlan(
  params: BuildAgentRuntimeDeliveryPlanParams,
): AgentRuntimeDeliveryPlan {
  const config = asOpenClawConfig(params.config);
  const providerRuntimeHandle = resolveProviderRuntimeHandleForPlugins({
    provider: params.provider,
    config,
    workspaceDir: params.workspaceDir,
    runtimeHandle: params.providerRuntimeHandle,
  });
  return {
    isSilentPayload(payload): boolean {
      return isSilentReplyPayloadText(payload.text, SILENT_REPLY_TOKEN) && !hasMedia(payload);
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

export function buildAgentRuntimeOutcomePlan(): AgentRuntimeOutcomePlan {
  return {
    classifyRunResult: classifyEmbeddedPiRunResultForModelFallback,
  };
}

export function buildAgentRuntimePlan(params: BuildAgentRuntimePlanParams): AgentRuntimePlan {
  const config = asOpenClawConfig(params.config);
  const model = asProviderRuntimeModel(params.model);
  const modelApi = params.modelApi ?? params.model?.api ?? undefined;
  const transport = params.resolvedTransport;
  const toolPlanningConfig = config ? projectConfigOntoRuntimeSourceSnapshot(config) : undefined;
  let toolPlanningMetadataSnapshot: PluginMetadataSnapshot | undefined;
  const loadToolPlanningMetadataSnapshot = () => {
    toolPlanningMetadataSnapshot ??= loadManifestMetadataSnapshot({
      config: toolPlanningConfig,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      env: process.env,
    });
    return toolPlanningMetadataSnapshot;
  };
  const providerRuntimeHandleForPlugins = resolveProviderRuntimeHandleForPlugins({
    provider: params.provider,
    config,
    workspaceDir: params.workspaceDir,
    runtimeHandle: params.providerRuntimeHandle,
    resolveWhenMissing: true,
  });
  const auth = buildAgentRuntimeAuthPlan({
    provider: params.provider,
    authProfileProvider: params.authProfileProvider,
    authProfileMode: params.authProfileMode,
    sessionAuthProfileId: params.sessionAuthProfileId,
    sessionAuthProfileCandidateIds: params.sessionAuthProfileCandidateIds,
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
      thinkingLevel: asThinkLevel(overrides.thinkingLevel ?? params.thinkingLevel),
      agentId: overrides.agentId ?? params.agentId,
      model: asProviderRuntimeModel(overrides.model) ?? model,
      resolvedTransport: overrides.resolvedTransport ?? transport,
      providerRuntimeHandle: providerRuntimeHandleForPlugins,
    });
  let memoizedTranscriptPolicy: ReturnType<typeof resolveTranscriptRuntimePolicy> | undefined;
  let memoizedTransportExtraParams: ReturnType<typeof resolveTransportExtraParams> | undefined;
  const resolveDefaultTranscriptPolicy = () => {
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
      preparedPlanning: {
        loadMetadataSnapshot: loadToolPlanningMetadataSnapshot,
      },
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
