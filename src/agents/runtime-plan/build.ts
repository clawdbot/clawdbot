import type { AgentTool } from "@mariozechner/pi-agent-core";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { TSchema } from "typebox";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import {
  resolveProviderFollowupFallbackRoute,
  resolveProviderSystemPromptContribution,
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

export function buildAgentRuntimeDeliveryPlan(
  params: BuildAgentRuntimeDeliveryPlanParams,
): AgentRuntimeDeliveryPlan {
  return {
    isSilentPayload(payload): boolean {
      return isSilentReplyPayloadText(payload.text, SILENT_REPLY_TOKEN) && !hasMedia(payload);
    },
    resolveFollowupRoute(routeParams) {
      return resolveProviderFollowupFallbackRoute({
        provider: params.provider,
        config: params.config,
        workspaceDir: params.workspaceDir,
        context: {
          config: params.config,
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
  const modelApi = params.modelApi ?? params.model?.api ?? undefined;
  const transport = params.resolvedTransport;
  const auth = buildAgentRuntimeAuthPlan({
    provider: params.provider,
    authProfileProvider: params.authProfileProvider,
    sessionAuthProfileId: params.sessionAuthProfileId,
    config: params.config,
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
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: process.env,
    modelId: params.modelId,
    modelApi,
    model: params.model,
  };
  const resolveToolContext = (overrides?: {
    workspaceDir?: string;
    modelApi?: string;
    model?: BuildAgentRuntimePlanParams["model"];
  }) => ({
    ...toolContext,
    ...(overrides?.workspaceDir !== undefined ? { workspaceDir: overrides.workspaceDir } : {}),
    ...(overrides?.modelApi !== undefined ? { modelApi: overrides.modelApi } : {}),
    ...(overrides?.model !== undefined ? { model: overrides.model } : {}),
  });
  const resolveTranscriptRuntimePolicy = (overrides?: {
    workspaceDir?: string;
    modelApi?: string;
    model?: BuildAgentRuntimePlanParams["model"];
  }) =>
    resolveTranscriptPolicy({
      provider: params.provider,
      modelId: params.modelId,
      config: params.config,
      workspaceDir: overrides?.workspaceDir ?? params.workspaceDir,
      env: process.env,
      modelApi: overrides?.modelApi ?? modelApi,
      model: overrides?.model ?? params.model,
    });
  const resolveTransportExtraParams = (
    overrides: Parameters<AgentRuntimePlan["transport"]["resolveExtraParams"]>[0] = {},
  ) =>
    resolvePreparedExtraParams({
      cfg: params.config,
      provider: params.provider,
      modelId: params.modelId,
      agentDir: params.agentDir,
      workspaceDir: overrides.workspaceDir ?? params.workspaceDir,
      extraParamsOverride: overrides.extraParamsOverride ?? params.extraParamsOverride,
      thinkingLevel: overrides.thinkingLevel ?? params.thinkingLevel,
      agentId: overrides.agentId ?? params.agentId,
      model: overrides.model ?? params.model,
      resolvedTransport: overrides.resolvedTransport ?? transport,
    });

  return {
    resolvedRef,
    auth,
    prompt: {
      provider: params.provider,
      modelId: params.modelId,
      resolveSystemPromptContribution(context) {
        return resolveProviderSystemPromptContribution({
          provider: params.provider,
          config: params.config,
          workspaceDir: context.workspaceDir ?? params.workspaceDir,
          context,
        });
      },
    },
    tools: {
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
      policy: resolveTranscriptRuntimePolicy(),
      resolvePolicy: resolveTranscriptRuntimePolicy,
    },
    delivery: buildAgentRuntimeDeliveryPlan(params),
    outcome: buildAgentRuntimeOutcomePlan(),
    transport: {
      extraParams: resolveTransportExtraParams(),
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
