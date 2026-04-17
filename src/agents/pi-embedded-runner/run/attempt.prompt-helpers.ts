import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type {
  ContextEnginePromptCacheInfo,
  ContextEngineRuntimeContext,
} from "../../../context-engine/types.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforePromptBuildResult,
} from "../../../plugins/types.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../../routing/session-key.js";
import { joinPresentTextSegments } from "../../../shared/text/join-segments.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../../heartbeat-system-prompt.js";
import { buildActiveMusicGenerationTaskPromptContextForSession } from "../../music-generation-task-status.js";
import { prependSystemPromptAdditionAfterCacheBoundary } from "../../system-prompt-cache-boundary.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../../tool-fs-policy.js";
import { derivePromptTokens, type NormalizedUsage } from "../../usage.js";
import { buildActiveVideoGenerationTaskPromptContextForSession } from "../../video-generation-task-status.js";
import { buildEmbeddedCompactionRuntimeContext } from "../compaction-runtime-context.js";
import { log } from "../logger.js";
import { shouldInjectHeartbeatPromptForTrigger } from "./trigger-policy.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export type PromptBuildHookRunner = {
  hasHooks: (hookName: "before_prompt_build" | "before_agent_start") => boolean;
  runBeforePromptBuild: (
    event: { prompt: string; messages: unknown[] },
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforePromptBuildResult | undefined>;
  runBeforeAgentStart: (
    event: { prompt: string; messages: unknown[] },
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforeAgentStartResult | undefined>;
};

export async function resolvePromptBuildHookResult(params: {
  prompt: string;
  messages: unknown[];
  hookCtx: PluginHookAgentContext;
  hookRunner?: PromptBuildHookRunner | null;
  legacyBeforeAgentStartResult?: PluginHookBeforeAgentStartResult;
}): Promise<PluginHookBeforePromptBuildResult> {
  const promptBuildResult = params.hookRunner?.hasHooks("before_prompt_build")
    ? await params.hookRunner
        .runBeforePromptBuild(
          {
            prompt: params.prompt,
            messages: params.messages,
          },
          params.hookCtx,
        )
        .catch((hookErr: unknown) => {
          log.warn(`before_prompt_build hook failed: ${String(hookErr)}`);
          return undefined;
        })
    : undefined;
  const legacyResult =
    params.legacyBeforeAgentStartResult ??
    (params.hookRunner?.hasHooks("before_agent_start")
      ? await params.hookRunner
          .runBeforeAgentStart(
            {
              prompt: params.prompt,
              messages: params.messages,
            },
            params.hookCtx,
          )
          .catch((hookErr: unknown) => {
            log.warn(
              `before_agent_start hook (legacy prompt build path) failed: ${String(hookErr)}`,
            );
            return undefined;
          })
      : undefined);
  return {
    systemPrompt: promptBuildResult?.systemPrompt ?? legacyResult?.systemPrompt,
    prependContext: joinPresentTextSegments([
      promptBuildResult?.prependContext,
      legacyResult?.prependContext,
    ]),
    prependSystemContext: joinPresentTextSegments([
      promptBuildResult?.prependSystemContext,
      legacyResult?.prependSystemContext,
    ]),
    appendSystemContext: joinPresentTextSegments([
      promptBuildResult?.appendSystemContext,
      legacyResult?.appendSystemContext,
    ]),
  };
}

export function resolvePromptModeForSession(sessionKey?: string): "minimal" | "full" {
  if (!sessionKey) {
    return "full";
  }
  return isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey) ? "minimal" : "full";
}

export function shouldInjectHeartbeatPrompt(params: {
  config?: OpenClawConfig;
  agentId?: string;
  defaultAgentId?: string;
  isDefaultAgent: boolean;
  trigger?: EmbeddedRunAttemptParams["trigger"];
}): boolean {
  return (
    params.isDefaultAgent &&
    shouldInjectHeartbeatPromptForTrigger(params.trigger) &&
    Boolean(
      resolveHeartbeatPromptForSystemPrompt({
        config: params.config,
        agentId: params.agentId,
        defaultAgentId: params.defaultAgentId,
      }),
    )
  );
}

export function shouldWarnOnOrphanedUserRepair(
  trigger: EmbeddedRunAttemptParams["trigger"],
): boolean {
  return trigger === "user" || trigger === "manual";
}

function extractUserMessagePlainText(content: unknown): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((part) =>
      part && typeof part === "object" && "type" in part && part.type === "text"
        ? [typeof part.text === "string" ? part.text : ""]
        : [],
    )
    .join("\n")
    .trim();
  return text || undefined;
}

export function mergeOrphanedTrailingUserPrompt(params: {
  prompt: string;
  trigger: EmbeddedRunAttemptParams["trigger"];
  leafMessage: { content?: unknown };
}): { prompt: string; merged: boolean } {
  if (!shouldWarnOnOrphanedUserRepair(params.trigger)) {
    return { prompt: params.prompt, merged: false };
  }

  const orphanText = extractUserMessagePlainText(params.leafMessage.content);
  if (!orphanText || orphanText.length < 4 || params.prompt.includes(orphanText)) {
    return { prompt: params.prompt, merged: false };
  }

  return {
    prompt: [
      "[Queued user message that arrived while the previous turn was still active]",
      orphanText,
      "",
      params.prompt,
    ].join("\n"),
    merged: true,
  };
}

export function resolveAttemptFsWorkspaceOnly(params: {
  config?: OpenClawConfig;
  sessionAgentId: string;
}): boolean {
  return resolveEffectiveToolFsWorkspaceOnly({
    cfg: params.config,
    agentId: params.sessionAgentId,
  });
}

export function prependSystemPromptAddition(params: {
  systemPrompt: string;
  systemPromptAddition?: string;
}): string {
  return prependSystemPromptAdditionAfterCacheBoundary(params);
}

export function resolveAttemptPrependSystemContext(params: {
  sessionKey?: string;
  trigger?: EmbeddedRunAttemptParams["trigger"];
  hookPrependSystemContext?: string;
}): string | undefined {
  const activeMediaTaskPromptContexts =
    params.trigger === "user" || params.trigger === "manual"
      ? [
          buildActiveVideoGenerationTaskPromptContextForSession(params.sessionKey),
          buildActiveMusicGenerationTaskPromptContextForSession(params.sessionKey),
        ]
      : [];
  return joinPresentTextSegments([
    ...activeMediaTaskPromptContexts,
    params.hookPrependSystemContext,
  ]);
}

/** Build runtime context passed into context-engine afterTurn hooks. */
export function buildAfterTurnRuntimeContext(params: {
  attempt: Pick<
    EmbeddedRunAttemptParams,
    | "sessionKey"
    | "messageChannel"
    | "messageProvider"
    | "agentAccountId"
    | "currentChannelId"
    | "currentThreadTs"
    | "currentMessageId"
    | "config"
    | "skillsSnapshot"
    | "senderIsOwner"
    | "senderId"
    | "provider"
    | "modelId"
    | "thinkLevel"
    | "reasoningLevel"
    | "bashElevated"
    | "extraSystemPrompt"
    | "ownerNumbers"
    | "authProfileId"
  >;
  workspaceDir: string;
  agentDir: string;
  tokenBudget?: number;
  currentTokenCount?: number;
  promptCache?: ContextEnginePromptCacheInfo;
}): ContextEngineRuntimeContext {
  return {
    ...buildEmbeddedCompactionRuntimeContext({
      sessionKey: params.attempt.sessionKey,
      messageChannel: params.attempt.messageChannel,
      messageProvider: params.attempt.messageProvider,
      agentAccountId: params.attempt.agentAccountId,
      currentChannelId: params.attempt.currentChannelId,
      currentThreadTs: params.attempt.currentThreadTs,
      currentMessageId: params.attempt.currentMessageId,
      authProfileId: params.attempt.authProfileId,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      config: params.attempt.config,
      skillsSnapshot: params.attempt.skillsSnapshot,
      senderIsOwner: params.attempt.senderIsOwner,
      senderId: params.attempt.senderId,
      provider: params.attempt.provider,
      modelId: params.attempt.modelId,
      thinkLevel: params.attempt.thinkLevel,
      reasoningLevel: params.attempt.reasoningLevel,
      bashElevated: params.attempt.bashElevated,
      extraSystemPrompt: params.attempt.extraSystemPrompt,
      ownerNumbers: params.attempt.ownerNumbers,
    }),
    ...(typeof params.tokenBudget === "number" &&
    Number.isFinite(params.tokenBudget) &&
    params.tokenBudget > 0
      ? { tokenBudget: Math.floor(params.tokenBudget) }
      : {}),
    ...(typeof params.currentTokenCount === "number" &&
    Number.isFinite(params.currentTokenCount) &&
    params.currentTokenCount > 0
      ? { currentTokenCount: Math.floor(params.currentTokenCount) }
      : {}),
    ...(params.promptCache ? { promptCache: params.promptCache } : {}),
  };
}

export function buildAfterTurnRuntimeContextFromUsage(
  params: Omit<Parameters<typeof buildAfterTurnRuntimeContext>[0], "currentTokenCount"> & {
    lastCallUsage?: NormalizedUsage;
  },
): ContextEngineRuntimeContext {
  return buildAfterTurnRuntimeContext({
    ...params,
    currentTokenCount: derivePromptTokens(params.lastCallUsage),
  });
}
