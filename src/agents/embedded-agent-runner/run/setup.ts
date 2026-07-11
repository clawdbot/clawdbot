/**
 * Resolves hook-selected model state and pre-model attachments for a run.
 */
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import type {
  PluginHookBeforeAgentStartResult,
  PluginHookBeforeModelResolveAttachment,
  PluginHookBeforeModelResolveEvent,
} from "../../../plugins/types.js";
import {
  AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
  isValidAgentHarnessSessionStoreEntry,
  resolveAgentHarnessSessionStoreEntryError,
} from "../../../sessions/agent-harness-session-key.js";
import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
  OPENCLAW_AGENT_RUNTIME_ID,
} from "../../agent-runtime-id.js";
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

/** Durable harness sessions run only with their exact persisted identity and runtime lock. */
export function resolveAgentHarnessRunAdmissionError(params: {
  agentHarnessId?: string;
  entry?: SessionEntry;
  modelSelectionLocked?: boolean;
  sessionId: string;
  sessionKey?: string;
}): string | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const entry = params.entry;
  const reservedKey = isAgentHarnessSessionKey(sessionKey);
  if (!entry) {
    return reservedKey ? AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE : undefined;
  }
  // Rows created before harness supervision could already use this prefix. Only the
  // durable lock makes an existing row harness-owned; missing reserved keys stay closed.
  if (entry.modelSelectionLocked !== true) {
    return undefined;
  }
  const durableEntryError = resolveAgentHarnessSessionStoreEntryError(sessionKey, entry);
  if (durableEntryError) {
    return durableEntryError;
  }
  if (!isValidAgentHarnessSessionStoreEntry(sessionKey, entry)) {
    return undefined;
  }
  const requestedHarnessId = normalizeOptionalAgentRuntimeId(params.agentHarnessId);
  const durableHarnessId = normalizeOptionalAgentRuntimeId(entry.agentHarnessId);
  const matchesRequestedRuntime =
    params.modelSelectionLocked === true && requestedHarnessId === durableHarnessId;
  const matchesDurableRuntime =
    entry.sessionId === params.sessionId && durableHarnessId !== undefined;
  return matchesRequestedRuntime && matchesDurableRuntime
    ? undefined
    : reservedKey
      ? AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE
      : AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE;
}

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

/** Resolves a pinned non-default harness that owns native model selection. */
export function resolveNativeModelOwnedHarnessId(params: {
  agentHarnessId?: string;
  modelSelectionLocked?: boolean;
  selectedHarnessId: string;
}): string | undefined {
  if (params.modelSelectionLocked !== true) {
    return undefined;
  }
  const requestedHarnessId = normalizeOptionalAgentRuntimeId(params.agentHarnessId);
  const selectedHarnessId = normalizeOptionalAgentRuntimeId(params.selectedHarnessId);
  if (
    !requestedHarnessId ||
    isDefaultAgentRuntimeId(requestedHarnessId) ||
    requestedHarnessId === OPENCLAW_AGENT_RUNTIME_ID ||
    requestedHarnessId !== selectedHarnessId
  ) {
    return undefined;
  }
  return requestedHarnessId;
}

/** Builds structural model metadata for a harness that resolves its real model natively. */
export function createNativeModelOwnedRuntimeModel(params: {
  provider: string;
  modelId: string;
}): ProviderRuntimeModel {
  return {
    provider: params.provider,
    id: params.modelId,
    name: params.modelId,
    baseUrl: "",
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: DEFAULT_CONTEXT_TOKENS,
  };
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

/** Resolves only OpenClaw-owned context policy; native model owners keep that policy private. */
export function resolveEmbeddedRuntimeModelPolicy(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  contextConfigProvider?: string;
  modelId: string;
  runtimeModel: ProviderRuntimeModel;
  nativeModelOwned: boolean;
}): {
  contextWindowInfo?: ContextWindowInfo;
  contextTokenBudget?: number;
  effectiveModel: ProviderRuntimeModel;
} {
  if (params.nativeModelOwned) {
    return { effectiveModel: params.runtimeModel };
  }
  const resolved = resolveEffectiveRuntimeModel(params);
  return {
    contextWindowInfo: resolved.ctxInfo,
    contextTokenBudget: resolved.ctxInfo.tokens,
    effectiveModel: resolved.effectiveModel,
  };
}
