/**
 * Resolves hook-selected model state and pre-model attachments for a run.
 */
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import type {
  PluginHookBeforeAgentStartResult,
  PluginHookBeforeModelResolveAttachment,
  PluginHookBeforeModelResolveEvent,
} from "../../../plugins/types.js";
import {
  evaluateContextWindowGuard,
  formatContextWindowBlockMessage,
  formatContextWindowWarningMessage,
  resolveContextWindowInfo,
  type ContextWindowInfo,
} from "../../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { FailoverError } from "../../failover-error.js";
import { log } from "../logger.js";
import { readAgentModelContextTokens } from "../model-context-tokens.js";

type HookContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId: string;
  workspaceDir: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
};

type HookRunnerLike = {
  hasHooks(hookName: string): boolean;
  runBeforeModelResolve(
    input: PluginHookBeforeModelResolveEvent,
    context: HookContext,
  ): Promise<{ providerOverride?: string; modelOverride?: string } | undefined>;
  runBeforeAgentStart(
    input: { prompt: string },
    context: HookContext,
  ): Promise<PluginHookBeforeAgentStartResult | undefined>;
};

/**
 * Runs model-selection hooks before resolving the runtime model. The dedicated
 * `before_model_resolve` hook wins over legacy `before_agent_start` overrides
 * when both provide provider/model changes.
 */
export async function resolveHookModelSelection(params: {
  prompt: string;
  attachments?: PluginHookBeforeModelResolveAttachment[];
  provider: string;
  modelId: string;
  hookRunner?: HookRunnerLike | null;
  hookContext: HookContext;
}) {
  let provider = params.provider;
  let modelId = params.modelId;
  let modelResolveOverride: { providerOverride?: string; modelOverride?: string } | undefined;
  let beforeAgentStartResult: PluginHookBeforeAgentStartResult | undefined;
  const hookRunner = params.hookRunner;

  // Run before_model_resolve hooks early so plugins can override the
  // provider/model before resolveModel().
  //
  // Legacy compatibility: before_agent_start is also checked for override
  // fields if present. New hook takes precedence when both are set.
  if (hookRunner?.hasHooks("before_model_resolve")) {
    try {
      const event: PluginHookBeforeModelResolveEvent = params.attachments
        ? { prompt: params.prompt, attachments: params.attachments }
        : { prompt: params.prompt };
      modelResolveOverride = await hookRunner.runBeforeModelResolve(event, params.hookContext);
    } catch (hookErr) {
      log.warn(`before_model_resolve hook failed: ${String(hookErr)}`);
    }
  }

  if (hookRunner?.hasHooks("before_agent_start")) {
    try {
      beforeAgentStartResult = await hookRunner.runBeforeAgentStart(
        { prompt: params.prompt },
        params.hookContext,
      );
      modelResolveOverride = {
        providerOverride:
          modelResolveOverride?.providerOverride ?? beforeAgentStartResult?.providerOverride,
        modelOverride: modelResolveOverride?.modelOverride ?? beforeAgentStartResult?.modelOverride,
      };
    } catch (hookErr) {
      log.warn(
        `deprecated before_agent_start hook failed during model resolve: ${String(hookErr)}`,
      );
    }
  }

  if (modelResolveOverride?.providerOverride) {
    provider = modelResolveOverride.providerOverride;
    log.info(`[hooks] provider overridden to ${provider}`);
  }
  if (modelResolveOverride?.modelOverride) {
    modelId = modelResolveOverride.modelOverride;
    log.info(`[hooks] model overridden to ${modelId}`);
  }

  return {
    provider,
    modelId,
    beforeAgentStartResult,
  };
}

/**
 * Converts prompt image refs into the minimal attachment shape exposed to
 * before-model-resolve hooks. Empty image lists stay undefined so hook payloads
 * do not grow a meaningless attachments field.
 */
export function buildBeforeModelResolveAttachments(
  images: readonly { mimeType?: string }[] | undefined,
): PluginHookBeforeModelResolveAttachment[] | undefined {
  if (!images?.length) {
    return undefined;
  }
  return images.map((img) => ({
    kind: "image",
    mimeType: img.mimeType,
  }));
}

/**
 * Resolves context-window policy for the selected runtime model and returns the
 * model shape the session runtime should see. Configured context caps are
 * reflected in `effectiveModel.contextWindow` so auto-compaction uses the same
 * limit as the guard.
 */
export function resolveEffectiveRuntimeModel(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  contextConfigProvider?: string;
  modelId: string;
  runtimeModel: ProviderRuntimeModel;
}): {
  ctxInfo: ContextWindowInfo;
  effectiveModel: ProviderRuntimeModel;
} {
  const ctxInfo = resolveContextWindowInfo({
    cfg: params.cfg,
    provider: params.contextConfigProvider ?? params.provider,
    modelId: params.modelId,
    modelContextTokens: readAgentModelContextTokens(params.runtimeModel),
    modelContextWindow: params.runtimeModel.contextWindow,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  });

  // Apply contextTokens cap to model so session runtime's auto-compaction
  // threshold uses the effective limit, not the native context window.
  const effectiveModel =
    ctxInfo.tokens < (params.runtimeModel.contextWindow ?? Infinity)
      ? { ...params.runtimeModel, contextWindow: ctxInfo.tokens }
      : params.runtimeModel;
  const ctxGuard = evaluateContextWindowGuard({ info: ctxInfo });
  const runtimeBaseUrl =
    typeof (params.runtimeModel as { baseUrl?: unknown }).baseUrl === "string"
      ? (params.runtimeModel as { baseUrl: string }).baseUrl
      : undefined;
  if (ctxGuard.shouldWarn) {
    log.warn(
      formatContextWindowWarningMessage({
        provider: params.provider,
        modelId: params.modelId,
        guard: ctxGuard,
        runtimeBaseUrl,
      }),
    );
  }
  if (ctxGuard.shouldBlock) {
    const message = formatContextWindowBlockMessage({
      guard: ctxGuard,
      runtimeBaseUrl,
    });
    log.error(
      `blocked model (context window too small): ${params.provider}/${params.modelId} ctx=${ctxGuard.tokens} (min=${ctxGuard.hardMinTokens}) source=${ctxGuard.source}; ${message}`,
    );
    throw new FailoverError(message, {
      reason: "unknown",
      provider: params.provider,
      model: params.modelId,
    });
  }

  return {
    ctxInfo,
    effectiveModel,
  };
}
